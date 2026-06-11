# Vura A1+A2 Implementation Plan — Rebase on Real WhatStack (v0.3) + Hot/Task Routes for Real (v0.4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete Vura's parallel-universe infrastructure (hand-rolled SSR string renderer, string-codegen'd HTTP server, homegrown ISR/hooks/cron) and rebase it on the real WhatStack: `what-framework@^0.11.1` (`renderToString`, `createRequestHandler`), `what-isr@^0.11.1` (cache engine, stores, revalidation, CDN purge), and `@celsian/core@^0.5.2` (API routing, hooks, cron, websockets). Then make `kind: 'hot'` and `kind: 'task'` routes real products: websockets with graceful drain + deploy templates, and a celsian-cron-backed task executor with a `vura tasks run` CLI.

**Architecture:** The generated `dist/server/entry.js` stops being 1,000 lines of string-concatenated JavaScript and becomes a thin generated wiring file (route/page module imports + a `startVuraServer()` call) that esbuild bundles into a self-contained artifact — the runtime itself lives in `@celsian/vura-core/src/runtime/` as real, unit-testable TypeScript. The runtime composes three layers per request: a CelsianApp handles `/api/*` and `/__vura/*`, a what-fw `createRequestHandler` (with injected vura page renderer + what-isr cache engine) handles server/ISR pages, and prebuilt static assets are served from `dist/static`/`public`.

**Tech Stack:** TypeScript 5.7, Node ≥20 <23, pnpm workspaces, vitest, esbuild 0.27, `what-framework`/`what-core`/`what-server`/`what-isr` ^0.11.1, `@celsian/core` ^0.5.2, `@celsian/jwt` ^0.5.2, `ws` ^8 (optional, hot routes only).

**Master plan:** WhatStack/VURA-MASTER-PLAN-2026-06-10.md §4 (A1/A2)

---

## File Structure

All paths relative to `/Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/vura`.

### Created
| File | Responsibility |
|---|---|
| `packages/core/src/runtime/pages.ts` | `buildWhatRoutes()` (vura `PageRoute[]` → what-router route objects) + `createVuraRenderRoute()` (getServerData + layout chain + what-fw `renderToString` + `wrapDocument`) + `createPagesHandler()` over `createRequestHandler` |
| `packages/core/src/runtime/cache.ts` | `createVuraCache(config)` — what-isr engine from `vura.config` cache block (memory/filesystem/redis store, cloudflare/fastly CDN purge, webhook) |
| `packages/core/src/runtime/api-app.ts` | `createApiApp()` — registers `src/api/*` modules onto a `CelsianApp`; mounts `/__vura/revalidate`; binds global hooks as celsian hooks |
| `packages/core/src/runtime/server.ts` | `startVuraServer(options)` — Node `http.Server` composing celsian app + pages handler + static files; WS upgrade wiring; cron/task startup; graceful SIGTERM drain |
| `packages/core/src/runtime/hot.ts` | `VuraPeer` contract + adapter from vura's exported `websocket(peer, req)` to celsian `WSHandler` |
| `packages/core/src/compat.ts` | `toThenRequest(celsianReq)` / `wrapThenHandler(fn)` — deprecated ThenRequest/ThenReply compatibility layer over celsian context |
| `packages/core/src/auth.ts` | Thin auth helpers: `cookieSession()` celsian hook (HMAC-signed cookie) + re-exports of `@celsian/jwt` `jwt`/`createJWTGuard` |
| `packages/core/test/runtime-pages.test.ts` | Tests for route mapping + render injection |
| `packages/core/test/runtime-cache.test.ts` | Tests for cache config → engine + revalidate exports + webhook |
| `packages/core/test/runtime-api-app.test.ts` | Tests for celsian API registration + compat shim |
| `packages/core/test/runtime-server.test.ts` | End-to-end runtime tests (real HTTP server on ephemeral port) |
| `packages/core/test/hot-routes.test.ts` | Websocket contract + drain tests |
| `packages/core/test/auth.test.ts` | cookie-session + JWT helper tests |
| `packages/cli/src/commands/tasks.ts` | `vura tasks run <name>` / `vura tasks list` |
| `packages/cli/src/templates/Dockerfile.hot` | Dockerfile template emitted by `vura build` for hot deployments |
| `packages/cli/src/templates/fly.toml.tmpl` | fly.toml template emitted by `vura build` for hot deployments |
| `packages/cli/test/tasks-command.test.ts` | CLI task runner tests |
| `packages/cli/test/deploy-templates.test.ts` | Dockerfile/fly.toml emission tests |

### Modified
| File | Change |
|---|---|
| `package.json` (root) | `what-core`/`what-framework` `^0.8.1` → `^0.11.1`; remove from root deps once moved into core package |
| `packages/core/package.json` | Add deps: `what-framework@^0.11.1`, `what-isr@^0.11.1`, `@celsian/core@^0.5.2`, `@celsian/jwt@^0.5.2`; `ws` as `peerDependenciesMeta` optional |
| `packages/core/src/static-render.ts` (~265 LOC) | Drop `builtinRenderToString` fallback (lines 48–57, 160–246); hard-import `renderToString` from `what-framework/server`; keep `wrapDocument`/`escapeHtml` |
| `packages/core/src/build.ts` (1,614 LOC) | Delete inline code-string constants (`RENDER_TO_STRING_CODE` 262–314, `WRAP_DOCUMENT_CODE` 316–323, `ISR_CACHE_CODE` 327–381, `TASK_RUNNER_CODE` 385–537, `MATCH_ROUTE_CODE`/`MATCH_PAGE_ROUTE_CODE` 154–215, `PARSE_BODY_CODE` 217–258, `VALIDATION_CODE` 623–650, `HOOKS_CODE` 654–723, `HANDLER_FINALIZATION_CODE` 725–745, `generateServerCode` 749–1065, `RENDER_PAGE_CODE` 1069–1106); `generateServerEntry` now emits a thin wiring module; `build()` esbuild-bundles it |
| `packages/core/src/manifest.ts` | `extractApiExports` additionally detects `export function websocket` (`hasWebsocket: boolean` on `ApiRoute`) and `export const schedule` (task schedule as export, not only route config) |
| `packages/core/src/config.ts` | Add `cache?: VuraCacheConfig` (store/dir/cdn/secret) to `ThenConfig` |
| `packages/core/src/index.ts` | Export runtime modules, `revalidatePath`/`revalidateTag`, auth helpers; remove exports of deleted modules |
| `packages/core/src/handler.ts` | Shrinks to deprecated type aliases re-exported from `compat.ts` |
| `packages/vite-plugin/src/index.ts` | Dev middleware for `/api/*` becomes `nodeToWebRequest → celsianApp.handle → writeWebResponse` (drops vura matchRoute/executeWithHooks usage) |
| `packages/cli/src/index.ts` | Register `tasks` command |
| `packages/cli/src/commands/build.ts` | Emit Dockerfile/fly.toml when manifest contains hot routes |
| `packages/core/test/server-entry-runtime.test.ts`, `server-pages.test.ts`, `smoke-build.test.ts`, `production-static-smoke.test.ts` | Updated assertions: generated entry is bundled; ISR headers come from what-isr (`x-what-cache` semantics replace `x-isr-cache`) |
| `packages/core/test/whatfw-integration.test.ts` | Updated for 0.11 API (verify `Island`, `definePage`, `renderToStream` signatures still hold) |

### Deleted (A1.4 / A2.6 audit — vura-core LOC must decrease from baseline 5,068)
| File | Replaced by |
|---|---|
| `packages/core/src/hooks.ts` (322 LOC) | celsian `addHook` lifecycle (`onRequest`/`preHandler`/`onError`/`onResponse`) |
| `packages/core/src/match.ts` (156 LOC) | celsian `Router` for API; `what-router/match` for pages |
| `packages/core/src/body-parser.ts` (70 LOC) | celsian body parsing (`buildRequest`/`body-parser.ts` in @celsian/core) |
| `packages/core/src/tasks.ts` (402 LOC, deleted in v0.4 Task 11) | celsian `CronScheduler`, `TaskRegistry`, `TaskWorker`, `MemoryQueue` |
| ~900 LOC of inline string constants in `build.ts` | `runtime/server.ts` + esbuild bundling |
| `builtinRenderToString` + `renderAttributes` in `static-render.ts` (~110 LOC) | `what-framework/server` `renderToString` |

---

## Tasks

### Task 1 — Bump to what-fw ^0.11.1 and make `renderToString` real (A1.1)

**Files:**
- Modify: `package.json` (root, lines with `what-core`/`what-framework`), `packages/core/package.json`, `packages/core/src/static-render.ts` (lines 48–57, 160–246)
- Test: `packages/core/test/static-render-whatfw.test.ts` (create), `packages/core/test/whatfw-integration.test.ts` (verify)

- [ ] Write the failing test `packages/core/test/static-render-whatfw.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { renderStaticPages } from '../src/static-render.js';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { h } from 'what-framework';

describe('static render uses real what-framework renderToString', () => {
  it('renders signal-bearing components with hydration-correct output', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'vura-sr-'));
    const pages = [{
      filePath: 'src/pages/index.tsx', urlPattern: '/', mode: 'static' as const,
      hasGetServerData: false, config: {},
    }];
    const loadModule = async () => ({
      default: () => h('div', { class: 'home' }, h('h1', null, 'Vura on What')),
      page: { title: 'Home' },
    });
    const results = await renderStaticPages(pages, loadModule, outDir);
    expect(results[0]!.html).toContain('<div class="home"><h1>Vura on What</h1></div>');
    const written = await readFile(join(outDir, 'static', 'index.html'), 'utf-8');
    expect(written).toContain('<title>Home</title>');
  });

  it('does not export builtinRenderToString anymore', async () => {
    const mod = await import('../src/static-render.js');
    expect((mod as Record<string, unknown>).builtinRenderToString).toBeUndefined();
  });
});
```

- [ ] Run `pnpm vitest run packages/core/test/static-render-whatfw.test.ts` — expect failure: second test fails (`builtinRenderToString` is still exported), and possibly the first if `what-framework@0.8.1` `h()` shape differs.
- [ ] In root `package.json`, change `"what-core": "^0.8.1"` → `"^0.11.1"` and `"what-framework": "^0.8.1"` → `"^0.11.1"`. Add to `packages/core/package.json` `dependencies`: `"what-framework": "^0.11.1"`, `"what-isr": "^0.11.1"`, `"@celsian/core": "^0.5.2"` (the latter two are consumed by Tasks 2–4; adding now avoids repeated installs). Run `pnpm install`.
- [ ] In `packages/core/src/static-render.ts`: delete the try/catch fallback (lines 48–57) and replace with a top-of-file static import `import { renderToString } from 'what-framework/server';`. Delete `builtinRenderToString`, `renderAttributes`, `camelToKebab`, `VOID_ELEMENTS` (lines 160–246, 257–264). Keep `wrapDocument`, `escapeHtml`, `DocumentOptions`.
- [ ] In `packages/core/src/index.ts` remove `builtinRenderToString` from the `static-render.js` export block.
- [ ] Run `pnpm vitest run packages/core/test/` — fix any 0.8→0.11 breakage surfaced by `whatfw-integration.test.ts` (it imports `renderToString, renderToStream, generateStaticPage, definePage, Island` — all still exported at 0.11.1 per `packages/server/src/index.js` lines 110/275/370/382). All core tests green.
- [ ] `git commit -m "feat(core): require what-framework ^0.11.1, drop builtin SSR fallback"` (+ Co-Authored-By trailer).

---

### Task 2 — Runtime pages module: what-fw `createRequestHandler` with injected vura renderer (A1.1)

**Files:**
- Create: `packages/core/src/runtime/pages.ts`
- Test: `packages/core/test/runtime-pages.test.ts`

The mapping (grounded in `what-fw/packages/server/src/adapter/core.js` and `what-fw/packages/router/src/match.js`):
- vura `PageRoute.urlPattern` uses `:param` (what-router compatible) and `*param` for catch-alls; what-router `compilePath` only understands a bare `*` segment or `[...]`/`*:name` — so convert `/*name` → `/*:name`.
- vura `mode: 'server'` without `revalidate` → what config `{ mode: 'server' }` (cache BYPASS, `Cache-Control: private, no-store` set by core.js line 202).
- vura `mode: 'server'` **with** `revalidate`/`tags` → what config `{ mode: 'static', revalidate, tags }` so `cache.handle()` applies HIT/STALE/MISS.
- `createRequestHandler`'s `render` option is the injection point (core.js line 106): we supply vura's page semantics (`getServerData`, layout chain, `wrapDocument`) and never use what-fw's `renderDocument`.

- [ ] Write failing test `packages/core/test/runtime-pages.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildWhatRoutes, createPagesHandler } from '../src/runtime/pages.js';
import { h } from 'what-framework';

const pageModule = {
  default: (props: { params: Record<string, string>; name?: string }) =>
    h('h1', null, `Hello ${props.name ?? props.params.slug}`),
  getServerData: async ({ params }: { params: Record<string, string> }) => ({ name: params.slug.toUpperCase() }),
  page: { title: 'Post' },
};

describe('buildWhatRoutes', () => {
  it('maps vura patterns and ISR config to what-router routes', () => {
    const routes = buildWhatRoutes([
      { urlPattern: '/blog/:slug', mode: 'server', config: { revalidate: 60, tags: 'blog' },
        filePath: 'src/pages/blog/[slug].tsx', hasGetServerData: true, module: pageModule, layouts: [] },
      { urlPattern: '/docs/*rest', mode: 'server', config: {},
        filePath: 'src/pages/docs/[...rest].tsx', hasGetServerData: false, module: pageModule, layouts: [] },
    ]);
    expect(routes[0]!.path).toBe('/blog/:slug');
    expect(routes[0]!.page).toEqual({ mode: 'static', revalidate: 60, tags: ['blog'] });
    expect(routes[1]!.path).toBe('/docs/*:rest');
    expect(routes[1]!.page).toEqual({ mode: 'server' });
  });
});

describe('createPagesHandler', () => {
  it('renders a server page through createRequestHandler with vura semantics', async () => {
    const handler = createPagesHandler({
      routes: buildWhatRoutes([
        { urlPattern: '/blog/:slug', mode: 'server', config: {},
          filePath: 'src/pages/blog/[slug].tsx', hasGetServerData: true, module: pageModule, layouts: [] },
      ]),
    });
    const res = await handler(new Request('http://localhost/blog/hi'));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<h1>Hello HI</h1>');     // getServerData ran
    expect(html).toContain('<title>Post</title>');   // wrapDocument ran
    expect(res.headers.get('cache-control')).toContain('no-store'); // server mode
  });

  it('returns 404 JSON-free HTML for unknown paths', async () => {
    const handler = createPagesHandler({ routes: [] });
    const res = await handler(new Request('http://localhost/nope'));
    expect(res.status).toBe(404);
  });
});
```

- [ ] Run it — fails (module does not exist).
- [ ] Implement `packages/core/src/runtime/pages.ts`:

```ts
import { createRequestHandler } from 'what-framework/server';
import { renderToString } from 'what-framework/server';
import { wrapDocument } from '../static-render.js';
import type { PageRoute } from '../manifest.js';

export interface RuntimePage extends PageRoute {
  module: { default: (props: any) => unknown; getServerData?: (ctx: any) => Promise<any> | any; page?: Record<string, any> };
  layoutModules?: Array<{ default: (props: any) => unknown }>;
}

export interface WhatPageRoute {
  path: string;
  page: { mode: 'server' | 'static'; revalidate?: number; tags?: string[]; swr?: number };
  vura: RuntimePage;
}

export function buildWhatRoutes(pages: RuntimePage[]): WhatPageRoute[] {
  return pages.map((p) => {
    const revalidate = typeof p.config.revalidate === 'number' ? p.config.revalidate : undefined;
    const tags = typeof p.config.tags === 'string' ? p.config.tags.split(',').map(t => t.trim()) : undefined;
    return {
      // what-router compilePath needs '*:name' for named catch-alls
      path: p.urlPattern.replace(/\*([A-Za-z0-9_]+)/g, '*:$1'),
      page: revalidate != null
        ? { mode: 'static', revalidate, ...(tags ? { tags } : {}), ...(typeof p.config.swr === 'number' ? { swr: p.config.swr } : {}) }
        : { mode: 'server' },
      vura: p,
    };
  });
}

/** Vura's render injected into createRequestHandler — replaces RENDER_PAGE_CODE. */
export function createVuraRenderRoute() {
  return async function renderRoute(routeMatch: any) {
    const { route, params, query, path } = routeMatch;
    const p: RuntimePage = route.vura;
    const mod = p.module;
    const pageConfig = mod.page ?? {};
    let serverData: Record<string, unknown> = {};
    if (typeof mod.getServerData === 'function') {
      serverData = await mod.getServerData({ params, url: path, query });
    }
    let vnode: unknown = mod.default({ ...serverData, params });
    const layouts = p.layoutModules ?? [];
    for (let i = layouts.length - 1; i >= 0; i--) {
      const Layout = layouts[i]!.default;
      if (typeof Layout === 'function') vnode = Layout({ children: vnode, params });
    }
    const html = wrapDocument(renderToString(vnode), {
      title: pageConfig.title ?? 'Vura App',
      meta: pageConfig.meta ?? [],
      styles: pageConfig.styles ?? [],
      scripts: pageConfig.scripts ?? [],
      head: pageConfig.head ?? '',
    });
    return { html, status: 200, tags: routeMatch.config?.tags ?? [], path };
  };
}

export interface PagesHandlerOptions {
  routes: WhatPageRoute[];
  cache?: unknown;                  // what-isr engine (Task 3)
  revalidateWebhook?: unknown;      // mounted separately at /__vura/revalidate (Task 4)
}

export function createPagesHandler(opts: PagesHandlerOptions): (req: Request) => Promise<Response> {
  return createRequestHandler({
    routes: opts.routes,
    cache: opts.cache,
    render: createVuraRenderRoute(),
    csrf: false, // vura API auth/session is celsian's concern; page forms post to /api
  });
}
```

- [ ] Run `pnpm vitest run packages/core/test/runtime-pages.test.ts` — green. If `routeMatch.config` vs `route.page` naming mismatches surface (core.js line 183 builds `config = route.page || {...}`), adjust `createVuraRenderRoute` to read `routeMatch.config`, not invent new fields.
- [ ] Export from `packages/core/src/index.ts`: `buildWhatRoutes`, `createVuraRenderRoute`, `createPagesHandler` and types.
- [ ] Full suite `pnpm vitest run` — green.
- [ ] `git commit -m "feat(core): pages runtime on what-fw createRequestHandler with injected vura renderer"`.

---

### Task 3 — what-isr integration: cache config, revalidate exports, webhook (A1.2)

**Files:**
- Create: `packages/core/src/runtime/cache.ts`
- Modify: `packages/core/src/config.ts` (add `VuraCacheConfig`), `packages/core/src/index.ts`
- Test: `packages/core/test/runtime-cache.test.ts`

- [ ] Write failing test `packages/core/test/runtime-cache.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createVuraCache } from '../src/runtime/cache.js';
import { revalidatePath, revalidateTag } from '../src/index.js';
import { setRevalidationHandler } from 'what-framework/server';

describe('createVuraCache', () => {
  it('builds a memory-store engine by default and serves HIT on second call', async () => {
    const { engine } = createVuraCache({});
    const routeMatch = { path: '/p', query: {}, config: { revalidate: 60 } };
    let renders = 0;
    const render = async () => { renders++; return { html: '<p>x</p>', status: 200, path: '/p' }; };
    const first = await engine.handle(routeMatch, render);
    const second = await engine.handle(routeMatch, render);
    expect(first.cacheStatus).toBe('MISS');
    expect(second.cacheStatus).toBe('HIT');
    expect(renders).toBe(1);
  });

  it('exposes a secret-guarded webhook', async () => {
    const { webhook } = createVuraCache({ revalidateSecret: 's3cret' });
    const denied = await webhook!({ headers: {}, body: { paths: ['/p'] } });
    expect(denied.status).toBe(401);
    const ok = await webhook!({ headers: { 'x-vura-revalidate-secret': 's3cret' }, body: { paths: ['/p'] } });
    expect(ok.status).toBe(200);
  });

  it('binds vura-core revalidateTag/revalidatePath to the engine', async () => {
    const purged: string[] = [];
    setRevalidationHandler({
      revalidatePath: async (p: string) => { purged.push(p); },
      revalidateTag: async (t: string) => { purged.push(`tag:${t}`); },
    });
    await revalidatePath('/blog/a');
    await revalidateTag('blog');
    expect(purged).toEqual(['/blog/a', 'tag:blog']);
  });
});
```

- [ ] Run — fails. Implement `packages/core/src/runtime/cache.ts`:

```ts
import {
  createCacheEngine, createMemoryStore, createFilesystemStore, createRedisStore,
  createRevalidateWebhook, createCloudflareCDN, createFastlyCDN,
} from 'what-isr';
import { setRevalidationHandler } from 'what-framework/server';

export interface VuraCacheConfig {
  store?: 'memory' | 'filesystem' | 'redis';
  /** filesystem store directory (default: .vura/cache) */
  dir?: string;
  /** redis client instance (vura does not own the connection) */
  redisClient?: unknown;
  maxEntries?: number;
  /** shared secret for POST /__vura/revalidate */
  revalidateSecret?: string;
  cdn?: { provider: 'cloudflare'; zoneId: string; apiToken: string }
     | { provider: 'fastly'; serviceId: string; apiToken: string };
}

export function createVuraCache(config: VuraCacheConfig) {
  const store =
    config.store === 'filesystem' ? createFilesystemStore({ dir: config.dir ?? '.vura/cache' })
    : config.store === 'redis' ? createRedisStore({ client: config.redisClient })
    : createMemoryStore({ maxEntries: config.maxEntries ?? 1000 });

  const cdn = config.cdn?.provider === 'cloudflare'
    ? createCloudflareCDN({ zoneId: config.cdn.zoneId, apiToken: config.cdn.apiToken })
    : config.cdn?.provider === 'fastly'
      ? createFastlyCDN({ serviceId: config.cdn.serviceId, apiToken: config.cdn.apiToken })
      : undefined;

  const engine = createCacheEngine({ store, cdn });

  // app code: import { revalidatePath, revalidateTag } from '@celsian/vura-core'
  setRevalidationHandler({ revalidatePath: engine.revalidatePath, revalidateTag: engine.revalidateTag });

  const webhook = config.revalidateSecret
    ? createRevalidateWebhook(engine, { secret: config.revalidateSecret, header: 'x-vura-revalidate-secret' })
    : undefined;

  return { engine, webhook, store };
}
```

- [ ] In `packages/core/src/config.ts` add to `ThenConfig`: `cache?: import('./runtime/cache.js').VuraCacheConfig;`.
- [ ] In `packages/core/src/index.ts` add: `export { createVuraCache } from './runtime/cache.js'; export type { VuraCacheConfig } from './runtime/cache.js'; export { revalidatePath, revalidateTag } from 'what-framework/server';`.
- [ ] Run test file → green; full suite → green.
- [ ] `git commit -m "feat(core): what-isr cache engine, revalidateTag/Path exports, revalidation webhook (A1.2)"`.

---

### Task 4 — Celsian API app + ThenRequest/ThenReply compat layer (A1.3)

**Files:**
- Create: `packages/core/src/runtime/api-app.ts`, `packages/core/src/compat.ts`
- Modify: `packages/core/src/handler.ts` (shrink to deprecated aliases)
- Test: `packages/core/test/runtime-api-app.test.ts`

**Compat decision (justified):** `CelsianReply` is a strict superset of `ThenReply` (`status/header/json/send/redirect` all exist with identical chaining — `celsian/packages/core/src/types.ts` lines 56–89). `CelsianRequest` differs in three places: `req.url` is the full URL (it extends Web `Request`), `req.headers` is a `Headers` object not a plain record, and `req.body` is the raw stream not the parsed body (celsian's parsed body is `req.parsedBody`). So the cheap path is: **keep handlers `(req, reply)`-shaped, register them directly on CelsianApp, and patch only those three deltas with a ~40-line per-request shim** rather than maintaining vura's own 600-line request pipeline. `ThenRequest`/`ThenReply` types become deprecated aliases; vura v0.4 docs tell users to use celsian types. This deletes `hooks.ts`, `match.ts`, `body-parser.ts` outright (Task 7).

- [ ] Write failing test `packages/core/test/runtime-api-app.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createApiApp } from '../src/runtime/api-app.js';

const userRoute = {
  urlPattern: '/api/users/:id', methods: ['GET', 'POST'] as const, kind: 'serverless' as const,
  filePath: 'src/api/users/[id].ts', config: {},
  module: {
    GET: async (req: any, reply: any) => reply.json({ id: req.params.id, q: req.query.v ?? null }),
    POST: async (req: any, reply: any) => reply.status(201).json({ got: req.body }),
  },
};

describe('createApiApp', () => {
  it('registers manifest routes onto a CelsianApp and serves them', async () => {
    const app = createApiApp({ routes: [userRoute as any] });
    const res = await app.handle(new Request('http://localhost/api/users/42?v=1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: '42', q: '1' });
  });

  it('compat: req.body aliases parsedBody and req.headers is index-readable', async () => {
    const app = createApiApp({ routes: [userRoute as any] });
    const res = await app.handle(new Request('http://localhost/api/users/42', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ a: 1 }),
    }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ got: { a: 1 } });
  });

  it('mounts the revalidation webhook at /__vura/revalidate', async () => {
    const webhook = async () => ({ status: 200, body: { revalidated: true } });
    const app = createApiApp({ routes: [], revalidateWebhook: webhook });
    const res = await app.handle(new Request('http://localhost/__vura/revalidate', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paths: ['/x'] }),
    }));
    expect(res.status).toBe(200);
  });

  it('maps global hooks file exports onto celsian hooks', async () => {
    const seen: string[] = [];
    const app = createApiApp({
      routes: [userRoute as any],
      globalHooks: { onRequest: [async (req: any) => { seen.push(new URL(req.url).pathname); }] },
    });
    await app.handle(new Request('http://localhost/api/users/1'));
    expect(seen).toEqual(['/api/users/1']);
  });
});
```

- [ ] Run — fails. Implement `packages/core/src/compat.ts`:

```ts
import type { CelsianRequest, CelsianReply } from '@celsian/core';

/** @deprecated Use CelsianRequest from @celsian/core. Removed in vura v0.5. */
export type ThenRequest = CelsianRequest & {
  body?: unknown;
  validated?: { body: unknown; query: unknown; params: unknown };
};
/** @deprecated Use CelsianReply from @celsian/core. */
export type ThenReply = CelsianReply;
/** @deprecated */
export type ThenHandler = (req: ThenRequest, reply: ThenReply) => unknown | Promise<unknown>;

/** Patch the three ThenRequest deltas onto a CelsianRequest (in place, per request). */
export function applyThenCompat(req: CelsianRequest): ThenRequest {
  const r = req as ThenRequest;
  if (r.body === undefined || typeof (r.body as any)?.getReader === 'function') {
    Object.defineProperty(r, 'body', { get: () => r.parsedBody, configurable: true });
  }
  return r;
}
```

- [ ] Implement `packages/core/src/runtime/api-app.ts`:

```ts
import { createApp, type CelsianApp, type CelsianRequest, type CelsianReply } from '@celsian/core';
import { applyThenCompat } from '../compat.js';
import type { ApiRoute, HttpMethod } from '../manifest.js';

export interface RuntimeApiRoute extends ApiRoute {
  module: Record<string, unknown>; // GET/POST/... handlers, optional schema/hooks exports
}

export interface GlobalHooks {
  onRequest?: Array<(req: CelsianRequest, reply: CelsianReply) => unknown>;
  onError?: Array<(err: unknown, req: CelsianRequest, reply: CelsianReply) => unknown>;
  onResponse?: Array<(req: CelsianRequest, reply: CelsianReply) => unknown>;
}

export interface ApiAppOptions {
  routes: RuntimeApiRoute[];
  globalHooks?: GlobalHooks;
  revalidateWebhook?: (reqLike: { headers: Record<string, string>; body: unknown }) => Promise<{ status: number; body: unknown }>;
}

const METHOD_REGISTRARS: Record<HttpMethod, 'get' | 'post' | 'put' | 'delete' | 'patch' | 'head' | 'options'> = {
  GET: 'get', POST: 'post', PUT: 'put', DELETE: 'delete', PATCH: 'patch', HEAD: 'head', OPTIONS: 'options',
};

export function createApiApp(opts: ApiAppOptions): CelsianApp {
  const app = createApp({ logger: false });

  for (const fn of opts.globalHooks?.onRequest ?? []) app.addHook('onRequest', fn as any);
  for (const fn of opts.globalHooks?.onError ?? []) app.addHook('onError', fn as any);
  for (const fn of opts.globalHooks?.onResponse ?? []) app.addHook('onResponse', fn as any);

  for (const route of opts.routes) {
    if (route.kind === 'task') continue; // tasks are not HTTP routes (Task 11)
    const schema = route.module.schema as Record<string, unknown> | undefined;
    for (const method of route.methods) {
      const handler = route.module[method];
      if (typeof handler !== 'function') continue;
      const wrapped = (req: CelsianRequest, reply: CelsianReply) =>
        (handler as Function)(applyThenCompat(req), reply);
      // celsian options-object signature: app.post(url, { schema, handler })
      (app as any)[METHOD_REGISTRARS[method]](route.urlPattern,
        schema ? { schema, handler: wrapped } : wrapped);
    }
  }

  if (opts.revalidateWebhook) {
    app.post('/__vura/revalidate', async (req, reply) => {
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
      const out = await opts.revalidateWebhook!({ headers, body: req.parsedBody });
      return reply.status(out.status).json(out.body);
    });
  }

  return app;
}
```

- [ ] Shrink `packages/core/src/handler.ts` to `export type { ThenRequest, ThenReply, ThenHandler } from './compat.js';` (keep `finalizeNodeHandlerResult` only if Task 5 still needs it — it will not; delete it there). Update `index.ts` exports accordingly.
- [ ] Run test file → green. Note: if celsian's schema validation contract differs from vura's `defineSchema` Zod-like shape, verify against `celsian/packages/core/src/app.ts` line 280 (options-object) and `validation` handling; adapt the `schema` pass-through (celsian uses Zod-compatible `safeParse` too — confirm by reading `@celsian/core` body-parser/router validation path before wiring).
- [ ] Full suite → green (dev/vite-plugin still uses old modules until Task 6 — they still exist).
- [ ] `git commit -m "feat(core): celsian-backed API app with ThenRequest compat shim and /__vura/revalidate (A1.3)"`.

---

### Task 5 — `startVuraServer` runtime + thin generated entry + esbuild bundling (A1.1 + A1.3)

**Files:**
- Create: `packages/core/src/runtime/server.ts`
- Modify: `packages/core/src/build.ts` — `generateServerEntry` (lines 1118–1293) rewritten; `build()` (lines 1432–1518) bundles the entry; delete `generateServerCode` and all inline `*_CODE` constants listed in File Structure
- Test: `packages/core/test/runtime-server.test.ts` (create), `packages/core/test/server-entry-runtime.test.ts` + `server-pages.test.ts` + `smoke-build.test.ts` (update)

- [ ] Write failing test `packages/core/test/runtime-server.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { startVuraServer, type VuraServer } from '../src/runtime/server.js';
import { h } from 'what-framework';

let srv: VuraServer | undefined;
afterEach(async () => { await srv?.close(); });

const base = () => `http://127.0.0.1:${srv!.port}`;

describe('startVuraServer', () => {
  it('composes api + pages + health on one port', async () => {
    srv = await startVuraServer({
      port: 0,
      apiRoutes: [{
        urlPattern: '/api/ping', methods: ['GET'], kind: 'serverless', filePath: 'src/api/ping.ts',
        config: {}, module: { GET: async (_req: any, reply: any) => reply.json({ pong: true }) },
      }],
      pages: [{
        urlPattern: '/hello/:name', mode: 'server', filePath: 'src/pages/hello/[name].tsx',
        hasGetServerData: false, config: {},
        module: { default: (p: any) => h('h1', null, `Hi ${p.params.name}`), page: { title: 'Hi' } },
      }],
      cache: {},
    });
    expect((await (await fetch(`${base()}/__health`)).json()).ok).toBe(true);
    expect(await (await fetch(`${base()}/api/ping`)).json()).toEqual({ pong: true });
    const html = await (await fetch(`${base()}/hello/kirby`)).text();
    expect(html).toContain('<h1>Hi kirby</h1>');
  });

  it('ISR: revalidate pages serve HIT on repeat and purge via /__vura/revalidate', async () => {
    let renders = 0;
    srv = await startVuraServer({
      port: 0, apiRoutes: [],
      pages: [{
        urlPattern: '/cached', mode: 'server', filePath: 'src/pages/cached.tsx',
        hasGetServerData: false, config: { revalidate: 300 },
        module: { default: () => { renders++; return h('p', null, `render ${renders}`); } },
      }],
      cache: { revalidateSecret: 'sek' },
    });
    await fetch(`${base()}/cached`);
    await fetch(`${base()}/cached`);
    expect(renders).toBe(1);
    const purge = await fetch(`${base()}/__vura/revalidate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-vura-revalidate-secret': 'sek' },
      body: JSON.stringify({ paths: ['/cached'] }),
    });
    expect(purge.status).toBe(200);
    await fetch(`${base()}/cached`);
    expect(renders).toBe(2);
  });
});
```

- [ ] Run — fails. Implement `packages/core/src/runtime/server.ts`:

```ts
import { createServer as createHttpServer, type Server } from 'node:http';
import { nodeToWebRequest, writeWebResponse } from '@celsian/core';
import { createApiApp, type RuntimeApiRoute, type GlobalHooks } from './api-app.js';
import { buildWhatRoutes, createPagesHandler, type RuntimePage } from './pages.js';
import { createVuraCache, type VuraCacheConfig } from './cache.js';

export interface VuraServerOptions {
  port?: number;
  apiRoutes: RuntimeApiRoute[];
  pages: RuntimePage[];
  cache?: VuraCacheConfig;
  globalHooks?: GlobalHooks;
  staticDirs?: string[];           // dist/static, public — served before pages
  shutdownTimeoutMs?: number;
}

export interface VuraServer {
  server: Server;
  port: number;
  close(): Promise<void>;
}

export async function startVuraServer(opts: VuraServerOptions): Promise<VuraServer> {
  const { engine, webhook } = createVuraCache(opts.cache ?? {});
  const app = createApiApp({ routes: opts.apiRoutes, globalHooks: opts.globalHooks, revalidateWebhook: webhook });
  const serverPages = opts.pages.filter(p => p.mode === 'server' || p.mode === 'hybrid');
  const pagesHandler = createPagesHandler({ routes: buildWhatRoutes(serverPages), cache: engine });

  let inFlight = 0;
  let shuttingDown = false;

  const server = createHttpServer(async (nodeReq, nodeRes) => {
    if (shuttingDown) {
      nodeRes.writeHead(503, { 'content-type': 'application/json', connection: 'close' });
      nodeRes.end(JSON.stringify({ error: 'Service shutting down' }));
      return;
    }
    inFlight++;
    nodeRes.on('close', () => { inFlight--; });
    const url = new URL(nodeReq.url ?? '/', `http://${nodeReq.headers.host ?? 'localhost'}`);

    if (url.pathname === '/__health') {
      nodeRes.writeHead(200, { 'content-type': 'application/json' });
      nodeRes.end(JSON.stringify({ ok: true, framework: 'Vura' }));
      return;
    }
    // static files (public/ then dist/static) — reuse the existing resolver,
    // moved verbatim from build.ts STATIC_FILE_CODE into a real function here
    if (serveStaticIfFound(opts.staticDirs ?? [], url.pathname, nodeReq.method ?? 'GET', nodeRes)) return;

    const webReq = nodeToWebRequest(nodeReq, url);
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/__vura/')) {
      await writeWebResponse(nodeRes, await app.handle(webReq));
      return;
    }
    await writeWebResponse(nodeRes, await pagesHandler(webReq));
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 3000, resolve));
  const port = (server.address() as { port: number }).port;

  const close = () => new Promise<void>((resolve) => { shuttingDown = true; server.close(() => resolve()); });
  const drain = (signal: string) => {
    shuttingDown = true;
    server.close(() => process.exit(0));
    const force = setTimeout(() => process.exit(1), opts.shutdownTimeoutMs ?? 30000);
    force.unref?.();
    const poll = setInterval(() => { if (inFlight <= 0) { clearInterval(poll); clearTimeout(force); process.exit(0); } }, 100);
    poll.unref?.();
  };
  process.once('SIGTERM', () => drain('SIGTERM'));
  process.once('SIGINT', () => drain('SIGINT'));

  return { server, port, close };
}
```

  (`serveStaticIfFound` is the existing `_tryResolveStaticFile`/`_sendStaticFile` logic from `build.ts` lines 541–619, converted from string constant to real code in this file — same symlink-realpath traversal guard, same MIME table.)
- [ ] Run `runtime-server.test.ts` → green.
- [ ] Rewrite `generateServerEntry` in `build.ts` to emit a **thin wiring file** (keep the import-path computation from lines 1139–1186 verbatim):

```ts
export function generateServerEntry(manifest: RouteManifest, projectRoot: string, globalHooksFile?: string | null): string {
  const lines: string[] = [];
  lines.push(`import { startVuraServer } from '@celsian/vura-core';`);
  // ... existing per-route/per-page/per-layout import lines (unchanged logic) ...
  lines.push(`await startVuraServer({`);
  lines.push(`  port: parseInt(process.env.PORT || '3000', 10),`);
  lines.push(`  apiRoutes: [${/* { ...routeMeta, module: varName } per api route */''}],`);
  lines.push(`  pages: [${/* { ...pageMeta, module: varName, layoutModules: [...] } per server/hybrid page */''}],`);
  lines.push(`  cache: ${JSON.stringify(extractCacheConfig(manifest))},`);
  lines.push(`  staticDirs: [new URL('../public', import.meta.url).pathname, new URL('../static', import.meta.url).pathname],`);
  globalHooksFile && lines.push(`  globalHooks: _globalHooksMod,`);
  lines.push(`});`);
  return lines.join('\n');
}
```

  In `build()`, after writing `entry.source.mjs`, bundle it self-contained: `esbuild({ entryPoints: [sourcePath], bundle: true, format: 'esm', platform: 'node', target: 'node20', outfile: join(serverDir, 'entry.js'), external: ['ws'], plugins: [vuraCoreSelfResolvePlugin()] })` — `@celsian/vura-core`, `@celsian/core`, `what-framework`, `what-isr` are all bundled in; only `ws` stays external (optional, hot routes). The `vura.config` cache block is threaded into the manifest by the CLI build command (`extractCacheConfig` reads `config.cache` serialized into `manifest` by `buildCommand` — env-var secrets stay as `process.env.VURA_REVALIDATE_SECRET` references, never inlined).
- [ ] Update `packages/core/test/server-entry-runtime.test.ts` and `server-pages.test.ts`: assertions on generated-source strings (e.g. expecting `function renderToString`) become behavioral assertions — build a fixture project, run the bundled `dist/server/entry.js` as a child process, hit it over HTTP (these tests already spawn the entry; keep that harness, update expected headers: ISR header is now `x-what-cache`-style from what-isr's `buildCacheHeaders` — assert on observed header name from a first run, deliberately).
- [ ] `pnpm vitest run` — all green (149 core tests passing or deliberately updated; record each updated assertion in the commit body).
- [ ] `git commit -m "feat(core): real runtime server module; generated entry is thin wiring bundled by esbuild"`.

---

### Task 6 — Dev server on celsian (A1.3)

**Files:**
- Modify: `packages/vite-plugin/src/index.ts` (lines ~14–33 imports, ~201–290 middleware) and `packages/cli/src/commands/dev.ts` (mirror the same middleware usage)
- Test: `packages/vite-plugin/test/task-auth.test.ts` (verify), plus new `packages/vite-plugin/test/dev-api-celsian.test.ts`

- [ ] Write failing test `packages/vite-plugin/test/dev-api-celsian.test.ts` that constructs the plugin's API middleware against a fixture manifest with one `/api/echo` route (`POST` echoes `req.body`) and asserts a JSON round-trip plus that a celsian `onRequest` hook from `src/api/_hooks.ts` fires (reuse the fixture-project pattern from the existing vite-plugin test).
- [ ] Run — fails.
- [ ] Replace the dev middleware internals: build a `createApiApp({ routes, globalHooks })` once per manifest scan (rebuild on file change, as the plugin already does for `matchRoute` tables) and route matched requests via:

```ts
import { nodeToWebRequest, writeWebResponse } from '@celsian/core';
// inside the connect middleware, when url.pathname starts with /api/:
const webReq = nodeToWebRequest(req, url);
const webRes = await apiApp.handle(webReq);
if (webRes.status === 404) return next();
await writeWebResponse(res, webRes);
```

  Delete the plugin's imports of `matchRoute`, `executeWithHooks`, `ThenRequest` construction (lines 201–290).
- [ ] Apply the same replacement in `packages/cli/src/commands/dev.ts` (561 LOC — its API path mirrors the plugin).
- [ ] `pnpm vitest run packages/vite-plugin packages/cli` → green; full suite green.
- [ ] `git commit -m "feat(dev): dev API middleware served by CelsianApp.handle"`.

---

### Task 7 — Code deletion audit (A1.4)

**Files:**
- Delete: `packages/core/src/hooks.ts`, `packages/core/src/match.ts`, `packages/core/src/body-parser.ts`, plus the already-orphaned `*_CODE` constants and `generateServerCode`/`RENDER_PAGE_CODE`/`generateFunctionEntry`'s duplicated shims still referencing deleted helpers in `build.ts`
- Modify: `packages/core/src/index.ts` (remove dead export blocks: hooks, match, body-parser, `builtinRenderToString`, `finalizeNodeHandlerResult`), `packages/core/src/build.ts` (`vuraCoreSelfResolvePlugin` shim list at lines 55–60 must drop `hooks` exports), delete corresponding test files `hooks.test.ts`, `match.test.ts`
- Test: `packages/core/test/loc-budget.test.ts` (create)

- [ ] Record baseline: `git show HEAD~6:packages/core/src | true` — the locked baseline is **5,068 LOC** (`wc -l packages/core/src/*.ts` at v0.2.0).
- [ ] Write `packages/core/test/loc-budget.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function locOf(dir: string): number {
  let total = 0;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) total += locOf(p);
    else if (e.endsWith('.ts')) total += readFileSync(p, 'utf-8').split('\n').length;
  }
  return total;
}

describe('A1.4 success metric', () => {
  it('vura-core src LOC is below the v0.2.0 baseline of 5068', () => {
    expect(locOf(join(__dirname, '..', 'src'))).toBeLessThan(5068);
  });
});
```

- [ ] Run — should already pass if Tasks 1–6 deleted enough; if not, it fails and drives the deletions below.
- [ ] Delete `hooks.ts`, `match.ts`, `body-parser.ts` and their export blocks in `index.ts`. `grep -rn "from './hooks\|from './match\|from './body-parser" packages` must return nothing (vite-plugin/cli were migrated in Task 6; `generateFunctionEntry`'s serverless shim at build.ts lines 1301–1357 is standalone string code and keeps working — leave it, it has no imports).
- [ ] Delete `packages/core/test/hooks.test.ts` and `packages/core/test/match.test.ts`; keep `validation.test.ts` (validation.ts survives — serverless function entries still use it and celsian schema pass-through references its types).
- [ ] `pnpm run build && pnpm vitest run` → green, LOC test passes.
- [ ] `git commit -m "chore(core): A1.4 deletion audit — remove hooks/match/body-parser and codegen constants (-~1500 LOC)"`.

---

### Task 8 — Ship vura v0.3.0

**Files:**
- Modify: every `packages/*/package.json` version `0.2.0` → `0.3.0`; `CHANGELOG.md` entries; `packages/create-vura` template `package.json` deps
- Test: existing `scripts/release-check.mjs`, `scripts/verify-publish.mjs`

- [ ] Bump all workspace package versions to `0.3.0` and inter-package deps (`@celsian/vura-core` etc.) to `^0.3.0`.
- [ ] Write CHANGELOG entries: what-fw 0.11 rebase, what-isr ISR with tags + webhook + CDN purge, celsian API layer, ThenRequest/ThenReply deprecation note with migration snippet (`req.body` → `req.parsedBody`, `req.headers['x']` → `req.headers.get('x')`, `req.url` → `new URL(req.url).pathname`).
- [ ] Run `pnpm run check && pnpm vitest run && pnpm run release:check` — all green.
- [ ] `git commit -m "release: vura v0.3.0 — rebased on what-fw 0.11 + what-isr + celsian"`. Tag/publish per repo release process (NPM classic automation token per memory note).

---

### Task 9 — Hot routes: websocket contract + upgrade wiring + drain (A2.5)

**Files:**
- Create: `packages/core/src/runtime/hot.ts`
- Modify: `packages/core/src/manifest.ts` (`extractApiExports` + `ApiRoute.hasWebsocket`), `packages/core/src/runtime/server.ts` (upgrade wiring + WS drain), `packages/core/package.json` (`"peerDependencies": { "ws": "^8" }`, `peerDependenciesMeta.ws.optional: true`; add `ws` to root devDependencies for tests)
- Test: `packages/core/test/hot-routes.test.ts`

**Contract (documented in code + README):** a `kind: 'hot'` API route may `export function websocket(peer, req)`. It is called once per connection on open; `peer` is `{ id, send(data), close(code?, reason?), on('message'|'close', cb), broadcast(data) }`; state lives in module scope and is **per-process** (no cross-instance fan-out — that is celsian `ws-redis` territory, out of scope).

- [ ] Write failing test `packages/core/test/hot-routes.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { startVuraServer, type VuraServer } from '../src/runtime/server.js';
import { extractApiExports } from '../src/manifest.js';
import WebSocket from 'ws';

let srv: VuraServer | undefined;
afterEach(async () => { await srv?.close(); });

describe('manifest websocket detection', () => {
  it('flags hasWebsocket on hot routes exporting websocket()', () => {
    const src = `export const route = { kind: 'hot' };\nexport function websocket(peer, req) {}`;
    const out = extractApiExports(src);
    expect(out.kind).toBe('hot');
    expect(out.hasWebsocket).toBe(true);
  });
});

describe('hot route websockets', () => {
  it('upgrades, echoes, and closes on drain', async () => {
    srv = await startVuraServer({
      port: 0,
      apiRoutes: [{
        urlPattern: '/api/chat', methods: [], kind: 'hot', hasWebsocket: true,
        filePath: 'src/api/chat.ts', config: {},
        module: {
          websocket: (peer: any) => {
            peer.on('message', (data: string) => peer.send(`echo:${data}`));
          },
        },
      }],
      pages: [],
    });
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/api/chat`);
    const reply = await new Promise<string>((resolve) => {
      ws.on('open', () => ws.send('hi'));
      ws.on('message', (d) => resolve(d.toString()));
    });
    expect(reply).toBe('echo:hi');
    const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
    await srv.closeWebSockets(1001, 'shutting down'); // exposed for tests; SIGTERM path calls it
    expect(await closed).toBe(1001);
  });
});
```

- [ ] Run — fails.
- [ ] In `manifest.ts` `extractApiExports` (after the methods loop at line 97) add `const hasWebsocket = /export\s+(?:async\s+)?(?:function\s+websocket\b|const\s+websocket\s*=)/.test(source);` and return it; add `hasWebsocket?: boolean` to `ApiRoute` and set it in `buildManifest` (line 334 block). Also: a file exporting only `websocket` (no HTTP methods) must NOT be skipped by the `methods.length === 0` guard at line 332 when `kind === 'hot' && hasWebsocket`.
- [ ] Implement `packages/core/src/runtime/hot.ts` — adapter from the `websocket(peer, req)` export to celsian's `WSHandler`:

```ts
import { type WSHandler, type WSConnection, WSRegistry } from '@celsian/core';

export type VuraPeer = WSConnection & {
  on(event: 'message', cb: (data: string | ArrayBuffer) => void): void;
  on(event: 'close', cb: (code: number, reason: string) => void): void;
  broadcast(data: string | ArrayBuffer): void;
};

export type VuraWebsocketHandler = (peer: VuraPeer, req: Request) => void | Promise<void>;

/** Adapt vura's single-function contract to celsian's open/message/close handler. */
export function toWSHandler(path: string, fn: VuraWebsocketHandler, registry: WSRegistry): WSHandler {
  return {
    open(ws, req) {
      const listeners = { message: [] as Function[], close: [] as Function[] };
      const peer = Object.assign(ws, {
        on(event: 'message' | 'close', cb: Function) { listeners[event].push(cb); },
        broadcast: (data: string | ArrayBuffer) => registry.broadcast(path, data, ws.id),
      }) as VuraPeer;
      ws.metadata.__vuraListeners = listeners;
      void fn(peer, req as unknown as Request);
    },
    message(ws, data) {
      for (const cb of (ws.metadata.__vuraListeners as any)?.message ?? []) cb(data);
    },
    close(ws, code, reason) {
      for (const cb of (ws.metadata.__vuraListeners as any)?.close ?? []) cb(code, reason);
    },
  };
}
```

- [ ] In `runtime/server.ts`: when any `apiRoutes` entry has `hasWebsocket`, register `app.ws(route.urlPattern, toWSHandler(route.urlPattern, route.module.websocket, app.wsRegistry))` and wire the Node `upgrade` event — replicate celsian's own `serve.ts` lines 209–280 pattern (dynamic `import('ws')`, `WebSocketServer({ noServer: true })`, `server.on('upgrade', ...)` matching `app.wsRegistry.getHandler(pathname)`, `createWSConnection` wrapper, `addConnection`/`removeConnection`; if `ws` is not installed, log celsian's same actionable warning and skip). Track open connections in a `Set`; add `closeWebSockets(code, reason)` to `VuraServer` and call it first inside the SIGTERM `drain()` (close code 1001 "going away") before `server.close()`.
- [ ] Run `pnpm vitest run packages/core/test/hot-routes.test.ts` → green; full suite green.
- [ ] `git commit -m "feat(core): real hot routes — websocket(peer, req) contract over celsian WSRegistry with graceful drain (A2.5)"`.

---

### Task 10 — `vura build` emits hot deploy templates (A2.5)

**Files:**
- Create: `packages/cli/src/templates/Dockerfile.hot`, `packages/cli/src/templates/fly.toml.tmpl`
- Modify: `packages/cli/src/commands/build.ts` (after core `build()` returns, emit templates when `manifest.api.some(r => r.kind === 'hot')`)
- Test: `packages/cli/test/deploy-templates.test.ts`

- [ ] Write failing test asserting that building a fixture project containing one `kind:'hot'` route produces `dist/Dockerfile` and `dist/fly.toml`, that the Dockerfile `CMD` is `["node", "server/entry.js"]`, exposes `PORT`, and that fly.toml contains `kill_signal = "SIGTERM"` and an `http_service` with `internal_port = 3000`; and that a serverless-only fixture emits neither file.
- [ ] Run — fails.
- [ ] `Dockerfile.hot` (entry is self-contained from Task 5; only `ws` needs installing):

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY dist/ ./
RUN if [ -f package.json ]; then npm install --omit=dev; fi
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["node", "server/entry.js"]
```

- [ ] `fly.toml.tmpl` with `{{APP_NAME}}` placeholder, `kill_signal = "SIGTERM"`, `kill_timeout = "30s"` (matches the 30s drain default), `[http_service] internal_port = 3000, force_https = true, auto_stop_machines = false` (hot routes hold websocket state — document why autostop is off in a comment).
- [ ] In `build.ts` command: when hot routes exist, copy templates into `dist/` (replace `{{APP_NAME}}` with `basename(projectRoot)`) and write `dist/package.json` `{ "type": "module", "dependencies": { "ws": "^8.18.0" } }` only when a hot route `hasWebsocket`.
- [ ] Tests green; full suite green.
- [ ] `git commit -m "feat(cli): vura build emits Dockerfile + fly.toml for hot routes"`.

---

### Task 11 — Task routes on celsian cron/worker; delete vura tasks.ts (A2.6)

**Files:**
- Modify: `packages/core/src/manifest.ts` (detect `export const schedule = '...'` as first-class task schedule), `packages/core/src/runtime/server.ts` (task wiring), `packages/core/src/index.ts`
- Delete: `packages/core/src/tasks.ts`, `packages/core/test/tasks.test.ts`
- Test: `packages/core/test/runtime-tasks.test.ts` (create)

Task contract (kept compatible with v0.2 docs, `tasks.ts` header lines 12–15): `export const route = { kind: 'task', retries: 3, timeout: 30000 }` + `export async function POST(job)`; schedule comes from either `route.schedule` (existing) or the new `export const schedule = '*/5 * * * *'`.

- [ ] Write failing test `packages/core/test/runtime-tasks.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { startVuraServer, runTaskOnce, type VuraServer } from '../src/runtime/server.js';

let srv: VuraServer | undefined;
afterEach(async () => { await srv?.close(); });

describe('task routes via celsian', () => {
  it('registers schedule export as app.cron and exposes /__tasks status', async () => {
    srv = await startVuraServer({
      port: 0, pages: [],
      apiRoutes: [{
        urlPattern: '/api/cleanup', methods: ['POST'], kind: 'task', filePath: 'src/api/cleanup.ts',
        config: { retries: 1, timeout: 5000 },
        module: { schedule: '0 3 * * *', POST: async () => ({ cleaned: true }) },
      }],
    });
    const res = await fetch(`http://127.0.0.1:${srv.port}/__tasks`, {
      headers: { authorization: `Bearer ${process.env.THEN_TASK_SECRET ?? ''}` },
    });
    // localhost + NODE_ENV=test path stays authorized without a secret (existing contract)
    const body = await res.json();
    expect(body.tasks).toEqual([{ name: 'cleanup', schedule: '0 3 * * *' }]);
  });

  it('runTaskOnce enforces retry/timeout config', async () => {
    let attempts = 0;
    const result = await runTaskOnce({
      name: 'flaky', config: { retries: 2, timeout: 1000 },
      handler: async ({ attempt }) => { attempts++; if (attempt < 2) throw new Error('boom'); return { ok: true }; },
    }, { input: null });
    expect(attempts).toBe(2);
    expect(result.status).toBe('completed');
    const timedOut = await runTaskOnce({
      name: 'slow', config: { retries: 0, timeout: 50 },
      handler: () => new Promise((r) => setTimeout(() => r('late'), 5000)),
    }, { input: null });
    expect(timedOut.status).toBe('failed');
    expect(timedOut.error).toMatch(/timeout/i);
  });
});
```

- [ ] Run — fails.
- [ ] In `manifest.ts`, add detection in `extractApiExports`: `const scheduleMatch = source.match(/export\s+const\s+schedule\s*=\s*['"]([^'"]+)['"]/);` → `if (scheduleMatch) config.schedule = scheduleMatch[1];` (route-config `schedule` still wins if both present — keep deterministic: route config overrides export).
- [ ] In `runtime/server.ts`, implement `runTaskOnce(def, { input })` — retry loop (attempts = `1 + retries`, exponential backoff `100 * 2^attempt` ms) around `Promise.race` with timeout, returning `{ status: 'completed'|'failed', result?, error?, attempts }`. Wire task routes: for each `kind:'task'` route with a schedule, register `app.cron(taskName, schedule, () => runTaskOnce(def, { input: { _cron: true } }))` and call `app.startCron()` after registration (celsian `app.cron` per `app.ts` lines 426–435). Keep the `/__tasks` admin endpoints as celsian routes on the same app (`GET /__tasks`, `POST /__tasks/:name`, `GET /__tasks/:id`) guarded by the existing `THEN_TASK_SECRET`/localhost-dev rule, with job results stored via celsian `MemoryQueue`/a bounded `Map` exactly as the old TASK_RUNNER_CODE did.
- [ ] Delete `packages/core/src/tasks.ts` + `packages/core/test/tasks.test.ts`; remove the tasks export block from `index.ts` (lines exporting `MemoryQueue, TaskRunner, CronScheduler, parseCron, ...`); re-export `runTaskOnce` and `type TaskRunResult` instead. `grep -rn "from './tasks" packages` must be empty.
- [ ] Full suite green; `loc-budget.test.ts` still passing (now well under 5,068).
- [ ] `git commit -m "feat(core): task routes on celsian cron, runTaskOnce with retry/timeout; delete vura tasks.ts (A2.6)"`.

---

### Task 12 — `vura tasks run <name>` CLI (A2.6)

**Files:**
- Create: `packages/cli/src/commands/tasks.ts`
- Modify: `packages/cli/src/index.ts` (register `tasks` in `COMMANDS` and help text)
- Test: `packages/cli/test/tasks-command.test.ts`

- [ ] Write failing test: fixture project with `src/api/report.ts` (`export const route = { kind: 'task', retries: 0, timeout: 5000 }; export async function POST(job) { return { ran: true, input: job.input }; }`); invoke `tasksCommand(['run', 'report', '--input', '{"day":"mon"}'])` and assert stdout contains `"status": "completed"` and `"ran": true`; `tasksCommand(['list'])` prints the task name and schedule; `tasksCommand(['run', 'nope'])` rejects with a "Unknown task" error listing available names.
- [ ] Run — fails.
- [ ] Implement `packages/cli/src/commands/tasks.ts`:

```ts
import { buildManifest, runTaskOnce } from '@celsian/vura-core';
import { join } from 'node:path';

export async function tasksCommand(args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const manifest = await buildManifest(projectRoot);
  const tasks = manifest.api.filter((r) => r.kind === 'task');
  const sub = args[0];

  if (sub === 'list' || !sub) {
    for (const t of tasks) {
      const name = t.urlPattern.replace(/^\/api\//, '').replace(/\//g, '.');
      console.log(`  ${name}${t.config.schedule ? `  (cron: ${t.config.schedule})` : ''}`);
    }
    return;
  }
  if (sub !== 'run') throw new Error(`Unknown subcommand: ${sub} (use: vura tasks list | vura tasks run <name>)`);

  const name = args[1];
  const route = tasks.find((t) => t.urlPattern.replace(/^\/api\//, '').replace(/\//g, '.') === name);
  if (!route) throw new Error(`Unknown task: ${name}. Available: ${tasks.map(t => t.urlPattern.replace(/^\/api\//, '').replace(/\//g, '.')).join(', ') || '(none)'}`);

  const inputIdx = args.indexOf('--input');
  const input = inputIdx >= 0 ? JSON.parse(args[inputIdx + 1] ?? 'null') : null;

  // Transpile + import the task module the same way the dev server does (esbuild via core)
  const mod = await importRouteModule(join(projectRoot, route.filePath)); // shared helper from commands/dev.ts, extracted
  const result = await runTaskOnce(
    { name: name!, config: route.config as { retries?: number; timeout?: number }, handler: mod.POST },
    { input },
  );
  console.log(JSON.stringify(result, null, 2));
  if (result.status === 'failed') process.exit(1);
}
```

  (`importRouteModule` — extract the existing esbuild-transpile-then-import helper used by `commands/dev.ts` into `packages/cli/src/commands/shared.ts` rather than duplicating it.)
- [ ] Register in `COMMANDS` and help text in `packages/cli/src/index.ts`.
- [ ] Tests green; full suite green.
- [ ] `git commit -m "feat(cli): vura tasks list/run with retry+timeout from route config"`.

---

### Task 13 — Thin auth/session helpers (A2.7)

**Files:**
- Create: `packages/core/src/auth.ts`
- Modify: `packages/core/package.json` (dep `@celsian/jwt@^0.5.2`), `packages/core/src/index.ts`
- Test: `packages/core/test/auth.test.ts`

Scope guard: helpers, not an auth product. Three exports only: `cookieSession()` (HMAC-signed cookie session as a celsian `onRequest` hook + reply decoration), and re-exports `jwt`, `createJWTGuard` from `@celsian/jwt`.

- [ ] Write failing test `packages/core/test/auth.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createApp } from '@celsian/core';
import { cookieSession, jwt, createJWTGuard } from '../src/auth.js';

describe('cookieSession', () => {
  it('round-trips session data through a signed cookie and rejects tampering', async () => {
    const app = createApp({ logger: false });
    app.addHook('onRequest', cookieSession({ secret: 'a-very-long-test-secret-32chars!!' }));
    app.post('/login', (req: any, reply: any) => { req.session.user = 'kirby'; return reply.json({ ok: true }); });
    app.get('/me', (req: any, reply: any) => reply.json({ user: req.session.user ?? null }));

    const login = await app.handle(new Request('http://x/login', { method: 'POST' }));
    const cookie = login.headers.get('set-cookie')!;
    expect(cookie).toContain('vura_session=');
    expect(cookie).toContain('HttpOnly');

    const me = await app.handle(new Request('http://x/me', { headers: { cookie } }));
    expect(await me.json()).toEqual({ user: 'kirby' });

    const tampered = cookie.replace(/vura_session=([^;.]+)/, 'vura_session=ev1l');
    const bad = await app.handle(new Request('http://x/me', { headers: { cookie: tampered } }));
    expect(await bad.json()).toEqual({ user: null });
  });
});

describe('jwt re-exports', () => {
  it('re-exports the celsian jwt plugin and guard', () => {
    expect(typeof jwt).toBe('function');
    expect(typeof createJWTGuard).toBe('function');
  });
});
```

- [ ] Run — fails. Implement `packages/core/src/auth.ts`:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';
import { parseCookies, serializeCookie, type CookieOptions } from '@celsian/core';
import type { CelsianRequest, CelsianReply } from '@celsian/core';

export { jwt, createJWTGuard } from '@celsian/jwt';

export interface CookieSessionOptions {
  secret: string;
  cookieName?: string;        // default 'vura_session'
  cookie?: CookieOptions;     // merged over { httpOnly: true, sameSite: 'lax', path: '/' }
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/** celsian onRequest hook: req.session (mutable object), written back as a signed cookie on send. */
export function cookieSession(opts: CookieSessionOptions) {
  if (!opts.secret || opts.secret.length < 32) throw new Error('cookieSession: secret must be at least 32 characters');
  const name = opts.cookieName ?? 'vura_session';
  return async (req: CelsianRequest, reply: CelsianReply) => {
    let session: Record<string, unknown> = {};
    const raw = parseCookies(req.headers.get('cookie') ?? '')[name];
    if (raw) {
      const dot = raw.lastIndexOf('.');
      if (dot > 0) {
        const [payload, sig] = [raw.slice(0, dot), raw.slice(dot + 1)];
        const expected = sign(payload, opts.secret);
        if (sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
          try { session = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { /* fresh session */ }
        }
      }
    }
    (req as any).session = session;
    const original = JSON.stringify(session);
    // Persist on send via celsian's reply.cookie when the session changed.
    const json = reply.json.bind(reply);
    reply.json = (data: unknown) => {
      const now = JSON.stringify((req as any).session ?? {});
      if (now !== original) {
        const payload = Buffer.from(now).toString('base64url');
        reply.cookie(name, `${payload}.${sign(payload, opts.secret)}`,
          { httpOnly: true, sameSite: 'lax', path: '/', ...opts.cookie });
      }
      return json(data);
    };
  };
}
```

  (If celsian exposes an `onSend` hook that can set cookies more cleanly than wrapping `reply.json`, prefer that — verify against `celsian/packages/core/src/hooks.ts` `runOnSendHooks` during implementation and use it if headers are still mutable at that stage; `app.ts` lines 888–906 show header mutation post-onSend is honored.)
- [ ] Export `cookieSession`, `jwt`, `createJWTGuard`, `CookieSessionOptions` from `index.ts`.
- [ ] Tests green; full suite green.
- [ ] `git commit -m "feat(core): thin auth helpers — signed cookie sessions + @celsian/jwt re-exports (A2.7)"`.

---

### Task 14 — Ship vura v0.4.0

**Files:**
- Modify: all `packages/*/package.json` → `0.4.0`; `CHANGELOG.md`; `create-vura` templates gain a `kind:'hot'` chat example and a scheduled task example
- Test: `pnpm run release:check`, `packages/create-vura/test/templates.test.ts`

- [ ] Bump versions to `0.4.0`; update `create-vura` template lockstep deps; add a hot-route + task example to the default template (exercises `websocket`, `schedule`, `vura tasks run`).
- [ ] CHANGELOG: hot routes (websocket contract, per-process state caveat, SIGTERM drain, Dockerfile/fly.toml), tasks (celsian cron, CLI runner, retry/timeout), auth helpers.
- [ ] `pnpm run check && pnpm vitest run && pnpm run release:check && pnpm run verify:publish` — green.
- [ ] `git commit -m "release: vura v0.4.0 — hot/task routes for real + auth helpers"`. Tag/publish.

---

## Risks & escape hatches

1. **what-fw 0.8 → 0.11 API drift in existing tests.** `whatfw-integration.test.ts` was written against 0.8.1; `renderToStream` is now an async generator (server/index.js line 275) and head handling changed (`renderToStringWithHead`). Escape hatch: Task 1 deliberately updates assertions; if `Island`/`definePage` semantics changed materially, pin the failing behaviors as documented diffs in the commit body rather than blocking the rebase.
2. **`createRequestHandler` route/`routeMatch` shape mismatch.** The injected `render` receives `{ path, query, config, route, params, request }` (core.js line 184). If 0.11.x patch releases rename fields, `createVuraRenderRoute` breaks. Escape hatch: `runtime-pages.test.ts` exercises the real handler (no mocks), so any mismatch fails loudly in Task 2; worst case, vura calls `cache.handle` + `matchRoute` from `what-router/match` directly and skips `createRequestHandler` — both are public exports.
3. **Catch-all pattern conversion (`*param` → `*:param`).** what-router's `compilePath` treats `*:name` as a full-segment `(.+)`; vura's old matcher allowed mid-pattern `*`. Multi-segment edge cases may differ. Mitigation: `buildWhatRoutes` test covers it; if behavior diverges for real projects, normalize at manifest time instead (`fileToUrlPattern` emits `*:name` natively).
4. **Bundled entry size / esbuild resolution of celsian + what-fw.** Bundling `@celsian/core` (TS, `exports` maps) and what-fw (JS) into one entry may hit ESM-only export-map issues — `packages/cli/src/commands/build.ts` line 65 already carries a resolution plugin for this; reuse it. Escape hatch: ship `dist/server/entry.js` unbundled with a generated `dist/package.json` declaring real dependencies and `npm install` in the Dockerfile (the Dockerfile from Task 10 already tolerates this).
5. **CSRF ownership.** Pages handler runs with `csrf: false` because celsian owns API security (`csrf()` plugin exists in @celsian/core). If a project uses what-fw server actions later, this needs revisiting — flagged, out of A1/A2 scope.
6. **`ws` optional dependency.** Tests need `ws` installed at the workspace root; production only needs it for hot routes (emitted `dist/package.json`). If `ws` major-bumps, only the dynamic-import wiring in `runtime/server.ts` is affected (same blast radius celsian already accepts in its `serve.ts`).
7. **ThenRequest compat gaps.** Handlers doing `req.headers['x-foo']` (plain-object indexing) break under celsian's `Headers`. The shim fixes `req.body` and keeps `params/query/parsedBody`, but headers indexing is left to the migration note (adding a Proxy over Headers was judged not worth the LOC against the A1.4 metric). If real-user breakage appears, add a `headersObject(req)` helper rather than a Proxy.
8. **149-core-test guarantee.** Several tests assert on generated-entry *source strings*; Task 5 converts them to behavioral assertions. Every changed assertion must be listed in that task's commit body so the "passing or updated deliberately" requirement is auditable.

### Critical Files for Implementation
- /Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/vura/packages/core/src/build.ts
- /Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/vura/packages/core/src/manifest.ts
- /Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/what-fw/packages/server/src/adapter/core.js
- /Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/what-fw/packages/cache/src/isr.js
- /Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/celsian/packages/core/src/app.ts
