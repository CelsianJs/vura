/**
 * Vura Runtime Pages Module
 *
 * Bridges vura's page semantics (getServerData, layout chains, wrapDocument)
 * onto what-fw's WinterCG createRequestHandler via the `render` injection point.
 *
 * what-fw core.js contract (verified against packages/server/src/adapter/core.js):
 *   - createRequestHandler({ routes, cache, render, csrf, ... })
 *   - routes: array of objects with `.path` (string) and `.page` (config object)
 *   - render: async (routeMatch) => { html, status, tags, path }
 *   - routeMatch shape: { path, query, config, route, params, request }
 *     where config === route.page (set at core.js line 183)
 *   - Cache-Control: private, no-store is set by core.js when config.mode === 'server'
 *     (the streaming path bypasses core.js and must set it itself)
 *
 * what-router compilePath syntax (verified against packages/router/src/match.js):
 *   - :param → named segment
 *   - *:name → named catch-all (compilePath line 23: `segment.startsWith('*:')`)
 *   - bare * → catch-all named 'rest'
 *
 * Vura urlPattern uses *name (no colon), so we convert *name → *:name.
 */

// what-framework/server re-exports everything from what-server at runtime
// (verified: src/server.js does `export * from 'what-server'`), including
// createRequestHandler. The bundled type stubs (server.d.ts) don't yet
// declare it, so we use @ts-ignore on that specific import.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// TODO(what-fw): server.d.ts doesn't declare createRequestHandler — fix upstream, then drop this shim
// @ts-ignore — createRequestHandler is exported at runtime, not yet in .d.ts
import { renderToString, renderToStream, createRequestHandler as _createRequestHandler } from 'what-framework/server';
import { h } from 'what-framework';
// document.js, not static-render.js: this module is bundled into the
// Cloudflare Worker and the Lambda pages function, and static-render.js
// imports node:fs/promises at module scope, which does not resolve there.
import { wrapDocument, documentShell } from '../document.js';
import { buildVuraCacheTagHeader } from './cache-tags.js';
import { compilePageRoutes, matchPageRoute } from '../match.js';
import {
  createLoaderContext,
  isLoaderNotFound,
  isLoaderRedirect,
  LoaderDataProvider,
  runLoaderChain,
  serializeLoaderPayload,
  type Loader,
  type LoaderSegment,
} from './loader.js';

const createRequestHandler = _createRequestHandler as (
  options: Record<string, unknown>,
) => (req: Request) => Promise<Response>;
import type { PageRoute } from '../manifest.js';

// ─── Runtime Types ───

/**
 * A PageRoute extended with the loaded module and optional layout modules,
 * needed at request time.
 */
export interface RuntimePage extends PageRoute {
  module: {
    default: (props: any) => unknown;
    /** RFC 0001 server-side data fetching. Supersedes getServerData. */
    loader?: Loader;
    /** @deprecated Use `loader`. Kept working; its result is still spread into props. */
    getServerData?: (ctx: any) => Promise<any> | any;
    page?: Record<string, any>;
  };
  /**
   * Loaded layout module objects, outermost first.
   * NOTE: PageRoute.layouts (from the manifest) holds file-path strings.
   * The server entry MUST load those paths (PageRoute.layouts) into actual
   * modules and populate this field (layoutModules) before calling buildWhatRoutes.
   */
  layoutModules?: Array<{ default: (props: any) => unknown; loader?: Loader }>;
}

/**
 * A route in the shape what-fw's matchRoute expects.
 * `.page` is what core.js reads as `config` inside routeMatch.
 */
export interface WhatPageRoute {
  path: string;
  page: {
    mode: 'server' | 'static';
    revalidate?: number;
    tags?: string[];
    swr?: number;
  };
  /** The vura RuntimePage, passed through for the render callback. */
  vura: RuntimePage;
}

// ─── Route Mapping ───

/**
 * Convert vura PageRoutes to what-fw route objects.
 *
 * Pattern conversion:
 *   - /blog/:slug → /blog/:slug (unchanged — :param is shared syntax)
 *   - /docs/*rest → /docs/*:rest (vura *name → what-router *:name)
 *
 * ISR config mapping:
 *   - server mode + no revalidate → { mode: 'server' } (cache BYPASS)
 *   - server mode + revalidate    → { mode: 'static', revalidate, tags } (ISR/HIT/STALE/MISS)
 */
export function buildWhatRoutes(pages: RuntimePage[]): WhatPageRoute[] {
  // caller contract: only server-mode pages reach the runtime;
  // static/client/hybrid are prebuilt and must not appear here.
  return pages.filter((p) => p.mode === 'server').map((p) => {
    const revalidate = typeof p.config.revalidate === 'number' ? p.config.revalidate : undefined;

    // tags may be a comma-separated string or already an array
    let tags: string[] | undefined;
    if (typeof p.config.tags === 'string' && p.config.tags.length > 0) {
      tags = p.config.tags.split(',').map(t => t.trim()).filter(Boolean);
    } else if (Array.isArray(p.config.tags) && p.config.tags.length > 0) {
      tags = p.config.tags as string[];
    }

    const swr = typeof p.config.swr === 'number' ? p.config.swr : undefined;

    return {
      // Convert vura *name catch-alls to what-router *:name syntax
      path: p.urlPattern.replace(/\*([A-Za-z0-9_]+)/g, '*:$1'),
      page: revalidate != null
        ? {
            mode: 'static' as const,
            revalidate,
            ...(tags ? { tags } : {}),
            ...(swr != null ? { swr } : {}),
          }
        : { mode: 'server' as const },
      vura: p,
    };
  });
}

// ─── Loader redirects ───

/**
 * Redirects a loader asked for, keyed by the Request that produced them.
 *
 * what-server's direct-render path (server mode, no cache) builds its Response
 * from `out.html` and `out.status` only — it drops `out.headers`, which the
 * cached path does honour. So a 302 returned from `render` arrives at the
 * browser with no `Location`, which is worse than not redirecting at all.
 *
 * Rather than emit a meta-refresh, the render records the redirect against the
 * request object and the handler below converts it into a real Response. A
 * WeakMap keyed by the Request keeps this per-request with no cleanup to forget
 * and nothing shared between concurrent requests.
 *
 * Fixed upstream in what-framework 0.13.3, which spreads `out.headers` on the
 * direct-render branch like the cache branch always did. This stays until Vura's
 * declared range excludes 0.13.2, because a project on 0.13.2 would otherwise
 * get a 302 with no Location — a blank page with nothing to explain it.
 */
const pendingRedirects = new WeakMap<Request, { location: string; status: number }>();

// ─── Render Callback ───

/**
 * Create the vura render callback for createRequestHandler's `render` option.
 *
 * routeMatch (from core.js line 184):
 *   { path, query, config, route, params, request }
 *   where config = route.page (the WhatPageRoute.page object)
 *
 * Expected return (from core.js line 54-59):
 *   { html, status, tags, path }
 */
export interface RenderRouteOptions {
  /**
   * Extra script URLs to append to a page's own `page.scripts`.
   *
   * `vura dev` uses this for a hybrid page's browser bundle, whose URL is a
   * dev-server path that does not exist at build time. It exists so the dev
   * server can render through this exact function rather than keeping a second
   * copy of the render logic, which is how dev spent 0.6.0 and 0.6.1 unable to
   * run a loader at all while the built server ran them correctly.
   */
  extraScripts?: (page: RuntimePage) => string[];
}

/**
 * Everything a render needs, built once so the buffered and streaming paths
 * cannot disagree about it.
 *
 * Loaders run here, before either render begins. They are route-level for a
 * reason that has not changed: `renderToString` is synchronous, so there is
 * nowhere inside the tree to await one. Streaming adds a *second* place data
 * can come from (a `createResource` inside a `<Suspense>` boundary), it does
 * not move loaders into the tree.
 */
async function prepareRender(
  route: WhatPageRoute,
  params: Record<string, string>,
  query: Record<string, string | string[]>,
  path: string,
  request: Request,
): Promise<{ vnode: unknown; pageConfig: Record<string, any>; byId: Record<string, unknown>; page: RuntimePage }> {
  const p = route.vura;
  const mod = p.module;
  const pageConfig = mod.page ?? {};
  const layouts = p.layoutModules ?? [];

  const segments: LoaderSegment[] = [
    ...layouts.map((layout, i) => ({ id: `layout:${i}`, loader: layout.loader })),
    { id: 'page', loader: mod.loader, getServerData: mod.getServerData },
  ];
  const ctx = createLoaderContext({ params, url: path, query, request });
  const { data, byId } = await runLoaderChain(segments, ctx);
  const pageData = data[data.length - 1];

  const legacyProps =
    typeof mod.loader !== 'function' && typeof mod.getServerData === 'function' && pageData && typeof pageData === 'object'
      ? (pageData as Record<string, unknown>)
      : {};

  let vnode: unknown = h(
    LoaderDataProvider as any,
    { value: pageData },
    h(mod.default as any, { ...legacyProps, params }),
  );
  for (let i = layouts.length - 1; i >= 0; i--) {
    const Layout = layouts[i]!.default;
    if (typeof Layout === 'function') {
      vnode = h(
        LoaderDataProvider as any,
        { value: data[i] },
        h(Layout as any, { children: vnode, params }),
      );
    }
  }

  return { vnode, pageConfig, byId, page: p };
}

/** Does this page opt into a streamed response? */
export function isStreamingPage(page: RuntimePage): boolean {
  return (page.module.page ?? {}).streaming === true || page.config?.streaming === true;
}

/**
 * Render a page as a streamed response.
 *
 * The document shell goes out before the body is rendered, so the browser can
 * start fetching stylesheets and scripts while the server is still working.
 * Anything inside a `<Suspense>` boundary is awaited and emitted in place.
 *
 * Two things are settled before the first byte, deliberately: the loader chain
 * and its control flow. `notFound()` and `redirect()` have to be able to set a
 * status, and once a byte is written the status is spent. A failure *after*
 * that point cannot become a 500 either, so it terminates the stream and is
 * logged; a page that wants to degrade gracefully should put an
 * `<ErrorBoundary>` around the part that can fail.
 */
export function createVuraStreamRoute(options: RenderRouteOptions = {}) {
  return async function streamRoute(routeMatch: {
    path: string;
    query: Record<string, string | string[]>;
    route: WhatPageRoute;
    params: Record<string, string>;
    request: Request;
  }): Promise<Response> {
    const { route, params, query, path, request } = routeMatch;

    let prepared;
    try {
      prepared = await prepareRender(route, params, query, path, request);
    } catch (err) {
      // Still before the first byte: a real status is still possible.
      if (isLoaderNotFound(err)) {
        return new Response(request.method === 'HEAD' ? null : '<!DOCTYPE html><html><body><h1>404 — Not Found</h1></body></html>', {
          status: 404,
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store' },
        });
      }
      if (isLoaderRedirect(err)) {
        return new Response(null, {
          status: err.status,
          headers: { Location: err.location, 'cache-control': 'private, no-store' },
        });
      }
      console.error(`[vura] streamRoute error for path "${path}":`, err);
      return new Response(request.method === 'HEAD' ? null : '<!DOCTYPE html><html><body><h1>500 — Server Error</h1></body></html>', {
        status: 500,
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store' },
      });
    }

    const { vnode, pageConfig, byId, page } = prepared;
    if (request.method === 'HEAD') {
      // Resolve loader control flow, but do not render or start a stream that
      // has no reader. HEAD must bypass ISR just like its corresponding GET.
      return new Response(null, {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'private, no-store',
          'x-accel-buffering': 'no',
        },
      });
    }
    const { open, close } = documentShell({
      title: pageConfig.title ?? 'Vura App',
      meta: pageConfig.meta ?? [],
      styles: pageConfig.styles ?? [],
      scripts: [...(pageConfig.scripts ?? []), ...(options.extraScripts?.(page) ?? [])],
      head: pageConfig.head ?? '',
      bodyEnd: serializeLoaderPayload(byId),
    });

    const encoder = new TextEncoder();
    // A reader that goes away mid-stream is a normal event, not a failure: the
    // visitor navigated, closed the tab, or hit stop. Without this flag the
    // `enqueue` that follows throws `ERR_INVALID_STATE`, and the catch below
    // reported every such disconnect as "render failed mid-document" with a
    // stack trace. That is noise on the most common interruption there is, and
    // it buries the real render failures it exists to surface.
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
      async start(controller) {
        const write = (text: string): boolean => {
          if (cancelled) return false;
          try {
            controller.enqueue(encoder.encode(text));
            return true;
          } catch {
            // Lost the reader between the check and the write.
            cancelled = true;
            return false;
          }
        };
        try {
          if (!write(open)) return;
          for await (const chunk of renderToStream(vnode as any)) {
            if (chunk && !write(String(chunk))) return;
          }
          write(close);
        } catch (err) {
          if (cancelled) return;
          // Past the point of no return: the status and part of the document
          // are already on the wire. Close the document so the browser is not
          // left parsing a truncated tree, and log the real error.
          console.error(`[vura] stream render failed mid-document for "${path}":`, err);
          write(`<!-- [vura] render failed -->${close}`);
        } finally {
          if (!cancelled) {
            try {
              controller.close();
            } catch {
              /* already closed by a cancel that raced us */
            }
          }
        }
      },
    });

    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        // Streaming bypasses ISR, even when a page declares revalidate. Its
        // request-specific loader output must not be stored by a shared cache.
        'cache-control': 'private, no-store',
        // No content-length: the length is not known until the last chunk, and
        // omitting it is what makes the host chunk the response. Setting
        // `transfer-encoding` by hand instead would be wrong twice over: HTTP/2
        // forbids the header outright, and the Lambda adapter would echo it
        // into the response payload.
        'x-accel-buffering': 'no',
      },
    });
  };
}

export function createVuraRenderRoute(options: RenderRouteOptions = {}) {
  return async function renderRoute(routeMatch: {
    path: string;
    query: Record<string, string | string[]>;
    config: WhatPageRoute['page'];
    route: WhatPageRoute;
    params: Record<string, string>;
    request: Request;
    csrfToken?: string;
  }): Promise<{ html: string; status: number; tags: string[]; path: string; headers?: Record<string, string> }> {
    const { route, params, query, path, request } = routeMatch;

    try {
      // Loaders, props and the component tree are built by prepareRender, which
      // the streaming path uses too. One function, so the two renders cannot
      // disagree about what a page is.
      const { vnode, pageConfig, byId, page: p } = await prepareRender(
        route, params, query, path, request,
      );

      // Produce full HTML document
      const html = wrapDocument(renderToString(vnode as any), {
        title: pageConfig.title ?? 'Vura App',
        meta: pageConfig.meta ?? [],
        styles: pageConfig.styles ?? [],
        scripts: [...(pageConfig.scripts ?? []), ...(options.extraScripts?.(p) ?? [])],
        head: pageConfig.head ?? '',
        bodyEnd: serializeLoaderPayload(byId),
      });

      // tags come from route.page (= routeMatch.config), not the render return,
      // but we echo them back for any cache engines that read the result.
      const tags: string[] = routeMatch.config?.tags ?? [];

      return { html, status: 200, tags, path };
    } catch (err) {
      // A loader's notFound()/redirect() is control flow, not a failure. Letting
      // it fall into the 500 branch below would turn "no post with that id" into
      // "this server is broken", which is the wrong status, the wrong page, and
      // the wrong thing to page someone about.
      if (isLoaderNotFound(err)) {
        return {
          html: '<!DOCTYPE html><html><body><h1>404 — Not Found</h1></body></html>',
          status: 404,
          tags: [],
          path,
        };
      }
      if (isLoaderRedirect(err)) {
        if (request) pendingRedirects.set(request, { location: err.location, status: err.status });
        return {
          html: '',
          status: err.status,
          tags: [],
          path,
          headers: { Location: err.location },
        };
      }
      console.error(`[vura] renderRoute error for path "${path}":`, err);
      return {
        html: '<!DOCTYPE html><html><body><h1>500 — Server Error</h1></body></html>',
        status: 500,
        tags: [],
        path,
      };
    }
  };
}

// ─── Handler Factory ───

export interface PagesHandlerOptions {
  routes: WhatPageRoute[];
  /** what-isr cache engine (Task 3). Omit for pure server-mode rendering. */
  cache?: unknown;
  /** On-demand revalidation webhook (Task 4). */
  revalidateWebhook?: unknown;
  /** See `RenderRouteOptions.extraScripts`. */
  extraScripts?: (page: RuntimePage) => string[];
}

type CacheResult = { headers?: Record<string, string> } & Record<string, unknown>;
type CacheWithHandle = { handle: (routeMatch: { config?: { tags?: unknown } }, ...args: unknown[]) => Promise<CacheResult> | CacheResult };

/**
 * Wrap an ISR cache engine so tagged responses carry the Vura cache-tag
 * headers.
 *
 * A page's declared `tags` are normalised through {@link buildVuraCacheTagHeader}
 * (sanitised, capped, deduped) and emitted as:
 *   - `x-vura-cache-tag` — the Vura Platform edge reads this to build a
 *     project-scoped `Cache-Tag` and to record per-tag cache analytics.
 *   - `Cache-Tag` — consumed by a self-hosted Cloudflare/Fastly zone (no Vura
 *     edge); on the platform it is overwritten by the namespacing edge.
 *
 * This wrapper is the tag-sanitisation authority: it writes the *sanitised*
 * value onto both headers, replacing the raw, uncapped `cache-tag` that the
 * underlying ISR engine (what-isr) derives straight from the declared tags.
 * That is deliberate — the raw value has no length/count cap and no control-
 * character stripping, so emitting it unmodified would be exactly the injection
 * and bloat surface this layer exists to close. The header is omitted entirely
 * when a page declares no valid tags. (what-isr's Fastly `surrogate-key` is a
 * separate, engine-owned header and is left as-is.)
 */
function addVuraCacheTagHeaders(cache: unknown): unknown {
  if (typeof cache !== 'object' || cache === null || typeof (cache as CacheWithHandle).handle !== 'function') return cache;
  const wrapped = cache as CacheWithHandle;
  return { ...wrapped, async handle(routeMatch: { config?: { tags?: unknown } }, ...args: unknown[]) {
    const result = await wrapped.handle(routeMatch, ...args);
    const cacheTag = buildVuraCacheTagHeader(routeMatch.config?.tags);
    if (cacheTag === null) return result;
    const headers = { ...(result.headers ?? {}) };
    // what-isr emits the raw tags on lowercase `cache-tag`; drop it so the
    // sanitised canonical `Cache-Tag` below is the only one on the response.
    delete headers['cache-tag'];
    return {
      ...result,
      headers: {
        ...headers,
        'Cache-Tag': cacheTag,
        'x-vura-cache-tag': cacheTag,
      },
    };
  } };
}

/**
 * Create a WinterCG Request → Response handler for vura pages.
 *
 * Uses what-fw's createRequestHandler with vura semantics injected via
 * the `render` option. CSRF is disabled — auth is celsian's concern and
 * page forms post to /api routes.
 */
export function createPagesHandler(
  opts: PagesHandlerOptions,
): (req: Request) => Promise<Response> {
  const handler = createRequestHandler({
    routes: opts.routes,
    cache: addVuraCacheTagHeaders(opts.cache),
    render: createVuraRenderRoute(opts.extraScripts ? { extraScripts: opts.extraScripts } : {}),
    revalidateWebhook: opts.revalidateWebhook,
    csrf: false,
  });

  // Streaming pages are matched here rather than inside what-fw's handler,
  // because that handler's contract is a render callback returning a complete
  // HTML string. A streamed page has no such string, and it deliberately skips
  // the ISR cache: a response the server is still producing is not one the
  // cache can store or a revalidation can replace.
  const streamingRoutes = opts.routes.filter(r => isStreamingPage(r.vura));
  const compiledStreaming = streamingRoutes.length > 0
    ? compilePageRoutes(streamingRoutes.map(r => r.vura))
    : [];
  const streamRoute = createVuraStreamRoute(
    opts.extraScripts ? { extraScripts: opts.extraScripts } : {},
  );

  return async function vuraPagesHandler(req: Request): Promise<Response> {
    // Both methods use the streaming policy. Falling through on HEAD would
    // populate ISR for a page whose GET deliberately bypasses that cache.
    if (compiledStreaming.length > 0 && (req.method === 'GET' || req.method === 'HEAD')) {
      const url = new URL(req.url);
      const match = matchPageRoute(compiledStreaming, url.pathname);
      if (match) {
        const route = streamingRoutes.find(r => r.vura.urlPattern === match.page.urlPattern)!;
        const query: Record<string, string | string[]> = Object.create(null);
        url.searchParams.forEach((v, k) => {
          const previous = query[k];
          if (previous === undefined) query[k] = v;
          else if (typeof previous === 'string') query[k] = [previous, v];
          else previous.push(v);
        });
        return streamRoute({
          path: url.pathname,
          query,
          route,
          params: match.params,
          request: req,
        });
      }
    }

    const response = await handler(req);
    const redirect = pendingRedirects.get(req);
    if (!redirect) return response;
    pendingRedirects.delete(req);
    // Carry the cookies the inner handler set (the CSRF cookie among them) so a
    // redirect does not silently drop session state on the way to the target.
    const headers = new Headers(response.headers);
    headers.set('Location', redirect.location);
    headers.delete('content-type');
    return new Response(null, { status: redirect.status, headers });
  };
}
