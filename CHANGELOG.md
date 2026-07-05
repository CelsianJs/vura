# Changelog

## Unreleased

### Cache tags

- **ISR cache tags are sanitised and capped before they hit the wire.** A
  tagged ISR response's `x-vura-cache-tag` and `Cache-Tag` headers are now built
  from a single hardened path (`buildVuraCacheTagHeader`): tags are trimmed,
  de-duplicated, stripped of control characters (no header-injection surface),
  each capped at 128 characters, with at most 64 tags per response, and any
  comma inside a tag is treated as a separator. Previously the raw declared tags
  were passed straight onto the response, uncapped and unsanitised. The
  sanitised value now authoritatively replaces the underlying ISR engine's raw
  `cache-tag`. `buildVuraCacheTagHeader`, `MAX_VURA_CACHE_TAGS`, and
  `MAX_VURA_CACHE_TAG_LENGTH` are exported from `@celsian/vura-core`.
- **The full-stack example's `/stats` ISR page now declares `tags: ['stats']`,**
  demonstrating end-to-end cache-tag emission and `revalidateTag` invalidation.
- **Docs:** the caching guide now documents the `x-vura-cache-tag` / `Cache-Tag`
  response headers, the sanitisation caps, and how project-scoped purge-by-tag
  works on Vura Platform.

## 0.5.3 - 2026-07-04

Scaffold and developer-experience release — makes a freshly created app
deploy, render styled, and demonstrate the full-stack data loop out of the box;
adds a readable client-crash error panel; migrates the toolchain to TypeScript
6 / Vite 8 / Vitest 4; and finishes the hot-placement CLI truth alignment.

### create-vura scaffold

- **Health route ships as `kind: 'serverless'`, not `hot`.** The starter's
  `src/api/health.ts` was a hot route, and hot routes are excluded from the
  serverless adapter bundles — so `vura build` for Cloudflare/Lambda silently
  dropped the health endpoint. It now ships as a serverless route so it deploys
  on every adapter, with a comment explaining when `hot` is the right choice.
- **The starter now demonstrates the full-stack data loop.** The dashboard page
  fetches an API route on mount and renders the response, so the framework's
  core client↔API loop is shown in the default app instead of being invisible.
- **Styled baseline stylesheet.** A small, dependency-free base stylesheet
  (`src/styles.ts`) is imported by every page — system font stack, sensible
  spacing/typography, and styled buttons, inputs, links, and code, with light
  and dark themes via `prefers-color-scheme`. A freshly scaffolded app renders
  styled instead of unstyled black-on-white.
- **Dashboard uses the idiomatic `useFetch` hook.** The scaffold dashboard was
  upgraded from hand-rolled `onMount` + `fetch` + signal to What-FW's `useFetch`,
  now handling loading and error states, not just the happy path (kept
  `mode: 'client'` to avoid the `useSWR`/`useQuery` server-mode heuristic).

### Data-fetching docs

- Added a **Data fetching** reference page documenting What-FW's
  `useFetch`/`createResource`/`useSWR`/`useQuery`/`useInfiniteQuery` hooks —
  real signatures, when to reach for each, the client-vs-server boundary (these
  hooks fetch in the browser; request-time server data uses server mode +
  `getServerData`), and the `useSWR`/`useQuery` server-mode auto-detection
  gotcha.

### core

- **Readable error panel instead of a blank page on client render crash.** When
  a client- or hybrid-mode page throws during its initial render,
  `mount()`/`hydrate()` used to leave the `#app` shell empty — a blank white page
  with the error only in the browser console. The generated client entry now
  wraps the boot in try/catch and renders a `role="alert"` panel: message + stack
  in dev, a generic message in prod (stack traces are not leaked to end users).

### Toolchain

- Migrated to **TypeScript 6** (`^5.7` → `^6.0.0`), **Vite 8** (`^6.4` →
  `^8.0.0`), and **Vitest 4**. The `@celsian/vura-vite-plugin` vite peer range
  widened to `^6.0.0 || ^7.0.0 || ^8.0.0` to support the new major. No runtime
  source changes were required; `@types/node` was bumped for TS6 compatibility.

### CLI — hot-placement truth alignment

- `vura routes inspect` and `vura runtime advise` now report richer runtime
  profiles: WebSocket hot routes surface as `streaming-hot`, tasks pinned to a
  hot runtime (`runtime`/`placement`/`target: 'hot'` or `hot: true`) surface as
  `task-hot`, and their scheduled dispatch surfaces as `cron-hot` instead of
  being flattened to `cron-cold`. CLI truth-alignment only — this does not claim
  live `task-hot`/`cron-hot` execution is deployed.
- Added `VURA_DISABLE_IN_PROCESS_CRON` so a hosting control plane can own cron
  dispatch for platform-placed workloads. When set to `1`/`true`/`yes`, the
  standalone runtime skips starting its in-process scheduler even when
  scheduled tasks are registered. Unset (the default) preserves the existing
  self-hosted behavior where the runtime runs its own cron. Prevents duplicate
  cron execution when an external scheduler is already dispatching.

## 0.5.2 - 2026-06-23

Runtime placement release — makes Vura route bundles deployable on hosted
hot/cold targets and aligns the framework with the current What runtime
contract.

- Runtime route bundles are now built with Vura's automatic JSX runtime and
  ship a Workers-safe `process.env` fallback for neutral (edge) bundles, so the
  same route module runs across the Node runtime, the Cloudflare adapter, and
  hosted platform hot/cold targets without a broken `process` reference.
- Production hot servers now bind to a reachable host (`0.0.0.0`) by default so
  platform-deployed hot routes are actually reachable, matching the Node
  runtime's production host behavior.
- Aligned Vura with the current What Framework runtime contract
  (`what-core`/`what-framework` `0.11.x`), replacing the older `0.8.x` pin.
- Added `vura routes inspect` and `vura runtime advise` — read-only commands
  that surface each route's effective runtime placement (static / cold / hot /
  task / cron) before any deploy or control-plane mutation.
- Excluded generated source maps from the published CLI tarball to keep it
  inside its tracked package-size budget.

## 0.5.1 - 2026-06-19

Public install and release hardening.

- `@celsian/vura-cli` no longer installs the private closed-alpha
  `@celsian/vura-adapter-vura` package as a transitive dependency. Self-hosted
  installs and the self-host audit can now resolve from public npm packages
  without pulling the managed-platform adapter.
- `vura deploy` now reports a clear closed-alpha adapter message when the
  managed-platform adapter is not installed, instead of failing during package
  resolution.
- Release private-package assertions now reject publishable packages that ship
  install-time dependencies on private workspace packages.
- Bumped production `esbuild` ranges to `^0.28.1` to clear the current
  production audit advisory.

## 0.5.0 - 2026-06-12

WebSocket origin allowlists, WebSockets in `vura dev`, cache config wiring,
`req.parsedQuery`, and Lambda nodejs22.x.

### BEHAVIOR CHANGE — query coercion no longer overwrites `req.query` (Cloudflare/Lambda adapters + `validateRequest`)

- On the Cloudflare and Lambda adapters, and in the exported `validateRequest`
  helper, validated query coercion no longer overwrites `req.query`. The raw
  string values stay on `req.query`; the validated+coerced result is surfaced
  on `req.parsedQuery` instead. This matches what the Node/celsian runtime has
  always done — previously the same handler saw coerced values on `req.query`
  on those targets but raw strings on Node.
- `req.validated.query` still carries the coerced data, unchanged.
- **Migration:** if your handlers read coerced query values off `req.query` on
  Cloudflare or Lambda (e.g. `req.query.page` as a number), switch them to
  `req.parsedQuery` or `req.validated.query`.

### `req.parsedQuery`

- When a route declares `schema.query`, the request type now includes
  `parsedQuery` carrying the validated+coerced query object — typed on the
  request across the Node runtime, both adapters, and the compat `ThenRequest`.

### Hot routes — opt-in Origin allowlist

- Hot routes can now declare an Origin allowlist:
  `export const route = { kind: 'hot', origins: ['https://app.example.com'] }`.
  Cross-site browser WebSocket handshakes whose `Origin` is not on the list are
  rejected with a 403 before upgrade.
- Opt-in only: routes that don't set `origins` keep the existing accept-all
  behavior. An empty list (`[]`) denies all browser origins. Entries must be
  literal strings in the route export (they are read from the route's static
  config at scan time).

### WebSockets in `vura dev`

- Hot routes now accept WebSocket connections in dev — both the Vite dev path
  (`@celsian/vura-vite-plugin`, coexisting with Vite's own HMR socket) and the
  standalone `vura dev` server.
- The module instance is shared between WebSocket and HTTP handling per route,
  so module-level state (rooms, counters) is consistent across both.
- Route edits apply on the next connection; already-open sockets keep their
  existing handler. On route rescan, a notice reminds you that open clients
  keep the old room registry — reconnect to rejoin.
- Rescans are atomic in the standalone dev server: adding or deleting a route
  file takes effect on the first rescan, and a broken edit (syntax error)
  fails the rescan loudly while the last good routes keep serving — the dev
  server never crashes or wedges. On the Vite path, a route module that fails
  to load at connection time rejects the WebSocket handshake with a 500.

### Cache config wired into the generated server entry

- `VuraCacheConfig` from `vura.config` is now wired into the entry generated by
  `vura build`: `store`, `dir`, `maxEntries`, and CDN ids are emitted as
  literals.
- Secrets are **never** serialized into the entry — `revalidateSecret` and the
  CDN `apiToken` are always read from env at runtime
  (`VURA_REVALIDATE_SECRET` / `VURA_CDN_API_TOKEN`).
- `store: 'redis'` is a build-time error: a redis store needs a live client
  instance, which is not serializable at build time. Use the programmatic path
  (`createVuraCache({ store: 'redis', redisClient })`) instead.

### Self-host audit extended A0–A9 → A0–A12

- The self-host audit now proves static (A10), client (A11), and hybrid (A12)
  pages are served correctly from one generated entry, with the serving layer
  asserted per mode.
- The hybrid build warning was narrowed to the true limitation (dynamic
  param-pattern hybrid pages only) instead of warning on every hybrid page.

### adapter-lambda

- Default runtime bumped `nodejs20.x` → `nodejs22.x`.
- SAM template dedup: `Runtime`/`Architectures`/`MemorySize`/`Timeout` are
  inherited from `Globals` instead of repeated per function (fixes cfn-lint
  E3032/E3037).
- Per-function `package.json` with `{"type":"module"}` is emitted so Lambda's
  Node runtime accepts the ESM handler.
- These shipped on main since 0.4.0 and are first released here.

### Deprecations

- `ThenRequest`/`ThenReply`/`ThenHandler` removal is **deferred to 0.6** (the
  0.4.0 deprecation notices said v0.5). The aliases keep working in 0.5.x;
  deprecation strings updated accordingly.

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
