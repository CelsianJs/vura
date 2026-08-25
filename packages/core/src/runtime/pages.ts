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
 *     (we do NOT set it ourselves)
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
import { renderToString, createRequestHandler as _createRequestHandler } from 'what-framework/server';
import { h } from 'what-framework';
import { wrapDocument } from '../static-render.js';
import { buildVuraCacheTagHeader } from './cache-tags.js';
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
export function createVuraRenderRoute() {
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
      const p = route.vura;
      const mod = p.module;
      const pageConfig = mod.page ?? {};
      const layouts = p.layoutModules ?? [];

      // Loaders run before the render, never during it: What's renderToString
      // is synchronous, so there is nowhere inside the tree to await. Every
      // segment's loader runs in parallel — a layout and its page have no data
      // dependency on each other, and serializing them would make nesting cost
      // latency. (RFC 0001.)
      const segments: LoaderSegment[] = [
        ...layouts.map((layout, i) => ({ id: `layout:${i}`, loader: layout.loader })),
        { id: 'page', loader: mod.loader, getServerData: mod.getServerData },
      ];
      // ctx.url is the pathname string (not a URL object) — matches legacy build.ts RENDER_PAGE_CODE
      const ctx = createLoaderContext({ params, url: path, query, request });
      const { data, byId } = await runLoaderChain(segments, ctx);
      const pageData = data[data.length - 1];

      // getServerData's contract was `{ ...data }` spread into props, and pages
      // in the wild depend on it. It keeps that AND appears through
      // useLoaderData, so a page can migrate one line at a time.
      const legacyProps =
        typeof mod.loader !== 'function' && typeof mod.getServerData === 'function' && pageData && typeof pageData === 'object'
          ? (pageData as Record<string, unknown>)
          : {};

      // The component is handed to h() rather than called directly. Calling it
      // directly runs the body outside any component context, so every What
      // hook inside a page — useContext included, which is how useLoaderData
      // reads its data — would throw or read nothing.
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

      // Produce full HTML document
      const html = wrapDocument(renderToString(vnode as any), {
        title: pageConfig.title ?? 'Vura App',
        meta: pageConfig.meta ?? [],
        styles: pageConfig.styles ?? [],
        scripts: pageConfig.scripts ?? [],
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
    render: createVuraRenderRoute(),
    revalidateWebhook: opts.revalidateWebhook,
    csrf: false,
  });

  return async function vuraPagesHandler(req: Request): Promise<Response> {
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
