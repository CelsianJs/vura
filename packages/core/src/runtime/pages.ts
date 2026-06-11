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
import { wrapDocument } from '../static-render.js';

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
    getServerData?: (ctx: any) => Promise<any> | any;
    page?: Record<string, any>;
  };
  /**
   * Loaded layout module objects, outermost first.
   * NOTE: PageRoute.layouts (from the manifest) holds file-path strings.
   * The server entry MUST load those paths (PageRoute.layouts) into actual
   * modules and populate this field (layoutModules) before calling buildWhatRoutes.
   */
  layoutModules?: Array<{ default: (props: any) => unknown }>;
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
  }): Promise<{ html: string; status: number; tags: string[]; path: string }> {
    const { route, params, query, path } = routeMatch;

    try {
      const p = route.vura;
      const mod = p.module;
      const pageConfig = mod.page ?? {};

      // Run getServerData if present.
      // ctx.url is the pathname string (not a URL object) — matches legacy build.ts RENDER_PAGE_CODE
      let serverData: Record<string, unknown> = {};
      if (typeof mod.getServerData === 'function') {
        serverData = await mod.getServerData({ params, url: path, query });
      }

      // Render component tree: page wrapped by layout chain (outermost first)
      let vnode: unknown = mod.default({ ...serverData, params });
      const layouts = p.layoutModules ?? [];
      for (let i = layouts.length - 1; i >= 0; i--) {
        const Layout = layouts[i]!.default;
        if (typeof Layout === 'function') {
          vnode = Layout({ children: vnode, params });
        }
      }

      // Produce full HTML document
      const html = wrapDocument(renderToString(vnode as any), {
        title: pageConfig.title ?? 'Vura App',
        meta: pageConfig.meta ?? [],
        styles: pageConfig.styles ?? [],
        scripts: pageConfig.scripts ?? [],
        head: pageConfig.head ?? '',
      });

      // tags come from route.page (= routeMatch.config), not the render return,
      // but we echo them back for any cache engines that read the result.
      const tags: string[] = routeMatch.config?.tags ?? [];

      return { html, status: 200, tags, path };
    } catch (err) {
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
  return createRequestHandler({
    routes: opts.routes,
    cache: opts.cache,
    render: createVuraRenderRoute(),
    revalidateWebhook: opts.revalidateWebhook,
    csrf: false,
  });
}
