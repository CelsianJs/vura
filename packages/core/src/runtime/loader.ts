/**
 * Vura Loaders — server-side data fetching for pages (RFC 0001).
 *
 * A page or layout exports `loader`, an async function that runs on the server
 * before render and returns plain JSON-serializable data. The component reads it
 * with `useLoaderData<typeof loader>()`.
 *
 * The design is forced by one fact: What Framework's `renderToString` is
 * synchronous. There is no per-component `await`, so every fetch has to happen
 * in a phase *before* the render rather than inside the component tree. That is
 * the whole reason this is route-level rather than component-level. See
 * docs/rfcs/0001-ssr-data-fetching.md.
 *
 * Scoping is What's own tree-scoped context, one provider per matched segment,
 * so a component nested three levels inside a page still reads that page's
 * loader data, and a sibling inside the layout reads the layout's. Verified to
 * work through `renderToString`, not assumed.
 */

import { createContext, useContext } from 'what-framework';

// ─── Control flow ───

/**
 * Thrown by `ctx.notFound()`. The page runtime turns it into a 404 instead of
 * a 500, which is the difference between "this URL has no post" and "this
 * server is broken".
 */
export class LoaderNotFoundError extends Error {
  readonly isLoaderNotFound = true as const;
  constructor(message = 'Not Found') {
    super(message);
    this.name = 'LoaderNotFoundError';
  }
}

/** Thrown by `ctx.redirect()`. Carries the Location and status to emit. */
export class LoaderRedirectError extends Error {
  readonly isLoaderRedirect = true as const;
  readonly location: string;
  readonly status: number;
  constructor(location: string, status = 302) {
    super(`Redirect to ${location}`);
    this.name = 'LoaderRedirectError';
    this.location = location;
    this.status = status;
  }
}

/**
 * Instanceof is unreliable across bundle boundaries: Vura bundles its server
 * entry and each route separately, so a loader that throws from one bundle can
 * be caught by a copy of this class from another. That exact shape is what made
 * what-framework's revalidation registry silently no-op (fixed in 0.13.2), so
 * these checks are structural on purpose.
 */
export function isLoaderNotFound(err: unknown): err is LoaderNotFoundError {
  return typeof err === 'object' && err !== null && (err as LoaderNotFoundError).isLoaderNotFound === true;
}

export function isLoaderRedirect(err: unknown): err is LoaderRedirectError {
  return typeof err === 'object' && err !== null && (err as LoaderRedirectError).isLoaderRedirect === true;
}

// ─── Context passed to a loader ───

/**
 * What a `loader` receives. `notFound()` and `redirect()` return the error so
 * that `throw ctx.notFound()` reads naturally and TypeScript sees the throw.
 */
export interface LoaderContext {
  /** Matched dynamic segments, e.g. `{ id: '42' }` for `/posts/[id]`. */
  params: Record<string, string>;
  /** The request pathname, e.g. `/posts/42`. */
  url: string;
  /** Parsed query string. Repeated keys arrive as arrays. */
  query: Record<string, string | string[]>;
  /**
   * The WinterCG Request, for headers and cookies.
   *
   * Absent at build time: a `static` page's loader runs during `vura build`,
   * where there is no request. Guard before reading it, or the page will fail
   * the build rather than the request.
   */
  request?: Request;
  /** Throw to render 404: `throw ctx.notFound()`. */
  notFound: (message?: string) => LoaderNotFoundError;
  /** Throw to redirect: `throw ctx.redirect('/login')`. */
  redirect: (to: string, status?: number) => LoaderRedirectError;
}

/** A page or layout module's `loader` export. */
export type Loader<T = unknown> = (ctx: LoaderContext) => T | Promise<T>;

/** The data a loader resolves to, for `useLoaderData<typeof loader>()`. */
export type LoaderData<L> = L extends (ctx: never) => infer R ? Awaited<R> : never;

export function createLoaderContext(input: {
  params: Record<string, string>;
  url: string;
  query: Record<string, string | string[]>;
  request?: Request;
}): LoaderContext {
  return {
    params: input.params,
    url: input.url,
    query: input.query,
    ...(input.request ? { request: input.request } : {}),
    notFound: (message?: string) => new LoaderNotFoundError(message),
    redirect: (to: string, status = 302) => new LoaderRedirectError(to, status),
  };
}

// ─── Reading loader data from a component ───

// Symbol.for, not Symbol: registered in the global symbol registry so every
// copy of this module agrees on the same sentinel. See the note below.
const LOADER_DATA_MISSING = Symbol.for('vura.loaderData.missing');

/**
 * One context for all segments. Each segment's provider shadows its ancestors
 * for its own subtree, which is exactly the "nearest loader wins" rule.
 *
 * Held on `globalThis`, not in a module-scoped `const`, because a built Vura
 * app does not contain one copy of this module. Every page and layout is
 * bundled separately and each bundle inlines its own copy of the loader
 * runtime; the server entry then inlines all of them. With a module-scoped
 * context the provider that the page runtime renders and the `useContext` a
 * layout calls are reading two different context objects, so `useLoaderData()`
 * in any layout of a built app threw "found no loader data" even though the
 * loader had run and its data was right there. Unit tests never saw it: they
 * import one copy.
 *
 * A registered symbol key makes the context a true process singleton, which is
 * the same fix What Framework 0.13.2 applied to its revalidation registry for
 * the same bundling reason.
 */
const LOADER_CONTEXT_KEY = Symbol.for('vura.loaderDataContext');

interface LoaderContextGlobal {
  [LOADER_CONTEXT_KEY]?: ReturnType<typeof createContext<unknown>>;
}

const globalStore = globalThis as unknown as LoaderContextGlobal;
const LoaderDataContext: ReturnType<typeof createContext<unknown>> =
  globalStore[LOADER_CONTEXT_KEY] ??
  (globalStore[LOADER_CONTEXT_KEY] = createContext<unknown>(LOADER_DATA_MISSING));

/** @internal The provider component the page runtime wraps each segment in. */
export const LoaderDataProvider = LoaderDataContext.Provider as (props: {
  value: unknown;
  children: unknown;
}) => unknown;

/**
 * Read the nearest segment's loader data.
 *
 * ```tsx
 * export async function loader(ctx: LoaderContext) {
 *   return { post: await db.post.find(ctx.params.id) };
 * }
 * export default function Post() {
 *   const { post } = useLoaderData<typeof loader>();
 *   return <article>{post.title}</article>;
 * }
 * ```
 *
 * Throws when there is no loader in scope rather than returning `undefined`,
 * because the failure it is usually reporting is a missing `export` — and a
 * page that destructures `undefined` reports that as a stack trace inside the
 * component with no mention of loaders.
 */
export function useLoaderData<L = unknown>(): L extends (ctx: never) => unknown ? LoaderData<L> : L {
  const value = useContext(LoaderDataContext);
  if (value === LOADER_DATA_MISSING) {
    throw new Error(
      '[vura] useLoaderData() found no loader data for this component. ' +
        'Export a `loader` from the page or one of its layouts, and make sure ' +
        'the component is rendered by the page runtime rather than called directly.',
    );
  }
  return value as never;
}

/** @internal Test seam: is any loader data in scope here? */
export function hasLoaderData(): boolean {
  return useContext(LoaderDataContext) !== LOADER_DATA_MISSING;
}

// ─── Running a chain ───

/** A segment of the matched chain: a layout, or the page itself. */
export interface LoaderSegment {
  /** Identifies the segment in the serialized payload. */
  id: string;
  /** The module's `loader` export, if it has one. */
  loader?: Loader;
  /**
   * Legacy `getServerData`, kept working as a deprecated alias. Its result is
   * spread into the component's props as well as exposed through
   * `useLoaderData`, which is the behaviour pages already depend on.
   */
  getServerData?: (ctx: { params: Record<string, string>; url: string; query: Record<string, string | string[]> }) => unknown;
}

export interface LoaderChainResult {
  /** Resolved data per segment, in the same order as the input. */
  data: unknown[];
  /** Segment id → data, for serialization into the document. */
  byId: Record<string, unknown>;
}

/**
 * Run every segment's loader in parallel.
 *
 * Parallel, not sequential: a layout's loader and its page's loader have no
 * data dependency on each other, and running them in series would make nesting
 * cost latency. A loader that throws rejects the whole chain, so `notFound` and
 * `redirect` from any level reach the runtime.
 */
export async function runLoaderChain(
  segments: LoaderSegment[],
  ctx: LoaderContext,
): Promise<LoaderChainResult> {
  const data = await Promise.all(
    segments.map(async (segment) => {
      if (typeof segment.loader === 'function') {
        return await segment.loader(ctx);
      }
      if (typeof segment.getServerData === 'function') {
        return await segment.getServerData({ params: ctx.params, url: ctx.url, query: ctx.query });
      }
      return undefined;
    }),
  );

  const byId: Record<string, unknown> = {};
  segments.forEach((segment, i) => {
    if (data[i] !== undefined) byId[segment.id] = data[i];
  });

  return { data, byId };
}

// ─── Serialization ───

/** The element id the payload is written to and read back from. */
export const LOADER_PAYLOAD_ID = '__VURA_LOADER__';

/**
 * Serialize loader data into a `<script type="application/json">` tag.
 *
 * `application/json` rather than executable JS, so the payload is inert data
 * even if the escaping below were ever wrong. `</` is still escaped because the
 * HTML parser ends a script element on `</script` regardless of type, which is
 * how a string like `"</script><img onerror=...>"` inside otherwise-safe data
 * becomes markup. `<!--` gets the same treatment for the legacy comment-parsing
 * path.
 */
export function serializeLoaderPayload(byId: Record<string, unknown>): string {
  if (Object.keys(byId).length === 0) return '';
  let json: string;
  try {
    json = JSON.stringify(byId);
  } catch (err) {
    throw new Error(
      `[vura] loader data is not JSON-serializable (${(err as Error).message}). ` +
        'Loaders must return plain data — no functions, class instances, or circular references.',
    );
  }
  if (json === undefined) return '';
  const safe = json.replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `<script id="${LOADER_PAYLOAD_ID}" type="application/json">${safe}</script>`;
}

/**
 * Read the serialized payload in the browser.
 *
 * This is what stops a hybrid page's islands from re-fetching what the server
 * already fetched. Returns an empty object when the page has no payload, which
 * is the normal case for a `client`-mode page.
 */
export function readLoaderPayload(doc?: { getElementById(id: string): { textContent: string | null } | null }): Record<string, unknown> {
  const d = doc ?? (typeof document !== 'undefined' ? document : undefined);
  if (!d) return {};
  const el = d.getElementById(LOADER_PAYLOAD_ID);
  if (!el || !el.textContent) return {};
  try {
    return JSON.parse(el.textContent) as Record<string, unknown>;
  } catch {
    console.warn('[vura] the loader payload in this document is not valid JSON — ignoring it.');
    return {};
  }
}
