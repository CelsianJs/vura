# Phase 0 — Hot-Route Magic Trick Demo (Multiplayer Cursors on Vura)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the Vura wedge in one week: scaffold an app, add a websocket route with a one-line `export const kind = 'hot'`, and have a live multiplayer-cursor demo at a public Fly.io URL via both a self-hosted path and a stubbed platform deploy path.

**Architecture:** The spike hacks minimal websocket support into the three places a route already flows through: the manifest scanner (detect `kind` shorthand + `websocket` export), the generated `dist/server/entry.js` (attach a `ws` upgrade handler on the existing Node `http` server), and the standalone dev server in the CLI (same upgrade handler, dev-reloaded). The demo app itself is a workspace example (`examples/phase0-cursors`) with in-memory room state, a static what-fw page, and a plain-ESM browser client. Throwaway quality is acceptable everywhere except the file-convention API surface (`export const kind = 'hot'` + `export function websocket(connection, req)`), which is the exact contract A2 must later implement properly.

**Tech Stack:** Vura v0.2.0 monorepo (pnpm, vitest 3, esbuild), `ws@^8.18.0` for RFC6455, what-framework 0.8.x JSX for the page, Node 22, Fly.io (Dockerfile + fly.toml, single machine, `flyctl`).

**Master plan:** see WhatStack/VURA-MASTER-PLAN-2026-06-10.md §7 Phase 0

---

## Proposed API Surface (the contract A2 inherits — do not deviate)

```ts
// src/api/cursors.ts — the entire "magic trick" is these two exports
export const kind = 'hot';                      // shorthand; `export const route = { kind: 'hot' }` keeps working

export function websocket(connection: WsConnection, req: WsRequest): void | Promise<void>;

// Shapes (defined inline in the spike; A2 moves them into @celsian/vura-core):
interface WsConnection {
  id: string;                                    // unique per connection
  send(data: string | object): void;             // objects are JSON.stringify'd
  close(code?: number, reason?: string): void;
  on(event: 'message', fn: (data: string) => void): void;
  on(event: 'close', fn: () => void): void;
  on(event: 'error', fn: (err: Error) => void): void;
}
interface WsRequest {
  url: string;                                   // pathname
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, string>;
}
```

A route file exporting `websocket` is a valid route even with zero HTTP method exports.

## File Structure

All paths absolute under `/Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/` (abbreviated `WS/`).

| File | Action | Responsibility |
|---|---|---|
| `WS/vura/packages/core/src/manifest.ts` | Modify | Detect `export const kind = '...'` shorthand and `websocket` export; `hasWebsocket` on `ApiRoute`; keep ws-only routes in manifest |
| `WS/vura/packages/core/test/websocket-manifest.test.ts` | Create | Vitest coverage for the new detection |
| `WS/vura/packages/core/src/build.ts` | Modify | Emit `ws` import, `wsRoutes` table, and `server.on('upgrade')` block in generated `dist/server/entry.js` |
| `WS/vura/packages/core/test/websocket-entry.test.ts` | Create | Vitest coverage for generated entry code |
| `WS/vura/packages/cli/src/commands/dev.ts` | Modify | Websocket upgrade handling in the standalone dev server (with module cache for shared room state) |
| `WS/vura/packages/cli/package.json` | Modify | Add `ws` dependency + `@types/ws` |
| `WS/vura/packages/cli/src/commands/deploy.ts` | Modify | `vura deploy --stub`: stubbed platform deploy path (build → generated Dockerfile/fly.toml → flyctl) |
| `WS/vura/examples/phase0-cursors/package.json` | Create (via scaffold, then overwrite) | Demo app: workspace deps, `ws`, vitest |
| `WS/vura/examples/phase0-cursors/src/lib/room.ts` | Create | In-memory cursor room: join/move/leave/broadcast (pure, testable) |
| `WS/vura/examples/phase0-cursors/test/room.test.ts` | Create | Vitest tests for room state + broadcast semantics |
| `WS/vura/examples/phase0-cursors/src/api/cursors.ts` | Create | The hot websocket route — the one-line magic trick |
| `WS/vura/examples/phase0-cursors/src/pages/index.tsx` | Create (overwrite scaffold) | Static page: stage div + HUD, loads `/cursors.js` |
| `WS/vura/examples/phase0-cursors/public/cursors.js` | Create | Plain-ESM browser client: send cursor positions, render others' |
| `WS/vura/examples/phase0-cursors/Dockerfile` | Create | `node:22-alpine`, `npm install ws`, `node dist/server/entry.js` |
| `WS/vura/examples/phase0-cursors/fly.toml` | Create | Single always-on machine, `/__health` checks, force_https |
| `WS/PHASE0-VERDICT.md` | Create | Written verdict vs the Vercel+Fly hand-glue alternative |

---

### Task 1: Spike branch + scaffold the demo app

**Files:**
- Create: `WS/vura/examples/phase0-cursors/**` (via `create-vura`, then overwrite `package.json`)
- Modify: none

- [ ] Create the spike branch:
  ```bash
  git -C /Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/vura checkout -b spike/phase0-hot-demo
  ```
- [ ] Build `create-vura` and scaffold (this exercises the real `npm create vura` code path):
  ```bash
  cd /Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/vura && pnpm -C packages/create-vura build
  cd /Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/vura/examples && node ../packages/create-vura/dist/index.js phase0-cursors --no-install
  ```
  Expected: "create-vura — scaffold a new Vura project" output, files written under `examples/phase0-cursors/`.
- [ ] Overwrite `WS/vura/examples/phase0-cursors/package.json` so the demo links the workspace packages (the spike's modified core/cli) and has test tooling:
  ```json
  {
    "name": "phase0-cursors",
    "version": "0.1.0",
    "private": true,
    "type": "module",
    "scripts": {
      "dev": "vura dev",
      "build": "vura build && mkdir -p dist/public && cp public/cursors.js dist/public/",
      "test": "vitest run"
    },
    "dependencies": {
      "what-framework": "^0.8.1",
      "ws": "^8.18.0"
    },
    "devDependencies": {
      "@celsian/vura-cli": "workspace:*",
      "@celsian/vura-core": "workspace:*",
      "vitest": "^3.0.0"
    }
  }
  ```
- [ ] Delete scaffold pages we don't need: remove `WS/vura/examples/phase0-cursors/src/pages/about.tsx` and `WS/vura/examples/phase0-cursors/src/pages/dashboard.tsx` (keep `src/api/hello.ts` serverless and `src/api/health.ts` hot — they show the kind contrast in `vura manifest`).
- [ ] Install (workspace links resolve since `pnpm-workspace.yaml` already includes `examples/*`):
  ```bash
  cd /Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/vura && pnpm install
  ```
- [ ] Commit:
  ```bash
  git -C /Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/vura add examples/phase0-cursors
  git -C /Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/vura commit -m "spike(phase0): scaffold cursors demo app via create-vura" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

### Task 2: Manifest — `kind` shorthand + `websocket` export detection (TDD)

**Files:**
- Modify: `WS/vura/packages/core/src/manifest.ts`
- Test: `WS/vura/packages/core/test/websocket-manifest.test.ts` (create)

- [ ] Write the failing test at `WS/vura/packages/core/test/websocket-manifest.test.ts`:
  ```ts
  import { describe, it, expect } from 'vitest';
  import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
  import { tmpdir } from 'node:os';
  import { join } from 'node:path';
  import { extractApiExports, buildManifest } from '../src/manifest.js';

  describe('hot websocket route detection (Phase 0 spike)', () => {
    it("detects export const kind = 'hot' shorthand", () => {
      const src = "export const kind = 'hot';\nexport function GET(req, reply) { return reply.json({}); }";
      expect(extractApiExports(src).kind).toBe('hot');
    });

    it('shorthand wins over route config object', () => {
      const src = "export const route = { kind: 'serverless' };\nexport const kind = 'hot';\nexport function GET() {}";
      expect(extractApiExports(src).kind).toBe('hot');
    });

    it("keeps export const route = { kind: 'hot' } working", () => {
      const src = "export const route = { kind: 'hot' };\nexport function GET() {}";
      expect(extractApiExports(src).kind).toBe('hot');
    });

    it('detects a websocket export', () => {
      const src = "export const kind = 'hot';\nexport function websocket(connection, req) {}";
      expect(extractApiExports(src).hasWebsocket).toBe(true);
    });

    it('hasWebsocket is false for plain routes and kind defaults to serverless', () => {
      const r = extractApiExports('export function GET() {}');
      expect(r.hasWebsocket).toBe(false);
      expect(r.kind).toBe('serverless');
    });

    it('buildManifest keeps a route with ONLY a websocket export (no HTTP methods)', async () => {
      const root = await mkdtemp(join(tmpdir(), 'vura-ws-'));
      await mkdir(join(root, 'src', 'api'), { recursive: true });
      await writeFile(
        join(root, 'src', 'api', 'cursors.ts'),
        "export const kind = 'hot';\nexport function websocket(connection, req) {}\n",
      );
      const manifest = await buildManifest(root);
      expect(manifest.api).toHaveLength(1);
      expect(manifest.api[0]).toMatchObject({
        urlPattern: '/api/cursors',
        kind: 'hot',
        hasWebsocket: true,
        methods: [],
      });
      await rm(root, { recursive: true, force: true });
    });
  });
  ```
- [ ] Run it and confirm failure:
  ```bash
  cd /Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/vura && pnpm vitest run packages/core/test/websocket-manifest.test.ts
  ```
  Expected: failures — `hasWebsocket` is `undefined`, shorthand test gets `'serverless'`, buildManifest test gets `api: []`.
- [ ] Implement in `WS/vura/packages/core/src/manifest.ts`. Three edits:

  (a) Add the field to `ApiRoute` (after `config`):
  ```ts
  export interface ApiRoute {
    filePath: string;
    urlPattern: string;
    methods: HttpMethod[];
    kind: RouteKind;
    config: Record<string, unknown>;
    /** Route exports a `websocket(connection, req)` handler (hot routes only). */
    hasWebsocket: boolean;
  }
  ```

  (b) In `extractApiExports`, after the existing `routeBody` block (after line ~121) and before the `return`, add shorthand + websocket detection, and extend the return type/value:
  ```ts
  // Shorthand: export const kind = 'hot'  (wins over route config — Phase 0 convention)
  const shorthandKind = source.match(/export\s+const\s+kind\s*=\s*['"](\w+)['"]/);
  if (shorthandKind && isRouteKind(shorthandKind[1]!)) {
    kind = shorthandKind[1]!;
  }

  // Websocket handler export: export function websocket(connection, req) | export const websocket =
  const hasWebsocket =
    /export\s+(?:async\s+)?function\s+websocket\b|export\s+const\s+websocket\s*=/.test(source);

  return { methods, kind, config, hasWebsocket };
  ```
  Update the function's declared return type to include `hasWebsocket: boolean;`.

  (c) In `buildManifest`, change the API scan loop:
  ```ts
  const { methods, kind, config, hasWebsocket } = extractApiExports(source);

  if (methods.length === 0 && !hasWebsocket) continue; // Skip files with no HTTP or ws exports

  api.push({
    filePath: relative(projectRoot, file),
    urlPattern: fileToUrlPattern(relPath.replace(/\.(ts|js|mjs)$/, ''), '/api'),
    methods,
    kind,
    config,
    hasWebsocket,
  });
  ```
- [ ] Run the new test plus the whole core suite (the `ApiRoute` field is new and required — fix any test fixture in `packages/core/test/*.test.ts` that constructs `ApiRoute` literals by adding `hasWebsocket: false`):
  ```bash
  cd /Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/vura && pnpm vitest run packages/core/test
  ```
  Expected: all green.
- [ ] Commit:
  ```bash
  git -C /Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/vura add packages/core
  git -C /Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/vura commit -m "spike(phase0): manifest detects kind shorthand and websocket export" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

### Task 3: Generated server entry — websocket upgrade handler (TDD)

**Files:**
- Modify: `WS/vura/packages/core/src/build.ts`
- Test: `WS/vura/packages/core/test/websocket-entry.test.ts` (create)

- [ ] Write the failing test at `WS/vura/packages/core/test/websocket-entry.test.ts`:
  ```ts
  import { describe, it, expect } from 'vitest';
  import { generateServerEntry } from '../src/build.js';
  import type { RouteManifest } from '../src/manifest.js';

  function manifestWith(api: RouteManifest['api']): RouteManifest {
    return { api, pages: [], layouts: [], timestamp: new Date().toISOString() };
  }

  const wsRoute = {
    filePath: 'src/api/cursors.ts',
    urlPattern: '/api/cursors',
    methods: [] as never[],
    kind: 'hot' as const,
    config: {},
    hasWebsocket: true,
  };

  describe('generateServerEntry websocket support (Phase 0 spike)', () => {
    it('emits ws import, wsRoutes table, and upgrade handler for hot websocket routes', () => {
      const code = generateServerEntry(manifestWith([wsRoute]), '/tmp/proj');
      expect(code).toContain("import { WebSocketServer } from 'ws';");
      expect(code).toContain('const wsRoutes = [');
      expect(code).toContain("{ pattern: '/api/cursors', handler: route_api_cursors.websocket }");
      expect(code).toContain("server.on('upgrade'");
      expect(code).toContain('handleUpgrade');
    });

    it('omits all websocket code when no route exports websocket', () => {
      const code = generateServerEntry(
        manifestWith([{ ...wsRoute, hasWebsocket: false, methods: ['GET'] as never[] }]),
        '/tmp/proj',
      );
      expect(code).not.toContain('WebSocketServer');
      expect(code).not.toContain("server.on('upgrade'");
    });
  });
  ```
- [ ] Run and confirm failure:
  ```bash
  cd /Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/vura && pnpm vitest run packages/core/test/websocket-entry.test.ts
  ```
  Expected: first test fails on the `ws` import assertion.
- [ ] Implement in `WS/vura/packages/core/src/build.ts`. Four edits:

  (a) Add a new generated-code constant near the other `*_CODE` constants (e.g., after `HANDLER_FINALIZATION_CODE`, ~line 746):
  ```ts
  // ─── WebSocket Upgrade Code (Phase 0 spike — inline in server entry) ───
  // Exact-path matching only; param patterns in ws routes are an A2 concern.

  const WEBSOCKET_SERVER_CODE = [
    '// WebSocket upgrade handling for hot routes',
    'const _wss = new WebSocketServer({ noServer: true });',
    'let _wsConnCounter = 1;',
    "server.on('upgrade', (nodeReq, socket, head) => {",
    "  const url = new URL(nodeReq.url || '/', 'http://' + (nodeReq.headers.host || 'localhost'));",
    '  const wsRoute = wsRoutes.find(r => r.pattern === url.pathname);',
    '  if (!wsRoute) { socket.destroy(); return; }',
    '  _wss.handleUpgrade(nodeReq, socket, head, (ws) => {',
    '    const connection = {',
    '      id: String(_wsConnCounter++),',
    "      send(data) { if (ws.readyState === 1) ws.send(typeof data === 'string' ? data : JSON.stringify(data)); },",
    '      close(code, reason) { ws.close(code, reason); },',
    '      on(event, fn) {',
    "        if (event === 'message') ws.on('message', (raw) => fn(raw.toString()));",
    "        else if (event === 'close') ws.on('close', () => fn());",
    "        else if (event === 'error') ws.on('error', fn);",
    '      },',
    '    };',
    '    const req = { url: url.pathname, headers: nodeReq.headers, query: Object.fromEntries(url.searchParams.entries()) };',
    '    try {',
    '      const out = wsRoute.handler(connection, req);',
    "      if (out && typeof out.catch === 'function') out.catch((err) => { _log('error', 'websocket handler error', { error: err && err.message }); try { ws.close(1011); } catch (_) {} });",
    '    } catch (err) {',
    "      _log('error', 'websocket handler error', { error: err && err.message });",
    '      try { ws.close(1011); } catch (_) {}',
    '    }',
    '  });',
    '});',
  ].join('\n');
  ```

  (b) In `generateServerEntry` (line ~1118): compute ws routes alongside the existing filters and emit import + table.
  After `const taskRoutes = ...` add:
  ```ts
  const wsRoutes = manifest.api.filter(r => r.kind === 'hot' && r.hasWebsocket);
  const hasWs = wsRoutes.length > 0;
  ```
  After the `node:crypto` import line add:
  ```ts
  if (hasWs) {
    lines.push("import { WebSocketServer } from 'ws';");
  }
  ```
  After the API `routes` table block (after `lines.push('];');`, ~line 1196) add:
  ```ts
  if (hasWs) {
    lines.push('');
    lines.push('const wsRoutes = [');
    for (const route of wsRoutes) {
      const varName = routeVarNames.get(route.filePath)!;
      lines.push(`  { pattern: '${route.urlPattern}', handler: ${varName}.websocket },`);
    }
    lines.push('];');
  }
  ```
  Change the final call to `lines.push(generateServerCode(hasPages, hasTasks, hasWs));`.

  (c) Change `generateServerCode` signature to `function generateServerCode(hasPages: boolean, hasTasks: boolean, hasWs: boolean): string` and insert, immediately after the `server.listen(...)` block (after the `lines.push('});')` that closes `server.listen`, ~line 1021):
  ```ts
  if (hasWs) {
    lines.push('');
    lines.push(WEBSOCKET_SERVER_CODE);
  }
  ```

  (d) In `_gracefulShutdown` inside `generateServerCode` (right after the `server.close(...)` block), add:
  ```ts
  if (hasWs) {
    lines.push('  // Terminate live websocket connections so close() can complete');
    lines.push('  _wss.clients.forEach((c) => { try { c.terminate(); } catch (_) {} });');
  }
  ```
- [ ] Run the test and the full core suite:
  ```bash
  cd /Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/vura && pnpm vitest run packages/core/test
  ```
  Expected: all green (including existing `server-entry-runtime` and `smoke-build` tests — they have no ws routes so output is unchanged).
- [ ] Commit:
  ```bash
  git -C /Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/vura add packages/core
  git -C /Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/vura commit -m "spike(phase0): generated server entry attaches ws upgrade handler for hot routes" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

### Task 4: Standalone dev server websocket support

**Files:**
- Modify: `WS/vura/packages/cli/src/commands/dev.ts`, `WS/vura/packages/cli/package.json`
- Test: manual (a node ws-client one-liner; automating the CLI server is unreasonable for a spike)

- [ ] Add `ws` to `WS/vura/packages/cli/package.json`: in `"dependencies"` add `"ws": "^8.18.0"`, in `"devDependencies"` add `"@types/ws": "^8.5.12"`. Then:
  ```bash
  cd /Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/vura && pnpm install
  ```
- [ ] In `WS/vura/packages/cli/src/commands/dev.ts`, inside `startStandaloneServer`, immediately after the `const server = createServer(async (req, res) => { ... });` closing (line ~522) and before the file-watch block, add:
  ```ts
  // ─── WebSocket support for hot routes (Phase 0 spike) ───
  // Module cache: one module instance per route file so in-memory room state is
  // shared across connections. Cleared when route files change.
  const wsModuleCache = new Map<string, any>();
  try {
    const { WebSocketServer } = await import('ws');
    const wss = new WebSocketServer({ noServer: true });
    let wsConnCounter = 1;

    server.on('upgrade', async (req, socket, head) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const wsRoute = manifest.api.find(
        r => r.kind === 'hot' && r.hasWebsocket && r.urlPattern === url.pathname,
      );
      if (!wsRoute) { socket.destroy(); return; }

      let mod = wsModuleCache.get(wsRoute.filePath);
      if (!mod) {
        mod = await loadHandler(wsRoute.filePath);
        wsModuleCache.set(wsRoute.filePath, mod);
      }
      if (typeof mod.websocket !== 'function') { socket.destroy(); return; }

      wss.handleUpgrade(req, socket, head, (ws: any) => {
        const connection = {
          id: String(wsConnCounter++),
          send(data: unknown) {
            if (ws.readyState === 1) ws.send(typeof data === 'string' ? data : JSON.stringify(data));
          },
          close(code?: number, reason?: string) { ws.close(code, reason); },
          on(event: string, fn: (...args: any[]) => void) {
            if (event === 'message') ws.on('message', (raw: Buffer) => fn(raw.toString()));
            else if (event === 'close') ws.on('close', () => fn());
            else if (event === 'error') ws.on('error', fn);
          },
        };
        const wsReq = {
          url: url.pathname,
          headers: req.headers,
          query: Object.fromEntries(url.searchParams.entries()),
        };
        try {
          const out = mod.websocket(connection, wsReq);
          if (out && typeof out.catch === 'function') {
            out.catch((err: any) => {
              logger.child('ws').error('websocket handler error', { error: err?.message });
              try { ws.close(1011); } catch {}
            });
          }
        } catch (err: any) {
          logger.child('ws').error('websocket handler error', { error: err?.message });
          try { ws.close(1011); } catch {}
        }
      });
    });
  } catch {
    // ws not installed — websocket routes disabled in standalone dev
  }
  ```
- [ ] In the existing file-watcher callback in the same function (the `watch(dir, { recursive: true }, async (event, filename) => { ... })` body), add one line after `compiledPages = recompilePages(manifest.pages);`:
  ```ts
  wsModuleCache.clear();
  ```
- [ ] Build the CLI package and run its existing tests:
  ```bash
  cd /Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/vura && pnpm -C packages/cli build && pnpm vitest run packages/cli/test
  ```
  Expected: clean tsc/build, all CLI tests green.
- [ ] Manual smoke (uses the scaffold's `health.ts` upgraded later; for now just confirm the server still boots): in one terminal `cd /Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/vura/examples/phase0-cursors && pnpm dev`, expected "Server listening on http://127.0.0.1:3000" plus a route table; Ctrl-C to stop. (Full ws verification happens in Task 6.)
- [ ] Commit:
  ```bash
  git -C /Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/vura add packages/cli pnpm-lock.yaml
  git -C /Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/vura commit -m "spike(phase0): standalone dev server handles websocket upgrades for hot routes" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

### Task 5: Room state with real vitest tests (TDD)

**Files:**
- Create: `WS/vura/examples/phase0-cursors/src/lib/room.ts`
- Test: `WS/vura/examples/phase0-cursors/test/room.test.ts` (create)

- [ ] Write the failing test at `WS/vura/examples/phase0-cursors/test/room.test.ts`:
  ```ts
  import { describe, it, expect } from 'vitest';
  import { createRoom } from '../src/lib/room.js';

  function fakeSocket() {
    const messages: any[] = [];
    return { send: (data: string) => { messages.push(JSON.parse(data)); }, messages };
  }

  describe('cursor room', () => {
    it('join sends init with self id and current cursors, and broadcasts join to others', () => {
      const room = createRoom();
      const a = fakeSocket();
      room.join('a', a);
      expect(a.messages[0]).toMatchObject({ type: 'init', id: 'a' });
      expect(a.messages[0].cursors).toHaveLength(1);

      const b = fakeSocket();
      room.join('b', b);
      // b's init includes both cursors
      expect(b.messages[0].cursors).toHaveLength(2);
      // a got a join broadcast for b; b did NOT get a join for itself
      expect(a.messages.find(m => m.type === 'join')?.cursor.id).toBe('b');
      expect(b.messages.filter(m => m.type === 'join')).toHaveLength(0);
    });

    it('assigns distinct colors to the first joiners', () => {
      const room = createRoom();
      const a = fakeSocket(); const b = fakeSocket();
      room.join('a', a); room.join('b', b);
      const [ca, cb] = b.messages[0].cursors;
      expect(ca.color).not.toBe(cb.color);
    });

    it('move broadcasts clamped position (with color) to others but not the mover', () => {
      const room = createRoom();
      const a = fakeSocket(); const b = fakeSocket();
      room.join('a', a); room.join('b', b);
      room.move('a', 1.7, -0.2);
      const moveAtB = b.messages.find(m => m.type === 'move');
      expect(moveAtB).toMatchObject({ id: 'a', x: 1, y: 0 });
      expect(typeof moveAtB.color).toBe('string');
      expect(a.messages.filter(m => m.type === 'move')).toHaveLength(0);
    });

    it('move for an unknown id is a no-op', () => {
      const room = createRoom();
      const a = fakeSocket();
      room.join('a', a);
      expect(() => room.move('ghost', 0.5, 0.5)).not.toThrow();
      expect(a.messages.filter(m => m.type === 'move')).toHaveLength(0);
    });

    it('leave removes the cursor and broadcasts leave; double-leave is a no-op', () => {
      const room = createRoom();
      const a = fakeSocket(); const b = fakeSocket();
      room.join('a', a); room.join('b', b);
      room.leave('b');
      expect(room.size()).toBe(1);
      expect(a.messages.find(m => m.type === 'leave')).toMatchObject({ id: 'b' });
      const count = a.messages.length;
      room.leave('b');
      expect(a.messages.length).toBe(count);
    });

    it('a broken socket does not break broadcast to healthy sockets', () => {
      const room = createRoom();
      const broken = { send() { throw new Error('socket closed'); } };
      const b = fakeSocket();
      room.join('a', broken as any);
      room.join('b', b);
      expect(() => room.move('b', 0.1, 0.1)).not.toThrow();
    });
  });
  ```
- [ ] Run it and confirm failure (module not found):
  ```bash
  cd /Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/vura && pnpm --filter phase0-cursors test
  ```
- [ ] Implement `WS/vura/examples/phase0-cursors/src/lib/room.ts`:
  ```ts
  /**
   * In-memory multiplayer cursor room (Phase 0 spike).
   * Positions are normalized 0..1. One room per process — this is the point:
   * hot routes have a process to keep state in.
   */

  export interface Cursor {
    id: string;
    x: number;
    y: number;
    color: string;
  }

  export interface RoomSocket {
    send(data: string): void;
  }

  const COLORS = [
    '#e6194b', '#3cb44b', '#ffe119', '#4363d8',
    '#f58231', '#911eb4', '#46f0f0', '#f032e6',
  ];

  function clamp01(n: number): number {
    return Math.min(1, Math.max(0, n));
  }

  export function createRoom() {
    const sockets = new Map<string, RoomSocket>();
    const cursors = new Map<string, Cursor>();
    let joinCounter = 0;

    function broadcast(message: object, excludeId?: string): void {
      const data = JSON.stringify(message);
      for (const [id, sock] of sockets) {
        if (id === excludeId) continue;
        try { sock.send(data); } catch { /* dead socket — leave() will clean up */ }
      }
    }

    return {
      join(id: string, socket: RoomSocket): Cursor {
        const cursor: Cursor = {
          id,
          x: 0.5,
          y: 0.5,
          color: COLORS[joinCounter++ % COLORS.length]!,
        };
        sockets.set(id, socket);
        cursors.set(id, cursor);
        try {
          socket.send(JSON.stringify({ type: 'init', id, cursors: [...cursors.values()] }));
        } catch { /* ignore */ }
        broadcast({ type: 'join', cursor }, id);
        return cursor;
      },

      move(id: string, x: number, y: number): void {
        const cursor = cursors.get(id);
        if (!cursor) return;
        cursor.x = clamp01(x);
        cursor.y = clamp01(y);
        broadcast({ type: 'move', id, x: cursor.x, y: cursor.y, color: cursor.color }, id);
      },

      leave(id: string): void {
        if (!sockets.delete(id)) return;
        cursors.delete(id);
        broadcast({ type: 'leave', id });
      },

      size(): number {
        return cursors.size;
      },
    };
  }
  ```
- [ ] Run tests, expect all green:
  ```bash
  cd /Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/vura && pnpm --filter phase0-cursors test
  ```
- [ ] Commit:
  ```bash
  git -C /Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/vura add examples/phase0-cursors
  git -C /Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/vura commit -m "spike(phase0): cursor room state with broadcast semantics + tests" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

### Task 6: The magic-trick route + frontend, verified in dev

**Files:**
- Create: `WS/vura/examples/phase0-cursors/src/api/cursors.ts`, `WS/vura/examples/phase0-cursors/public/cursors.js`
- Modify: `WS/vura/examples/phase0-cursors/src/pages/index.tsx` (overwrite scaffold)
- Test: manual two-browser check + node ws-client check (browser realtime automation is unreasonable for a spike)

- [ ] Create `WS/vura/examples/phase0-cursors/src/api/cursors.ts` — this file IS the demo's headline; keep it this small:
  ```ts
  import { createRoom } from '../lib/room.js';

  export const kind = 'hot';

  const room = createRoom();

  interface WsConnection {
    id: string;
    send(data: string | object): void;
    close(code?: number, reason?: string): void;
    on(event: 'message', fn: (data: string) => void): void;
    on(event: 'close', fn: () => void): void;
    on(event: 'error', fn: (err: Error) => void): void;
  }

  export function websocket(connection: WsConnection) {
    room.join(connection.id, connection);

    connection.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'move' && typeof msg.x === 'number' && typeof msg.y === 'number') {
          room.move(connection.id, msg.x, msg.y);
        }
      } catch { /* ignore malformed frames */ }
    });

    connection.on('close', () => room.leave(connection.id));
    connection.on('error', () => room.leave(connection.id));
  }
  ```
- [ ] Overwrite `WS/vura/examples/phase0-cursors/src/pages/index.tsx`:
  ```tsx
  export const page = {
    mode: 'static',
    title: 'Vura — Multiplayer Cursors',
    scripts: ['/cursors.js'],
    styles: [
      'body { margin: 0; font-family: system-ui, sans-serif; background: #0b0e14; color: #e6e6e6; overflow: hidden; }' +
      ' .stage { position: fixed; inset: 0; cursor: crosshair; }' +
      ' .hud { position: fixed; top: 16px; left: 16px; pointer-events: none; z-index: 10; }' +
      ' .hud h1 { font-size: 18px; margin: 0 0 4px; } .hud p { font-size: 13px; opacity: 0.7; margin: 0; }' +
      ' .cursor { position: absolute; width: 14px; height: 14px; border-radius: 50% 50% 50% 0;' +
      ' transform: rotate(-45deg); transition: left 60ms linear, top 60ms linear; pointer-events: none; }',
    ],
  };

  export default function HomePage() {
    return (
      <div class="stage" id="stage">
        <div class="hud">
          <h1>Vura — live cursors</h1>
          <p>
            One file. One line: <code>export const kind = 'hot'</code>. Open this page in a
            second browser — <span id="count">1</span> connected.
          </p>
        </div>
      </div>
    );
  }
  ```
- [ ] Create `WS/vura/examples/phase0-cursors/public/cursors.js` (plain ESM, no framework):
  ```js
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/api/cursors`);

  const stage = document.getElementById('stage');
  const countEl = document.getElementById('count');
  const cursors = new Map(); // id -> element
  let selfId = null;

  function updateCount() {
    if (countEl) countEl.textContent = String(cursors.size + 1);
  }

  function upsertCursor({ id, x, y, color }) {
    if (id === selfId) return;
    let el = cursors.get(id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'cursor';
      el.style.background = color || '#888';
      stage.appendChild(el);
      cursors.set(id, el);
      updateCount();
    }
    el.style.left = `${x * 100}vw`;
    el.style.top = `${y * 100}vh`;
  }

  function removeCursor(id) {
    const el = cursors.get(id);
    if (el) { el.remove(); cursors.delete(id); updateCount(); }
  }

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'init') {
      selfId = msg.id;
      for (const c of msg.cursors) upsertCursor(c);
      updateCount();
    } else if (msg.type === 'join') {
      upsertCursor(msg.cursor);
    } else if (msg.type === 'move') {
      upsertCursor(msg);
    } else if (msg.type === 'leave') {
      removeCursor(msg.id);
    }
  });

  // Send positions at most once per animation frame
  let pending = null;
  window.addEventListener('mousemove', (ev) => {
    pending = { x: ev.clientX / innerWidth, y: ev.clientY / innerHeight };
  });
  (function tick() {
    if (pending && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'move', ...pending }));
      pending = null;
    }
    requestAnimationFrame(tick);
  })();
  ```
- [ ] Verify `vura manifest` classifies the route (also confirms the one-line wedge is real):
  ```bash
  cd /Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/vura/examples/phase0-cursors && pnpm exec vura manifest
  ```
  Expected: `/api/cursors` listed with kind `hot` (no methods).
- [ ] Manual dev check 1 (protocol-level): start dev (`pnpm dev` in the example dir), then in another terminal:
  ```bash
  cd /Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/vura/examples/phase0-cursors && node -e "
  const WebSocket = require('ws');
  const w = new WebSocket('ws://127.0.0.1:3000/api/cursors');
  w.on('message', (m) => { console.log(m.toString()); process.exit(0); });
  w.on('error', (e) => { console.error('FAIL', e.message); process.exit(1); });"
  ```
  Expected stdout: `{"type":"init","id":"1","cursors":[{"id":"1","x":0.5,"y":0.5,"color":"#e6194b"}]}`.
- [ ] Manual dev check 2 (the demo): open `http://127.0.0.1:3000/` in two browser windows side by side. Expected: each window shows "2 connected"; moving the mouse in one window moves a colored teardrop cursor live in the other; closing one window removes its cursor and drops the count in the other.
- [ ] Commit:
  ```bash
  git -C /Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/vura add examples/phase0-cursors
  git -C /Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/vura commit -m "spike(phase0): multiplayer cursors route + page + client, working in dev" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

### Task 7: Production build runs locally via dist/server/entry.js

**Files:**
- Modify: none (exercises Task 3 output)
- Test: manual (build + node entry + ws client + browser)

- [ ] Build:
  ```bash
  cd /Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/vura/examples/phase0-cursors && pnpm build
  ```
  Expected: "Found N API routes (... 2 hot ...)", server entry written to `dist/server/entry.js`, static page `dist/static/index.html`, and `dist/public/cursors.js` exists (the `cp` in the build script).
- [ ] Inspect the generated entry contains the ws block:
  ```bash
  grep -c "server.on('upgrade'" /Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/vura/examples/phase0-cursors/dist/server/entry.js
  ```
  Expected: `1`.
- [ ] Run the production entry and check (note: `ws` resolves from the example's node_modules):
  ```bash
  cd /Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/vura/examples/phase0-cursors && PORT=3100 node dist/server/entry.js
  ```
  Expected: `Vura server listening on :3100`. In a second terminal repeat the Task 6 node ws-client one-liner against `ws://127.0.0.1:3100/api/cursors` — expect the same `init` JSON — and open `http://127.0.0.1:3100/` in two browsers, expect live cursors exactly as in dev.
- [ ] Commit (only if any fix-ups were needed; otherwise skip):
  ```bash
  git -C /Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/vura add -A
  git -C /Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/vura commit -m "spike(phase0): production entry serves websockets locally" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

### Task 8: Self-hosted Fly.io deploy (public URL)

**Files:**
- Create: `WS/vura/examples/phase0-cursors/Dockerfile`, `WS/vura/examples/phase0-cursors/fly.toml`
- Test: manual (two browsers on the public URL)

- [ ] Create `WS/vura/examples/phase0-cursors/Dockerfile` (cribbed from `WS/vura-platform/infra/fly/hot-server.Dockerfile`; pnpm workspace symlinks make `COPY node_modules` unusable, and the only runtime dep of the generated entry is `ws`, so install it in-image):
  ```dockerfile
  FROM node:22-alpine
  WORKDIR /app
  # Only runtime dependency of the generated server entry
  RUN npm install ws@^8.18.0
  COPY dist/ ./dist/
  ENV PORT=3000
  ENV NODE_ENV=production
  EXPOSE 3000
  HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q --spider http://localhost:3000/__health || exit 1
  CMD ["node", "dist/server/entry.js"]
  ```
  (`dist/public/cursors.js` is included by the build script's `cp`, so no separate `COPY public` is needed.)
- [ ] Create `WS/vura/examples/phase0-cursors/fly.toml` (cribbed from `hot-server-template.fly.toml`; always-on single machine because room state is in-memory; pick a unique app name, e.g. suffix with your initials):
  ```toml
  app = "vura-cursors-demo"
  primary_region = "iad"

  [env]
    NODE_ENV = "production"
    PORT = "3000"

  [http_service]
    internal_port = 3000
    force_https = true
    auto_stop_machines = false
    auto_start_machines = true
    min_machines_running = 1

  [[http_service.checks]]
    grace_period = "10s"
    interval = "30s"
    method = "GET"
    path = "/__health"
    timeout = "5s"

  [[vm]]
    size = "shared-cpu-1x"
    memory = "256mb"
  ```
- [ ] Deploy (requires `flyctl` logged in to the ZVN Fly account; `--ha=false` ensures exactly one machine so all clients share one room):
  ```bash
  cd /Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/vura/examples/phase0-cursors && pnpm build
  cd /Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/vura/examples/phase0-cursors && flyctl apps create vura-cursors-demo
  cd /Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/vura/examples/phase0-cursors && flyctl deploy --ha=false
  ```
  Expected: image builds, 1 machine starts, health checks pass.
- [ ] Manual public check: `curl -s https://vura-cursors-demo.fly.dev/__health` → `{"ok":true,"framework":"Vura"}`. Then open `https://vura-cursors-demo.fly.dev/` in two browsers (ideally one on a phone over cellular). Expected: live cursors between them over `wss://` (force_https + Fly TLS termination means the client's `wss` branch is exercised). **This is success criterion 2 — record a screen capture for the launch video.**
- [ ] Commit:
  ```bash
  git -C /Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/vura add examples/phase0-cursors/Dockerfile examples/phase0-cursors/fly.toml
  git -C /Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/vura commit -m "spike(phase0): self-hosted Fly deploy of cursors demo" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

### Task 9: Stubbed platform deploy path (`vura deploy --stub`)

**Files:**
- Modify: `WS/vura/packages/cli/src/commands/deploy.ts`
- Test: manual (run the stub, verify second public URL)

- [ ] Replace `WS/vura/packages/cli/src/commands/deploy.ts` with:
  ```ts
  /**
   * `vura deploy` — reserved for the managed Vura deployment platform.
   *
   * Phase 0 spike: `vura deploy --stub` simulates the platform deploy UX by
   * building locally and shelling out to flyctl with platform-template config.
   * The printed flow (build → provision → hot URL) is the UX contract for B1.
   */

  const STUB_DOCKERFILE = `FROM node:22-alpine
  WORKDIR /app
  RUN npm install ws@^8.18.0
  COPY dist/ ./dist/
  ENV PORT=3000
  ENV NODE_ENV=production
  EXPOSE 3000
  CMD ["node", "dist/server/entry.js"]
  `;

  function stubFlyToml(appName: string): string {
    return `app = "${appName}"
  primary_region = "iad"

  [env]
    NODE_ENV = "production"
    PORT = "3000"

  [http_service]
    internal_port = 3000
    force_https = true
    auto_stop_machines = false
    auto_start_machines = true
    min_machines_running = 1

  [[http_service.checks]]
    grace_period = "10s"
    interval = "30s"
    method = "GET"
    path = "/__health"
    timeout = "5s"

  [[vm]]
    size = "shared-cpu-1x"
    memory = "256mb"
  `;
  }

  async function stubPlatformDeploy(): Promise<void> {
    const { execSync } = await import('node:child_process');
    const { mkdir, writeFile, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');

    const projectRoot = process.cwd();
    const pkg = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf-8'));
    const appName = `vura-hot-${String(pkg.name || 'app').toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;

    console.log('\n  vura deploy (platform stub)\n');

    console.log('  → building artifacts...');
    const { buildCommand } = await import('./build.js');
    await buildCommand([]);

    console.log('\n  → provisioning hot server (stub: flyctl under the hood)...');
    const deployDir = join(projectRoot, '.vura', 'deploy');
    await mkdir(deployDir, { recursive: true });
    await writeFile(join(deployDir, 'Dockerfile'), STUB_DOCKERFILE);
    await writeFile(join(deployDir, 'fly.toml'), stubFlyToml(appName));

    try {
      execSync(`flyctl apps create ${appName}`, { stdio: 'inherit', cwd: projectRoot });
    } catch {
      // app already exists — fine
    }
    execSync(
      'flyctl deploy --config .vura/deploy/fly.toml --dockerfile .vura/deploy/Dockerfile --ha=false',
      { stdio: 'inherit', cwd: projectRoot },
    );

    console.log(`\n  ✓ hot routes live:   https://${appName}.fly.dev`);
    console.log(`  ✓ websocket route:  wss://${appName}.fly.dev/api/cursors`);
    console.log('\n  (stub) On Vura Platform this becomes: git push → preview → promote-to-hot.\n');
  }

  export async function deployCommand(args: string[]): Promise<void> {
    if (args.includes('--stub')) {
      await stubPlatformDeploy();
      return;
    }
    console.error(`
    vura deploy is not available in the open-source CLI yet.

    What works today:
      vura build           Build production artifacts locally
      vura manifest        Inspect route/deployment classification
      vura dev             Run the local development server
      vura deploy --stub   (Phase 0 spike) simulate a platform deploy via flyctl

    Managed deployments are handled by Vura Platform and are not part of this
    OSS package release. See https://github.com/CelsianJs/vura#readme for the
    current self-hosted build and adapter guidance.
  `);
    process.exitCode = 1;
  }
  ```
  Note: the demo's `cp public/cursors.js` happens in the app's `build` script, not `vura build` — so before running the stub from the example, run `pnpm build` once OR keep `dist/public/cursors.js` from Task 8 (the stub's `buildCommand` does not delete it). For the spike that is acceptable; record it as an A2/B1 gap (static asset pipeline must own `public/`).
- [ ] Rebuild the CLI:
  ```bash
  cd /Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/vura && pnpm -C packages/cli build
  ```
- [ ] Run the stub from the demo app:
  ```bash
  cd /Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/vura/examples/phase0-cursors && pnpm build && pnpm exec vura deploy --stub
  ```
  Expected: build output, flyctl deploy of app `vura-hot-phase0-cursors`, final lines `✓ hot routes live: https://vura-hot-phase0-cursors.fly.dev`.
- [ ] Manual check: open `https://vura-hot-phase0-cursors.fly.dev/` in two browsers — live cursors, same as the self-hosted app. Two public URLs now exist (self-hosted + platform-stub), satisfying the "BOTH paths" requirement.
- [ ] Commit:
  ```bash
  git -C /Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/vura add packages/cli/src/commands/deploy.ts
  git -C /Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/vura commit -m "spike(phase0): vura deploy --stub simulates platform hot deploy via flyctl" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

### Task 10: Step-count audit + written verdict

**Files:**
- Create: `WS/PHASE0-VERDICT.md` (WhatStack root is not a git repo — write only, no commit)

- [ ] Count the dev-facing steps as a fresh user would experience them (post-publish equivalents of what the spike did) and verify ≤ 10 (success criterion 3). The canonical list to validate against:
  1. `npm create vura@latest cursors-demo`
  2. `cd cursors-demo`
  3. Write `src/api/cursors.ts` + `src/lib/room.ts` (the route is 2 exports; `kind = 'hot'` is the one line)
  4. Write `public/cursors.js` + `src/pages/index.tsx`
  5. `npm run dev` (verify locally)
  6. `npm run build`
  7. `fly apps create cursors-demo` (or skip via `vura deploy --stub`)
  8. `fly deploy --ha=false`
- [ ] Write `WS/PHASE0-VERDICT.md` containing: links to both live URLs, the recorded demo capture path, the step count, the gaps found (feed into A2 — at minimum: vite-plugin dev path has no ws support, ws route patterns are exact-match only, `public/` not owned by `vura build`, room state dies on deploy/restart, graceful shutdown vs long-lived sockets, multi-machine fan-out needs pub/sub), and the comparison filled in using this rubric **verbatim**:

  ```markdown
  ## Comparison rubric: Vura hot route vs Vercel + Fly hand-glue

  Build the identical multiplayer-cursors demo the mainstream way (Next.js or static
  frontend on Vercel + a hand-written `ws` Node server deployed to Fly) and score both:

  | Dimension | Vura (this spike) | Vercel + Fly glue | Winner |
  |---|---|---|---|
  | Commands from empty dir to public live demo | | | |
  | Repos/projects a developer must manage | | | |
  | Infra/config files written by hand (count + LOC) | | | |
  | Glue code written by hand (server bootstrap, CORS, ws URL wiring) (LOC) | | | |
  | One mental model? (same routing/file conventions front+back, y/n) | | | |
  | Local dev parity (does `dev` run the websocket exactly like prod?) | | | |
  | Two origins problem (CORS, cookies, ws URL config across envs) | | | |
  | Time-to-live for an experienced dev (wall clock, honest estimate) | | | |
  | Monthly cost at demo scale | | | |
  | "Magic trick" quality: would the 2-minute video make a dev switch? | | | |

  ## Verdict questions (answer each explicitly)

  1. Is the one-line `kind = 'hot'` change real, or does the demo smuggle in other
     framework changes a user would also need? (Success criterion 1)
  2. Did two browsers see each other's cursors live on the public URL on both the
     self-hosted and stubbed-platform paths? (Success criterion 2)
  3. Was scaffold → live ≤ 10 dev-facing commands? List them. (Success criterion 3)
  4. Is this *obviously* better than the Vercel+Fly alternative — not marginally,
     obviously? If not, the wedge is wrong: say so plainly and say why.
  5. GO / NO-GO / PIVOT recommendation for Phase 1 (A2 hot/task routes), with the
     top 3 hot-route gaps this spike smoked out, ranked.
  ```
- [ ] Update the master plan index status: note in the verdict doc that `WS/VURA-MASTER-PLAN-2026-06-10.md` §8b lists this plan — flip its status when reconciling.
- [ ] Final spike state: leave `spike/phase0-hot-demo` unmerged (throwaway code stays off main); the verdict doc + API surface section are the durable artifacts.

---

### Critical Files for Implementation
- /Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/vura/packages/core/src/manifest.ts
- /Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/vura/packages/core/src/build.ts
- /Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/vura/packages/cli/src/commands/dev.ts
- /Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/vura/packages/cli/src/commands/deploy.ts
- /Users/macbookpro-kirby/Desktop/Coding/ZVN/WhatStack/vura-platform/infra/fly/hot-server-template.fly.toml (template to crib for both deploy paths)
