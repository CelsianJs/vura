/**
 * Vura middleware — one function that runs before a request reaches anything.
 *
 * Vura already had lifecycle hooks (`src/api/_hooks.ts`), and they only ever
 * ran for API routes: verified by execution, an `onRequest` hook fires for
 * `/api/hello` and does not fire for a server-rendered page or a static one.
 * So there was nowhere to put the most ordinary requirement there is, an auth
 * guard that redirects an unauthenticated visitor away from `/dashboard`
 * before it renders.
 *
 * The contract is deliberately small:
 *
 *   src/middleware.ts
 *     export const config = { matcher: ['/dashboard/:path*'] };  // optional
 *     export default function middleware(ctx) {
 *       if (!ctx.cookies.get('session')) return ctx.redirect('/login');
 *       ctx.headers.set('x-request-id', crypto.randomUUID());
 *     }
 *
 * Return a `Response` and it is the answer: nothing else runs. Return nothing
 * and the request carries on, with anything set on `ctx.headers` merged onto
 * whatever the route eventually produces.
 *
 * A note for anyone hosting this runtime somewhere other than the Node server:
 * apply `ctx.headers` to the host's response object, not to the `Response` a
 * route returns. A Celsian `reply.json()` stashes a snapshot of its headers on
 * the Response under `Symbol.for('celsian.fastResponse')`, and the Node writer
 * uses that snapshot, so a header added to `response.headers` afterwards is
 * silently dropped. This was found by a test that expected the header on an API
 * response and got null.
 */

// ─── Types ───

/** The subset of a cookie jar middleware needs: read-only, parsed once. */
export interface MiddlewareCookies {
  get(name: string): string | undefined;
  has(name: string): boolean;
}

export interface MiddlewareContext {
  /** The incoming request, untouched. */
  request: Request;
  /** Parsed URL of the request. */
  url: URL;
  /** `url.pathname`, hoisted because it is what most middleware branches on. */
  pathname: string;
  /** Named segments captured by the matcher that let this request through. */
  params: Record<string, string>;
  /** Parsed query string. Repeated keys become arrays, as in loaders. */
  query: Record<string, string | string[]>;
  /** Request cookies, parsed from the `cookie` header. */
  cookies: MiddlewareCookies;
  /**
   * Headers to merge onto the eventual response. Set here rather than returned
   * so a middleware can add a request id or a security header without having
   * to short-circuit the request to do it.
   */
  headers: Headers;
  /** Build a redirect response. `return ctx.redirect('/login')` to send it. */
  redirect(to: string, status?: number): Response;
  /** Build a plain response. `return ctx.deny()` for a 403 with no body. */
  deny(status?: number, body?: string): Response;
}

export type MiddlewareHandler = (
  ctx: MiddlewareContext,
) => Response | void | Promise<Response | void>;

export interface MiddlewareConfig {
  /**
   * Paths this middleware runs for. Omit to run for every request.
   *
   * Supported shapes, matched against the pathname:
   *   '/admin'            exact
   *   '/team/:id'         one named segment
   *   '/dashboard/:path*' a named catch-all, `params.path` is the rest
   *   '/assets/*'         an anonymous catch-all
   */
  matcher?: string | string[];
}

export interface MiddlewareModule {
  default?: MiddlewareHandler;
  middleware?: MiddlewareHandler;
  config?: MiddlewareConfig;
}

/** Result of running middleware for one request. */
export interface MiddlewareResult {
  /** A response to send instead of routing the request. */
  response?: Response;
  /** Headers to merge onto whatever the route produces. */
  headers?: Headers;
}

// ─── Matcher ───

/**
 * Paths middleware never sees. These are the framework's own control surfaces:
 * the ISR revalidation webhook and the task admin API. Letting a project's auth
 * guard 401 its own cache purges would be a debugging nightmare, and neither
 * path is part of the application's routing.
 */
const INTERNAL_PREFIXES = ['/__vura/', '/__tasks'];

interface CompiledMatcher {
  regex: RegExp;
  names: string[];
}

/**
 * Compile one matcher pattern to a regex plus the names it captures.
 *
 * Written here rather than reusing the page router because middleware matches
 * a raw pathname before any route is resolved: there may be no route at all.
 */
export function compileMatcher(pattern: string): CompiledMatcher {
  const names: string[] = [];
  let source = '^';

  for (const rawSegment of pattern.split('/')) {
    if (rawSegment === '') continue;
    source += '/';

    if (rawSegment === '*') {
      // anonymous catch-all: the rest of the path, if any
      source += '.*';
      continue;
    }

    const catchAll = /^:([A-Za-z0-9_]+)\*$/.exec(rawSegment);
    if (catchAll) {
      names.push(catchAll[1]!);
      source += '(.*)';
      continue;
    }

    const param = /^:([A-Za-z0-9_]+)$/.exec(rawSegment);
    if (param) {
      names.push(param[1]!);
      source += '([^/]+)';
      continue;
    }

    source += rawSegment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // A pattern ending in a catch-all also matches the bare prefix:
  // '/dashboard/:path*' matches '/dashboard' as well as '/dashboard/a/b'.
  if (source.endsWith('(.*)')) source = `${source.slice(0, -'/(.*)'.length)}(?:/(.*))?`;
  else if (source.endsWith('.*')) source = `${source.slice(0, -'/.*'.length)}(?:/.*)?`;

  return { regex: new RegExp(`${source}/?$`), names };
}

function matchAny(
  matchers: CompiledMatcher[],
  pathname: string,
): { matched: boolean; params: Record<string, string> } {
  if (matchers.length === 0) return { matched: true, params: {} };
  for (const m of matchers) {
    const hit = m.regex.exec(pathname);
    if (!hit) continue;
    const params: Record<string, string> = {};
    m.names.forEach((name, i) => {
      const value = hit[i + 1];
      if (value !== undefined) params[name] = value;
    });
    return { matched: true, params };
  }
  return { matched: false, params: {} };
}

// ─── Context ───

/** Parse a `cookie` header into a read-only jar. */
export function parseCookies(header: string | null): MiddlewareCookies {
  const jar = new Map<string, string>();
  if (header) {
    for (const part of header.split(';')) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      const name = part.slice(0, eq).trim();
      if (!name) continue;
      const raw = part.slice(eq + 1).trim();
      try {
        jar.set(name, decodeURIComponent(raw));
      } catch {
        // A malformed percent-escape is not a reason to drop the whole cookie.
        jar.set(name, raw);
      }
    }
  }
  return {
    get: (name) => jar.get(name),
    has: (name) => jar.has(name),
  };
}

function queryFrom(url: URL): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const all = url.searchParams.getAll(key);
    query[key] = all.length > 1 ? all : all[0]!;
  }
  return query;
}

// ─── Runner ───

export interface MiddlewareRunner {
  /** Whether a usable middleware was found in the module. */
  readonly enabled: boolean;
  run(request: Request, url?: URL): Promise<MiddlewareResult>;
}

/**
 * Build a runner from a loaded `src/middleware.ts` module.
 *
 * A module with no handler produces a disabled runner rather than an error, so
 * a project that deletes its middleware but leaves the file behind keeps
 * working.
 */
export function createMiddlewareRunner(mod: MiddlewareModule | null | undefined): MiddlewareRunner {
  const handler = typeof mod?.default === 'function'
    ? mod.default
    : typeof mod?.middleware === 'function'
      ? mod.middleware
      : null;

  if (!handler) {
    return { enabled: false, run: async () => ({}) };
  }

  const rawMatcher = mod?.config?.matcher;
  const patterns = rawMatcher === undefined
    ? []
    : Array.isArray(rawMatcher)
      ? rawMatcher
      : [rawMatcher];
  const matchers = patterns.map(compileMatcher);

  return {
    enabled: true,
    async run(request: Request, url?: URL): Promise<MiddlewareResult> {
      const parsed = url ?? new URL(request.url);
      const pathname = parsed.pathname;

      if (INTERNAL_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return {};

      const { matched, params } = matchAny(matchers, pathname);
      if (!matched) return {};

      const headers = new Headers();
      const ctx: MiddlewareContext = {
        request,
        url: parsed,
        pathname,
        params,
        query: queryFrom(parsed),
        cookies: parseCookies(request.headers.get('cookie')),
        headers,
        redirect(to: string, status = 307) {
          const res = new Response(null, { status, headers: { location: to } });
          for (const [k, v] of headers) res.headers.set(k, v);
          return res;
        },
        deny(status = 403, body = '') {
          const res = new Response(body, { status });
          for (const [k, v] of headers) res.headers.set(k, v);
          return res;
        },
      };

      const result = await handler(ctx);
      if (result instanceof Response) return { response: result };
      return [...headers.keys()].length > 0 ? { headers } : {};
    },
  };
}
