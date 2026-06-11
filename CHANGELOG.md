# Changelog

## 0.4.0 - 2026-06-11

Hot routes, background tasks, and auth helpers.

### Hot routes (`kind: 'hot'`)

- Routes with `export const kind = 'hot'` (shorthand) or
  `export const route = { kind: 'hot' }` now enable a real WebSocket upgrade
  path backed by the Celsian `WSRegistry`. The route object wins when both are
  present; the shorthand also works for `'task'`.
- WebSocket messages are capped at 1 MB per frame (`maxPayload`) — ws's 100 MB
  default is too permissive for a public server.
- Export `websocket(peer: HotPeer, req: HotRequest)` in the route file to handle
  connections. Called once per open connection.
- `peer.send(data)` — fire-and-forget string or `ArrayBuffer` to this peer; no-op
  after close.
- `peer.broadcast(data, excludeSelf?)` — keyed by **concrete pathname** (e.g.
  `/api/chat/lobby`), not the route pattern — natural "room" semantics. Cross-room
  broadcast requires iterating peers manually.
- Binary frames are delivered as `ArrayBuffer` (correctly detected via `isBinary` —
  fixes prior version that stringified all frames including binary payloads).
- `req.params` carries path params extracted from the route pattern.
- SIGTERM drain: on shutdown the server sends close code `1001` (going away) to all
  open hot-route connections and waits for the drain to complete before exiting.
- New deploy templates (`dist/Dockerfile`, `dist/fly.toml`) emitted by `vura build`
  enable `fly deploy ./dist` without manual configuration.
- **Per-process state caveat**: `WSRegistry` is in-process; multi-instance
  deployments require an external message bus (e.g. Redis pub/sub) for cross-instance
  fan-out. See Celsian ws-redis docs.

### Background tasks on celsian cron

- Routes with `export const route = { kind: 'task' }` are now wired to the Celsian
  cron engine. Export `schedule = '0 3 * * *'` (cron expression) for automatic
  scheduling; omit for manual-trigger-only tasks.
- `runTaskOnce` — the canonical task executor: retry + per-attempt timeout +
  exponential backoff (100 × 2^attempt ms, capped at 30 s). Sync handlers work.
  Exported from `@celsian/vura-core` for use in custom wiring.
- `/__tasks` admin endpoint: `GET /__tasks` lists registered tasks + last run status;
  `POST /__tasks/:name` triggers a task manually with optional JSON body input.
  Auth: timing-safe bearer compare via sha256 (`THEN_TASK_SECRET` env), falls back
  to localhost-only in dev/test.
- Overlap guard: cron tick is skipped if the same task is still running from the
  previous tick (logs a warning). Manual POST triggers bypass this guard.
- Bounded result store: up to 10 000 jobs retained; evicted forward (no full sort).

### `vura tasks` CLI

- `vura tasks list` — print all registered tasks and their schedules.
- `vura tasks run <name>` — trigger a named task immediately (local dev / CI).

### Auth helpers

- `cookieSession(opts)` — returns a celsian `onRequest` hook that populates
  `req.session` with a signed, auto-persisted cookie session. Uses synchronous
  HMAC-SHA-256 via `node:crypto` — no external deps. Set-Cookie emitted
  automatically on session change across all celsian response paths (plain-object
  return, `reply.json`, `reply.html`, `reply.send`).
  **Limitation**: handlers that return a raw `new Response(...)` bypass celsian's
  header-merging path; Set-Cookie is NOT emitted in that case.
- `jwt` + `createJWTGuard` — re-exported from `@celsian/jwt`; no separate install
  needed.

### `ws` optional peer dependency

- `ws ^8.0.0` is listed as an optional peer dependency of `@celsian/vura-core`.
  Install it (`npm install ws`) only when deploying hot routes to a Node.js server.
  Serverless and Cloudflare Workers adapters do not require it.

### Breaking changes — removed legacy task exports

The following symbols were removed from `@celsian/vura-core`'s public API in 0.4.0
(they existed in 0.2.x but were never re-exported in 0.3.0):

- `TaskRunner` — replaced by `runTaskOnce` + `registerTaskCrons`
- `MemoryQueue` — replaced by `createTaskResultStore`
- `CronScheduler` — replaced by the Celsian cron integration in `registerTaskCrons`
- `parseCron` — replaced by cron strings passed directly to `@celsian/core`'s
  `app.cron()`

**Migration**: replace `new TaskRunner(...)` / `new MemoryQueue()` / `new CronScheduler()`
usages with `runTaskOnce` + `createTaskResultStore` + `registerTaskCrons` as shown in
the `packages/core/src/runtime/tasks.ts` source.

### create-vura scaffold additions

- Default scaffold now includes `src/api/chat.ts` — a hot-route WebSocket echo/broadcast
  example with inline documentation of the full peer contract.
- Default scaffold now includes `src/api/cleanup.ts` — a scheduled task example
  (`0 3 * * *`) with `vura tasks run cleanup` documented in a comment.
- Scaffold declares `ws` as a dependency (the chat example needs it) and
  ignores `.env` files by default.

### Fixes

- **Client-mode pages now actually mount in production builds.** Previous
  versions bundled the raw page module and never called `mount()` — the page
  sat on its loading placeholder forever. The build now generates a
  mount/hydrate entry per client/hybrid page, and `vura dev` serves client
  pages with the same contract instead of SSR-ing them (which crashed hook
  components).
- Array values in route/page config are parsed (`tags: ['posts']` no longer
  silently dropped; string form also works).
- Schema `query` keys now validate the querystring (mapped to celsian's
  `querystring`). Validated values are NOT coerced back into `req.query` yet —
  read raw strings; coercion write-back is planned.
- Building with the Cloudflare or Lambda adapter warns when hot routes are
  skipped (they need a persistent host) instead of dropping them silently.
- `revalidateTag`/`revalidatePath` imported inside Lambda function bundles are
  warn-only stubs (build parity with Cloudflare; real revalidation must reach
  the cache host's `/__vura/revalidate` webhook).

## 0.3.0 - 2026-06-11

Rebased on what-framework 0.11 + what-isr ISR engine + Celsian API layer.

### What-Framework 0.11 rebase

- Removed the built-in SSR renderer; Vura now delegates directly to what-framework's `renderToString` and `createRequestHandler` exports.
- Server entry is generated as a thin wiring file and bundled self-contained by esbuild — no framework internals leak into userland.

### ISR engine via what-isr

- `revalidateTag` and `revalidatePath` are now first-class exports from `@celsian/vura-core`.
- Page config supports `revalidate` (TTL in seconds) and `tags` (string array) fields.
- `/__vura/revalidate` webhook endpoint activates on-demand ISR via tag/path.
- Cloudflare and Fastly CDN purge config available on `createVuraCache` for
  custom `startVuraServer` setups (wiring it through `vura.config` is planned;
  the generated entry currently configures `revalidateSecret` only).

### API layer on @celsian/core

- API routes now run on a `CelsianApp` instance (from `@celsian/core ^0.5.2`).
- Route handlers support both schema-first (Celsian options object) and plain function form.
- Global hooks (`onRequest`, `onResponse`, `onError`) are mapped to Celsian lifecycle hooks.
- Dev mode, standalone dev server, and production all use the same CelsianApp — dev/prod parity.

### Breaking changes / deprecations

- **`ThenRequest` / `ThenReply` deprecated** — use `CelsianRequest` / `CelsianReply`. A compat alias keeps existing code working during migration:
  - `req.body` still works via compat alias of `parsedBody`.
  - `req.headers['x']` → `req.headers.get('x')` (Headers object, not plain record).
  - `req.url` is now a full URL string — use `new URL(req.url).pathname` to get the path.
- `onResponse` hooks receive a synthesized `responseInfo` object; `hadError` is always `false` on the success path.
- Intentional API 404s are now honoured in dev mode (previously swallowed by the dev middleware).

### Migration snippet

```ts
// Before (0.2.x)
import type { ThenRequest, ThenReply } from '@celsian/vura-core';
export function GET(req: ThenRequest, reply: ThenReply) {
  const path = req.url;               // was already a path string
  const ct   = req.headers['content-type'];
  return reply.json({ ok: true });
}

// After (0.3.0)
import type { CelsianRequest, CelsianReply } from '@celsian/vura-core';
export function GET(req: CelsianRequest, reply: CelsianReply) {
  const path = new URL(req.url).pathname;   // req.url is now a full URL
  const ct   = req.headers.get('content-type');
  return reply.json({ ok: true });
}
```

## 0.1.0 - 2026-05-10

Initial Vura/ThenJS public package release candidate.

- Ships the core runtime, compiler, CLI, Vite plugin, create app scaffold, and deployment adapters.
- Includes production static serving, API/task hardening, CLI `vura`/`thenjs` aliases, and clean tarball smoke coverage.
- Excludes the native compiler prototype from npm publishing until platform-specific native artifacts are released.
