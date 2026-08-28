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
  it('vura-core src LOC is below its documented ceiling', () => {
    // v0.2.0 baseline (commit 19d9442) was 5001 LOC.
    // Task 9 (hot routes A2.5): +~335 → ~5336; quality pass → ~5478.
    // Task 11 (A2.6): deleted old tasks.ts (-402), added runtime/tasks.ts
    //   (runTaskOnce + cron wiring + /__tasks admin, +~320) and trimmed
    //   server.ts → actual 5585 as of the Task 11 quality pass.
    // Task 13 (A2.7 auth helpers): reworked auth.ts to dual-seam architecture
    //   (Proxy on reply.headers + sync method wrapping via node:crypto createHmac;
    //   removed async Web Crypto, added plain-object/string-return coverage) → actual 5860.
    // Client-mount fix (2026-06-11): generateClientPageEntry in static-render.ts
    //   (+~29 — browser entry wrapper so client/hybrid bundles actually call
    //   mount/hydrate) → actual 5882.
    // A3 truthfulness fixes (2026-06-11): array tag parsing in manifest.ts
    //   (+13 lines) + schema.query→querystring mapping in api-app.ts (+3 lines)
    //   → actual 5935. Ceiling 5970 leaves ~35 headroom.
    // v0.4.x backlog Task 3 (2026-06-11): ws Origin allowlist — new
    //   runtime/ws-upgrade.ts (isOriginAllowed, mostly JSDoc rationale) +
    //   403 rejection in server.ts upgrade handler → actual 6043.
    //   Ceiling 6080 leaves ~37 headroom.
    // v0.4.x backlog Task 4 (2026-06-11): extracted the inline ws upgrade
    //   handler from server.ts into a createWsUpgradeHandler factory in
    //   runtime/ws-upgrade.ts so `vura dev` (vite + standalone) can share it.
    //   The moved body is LOC-neutral; the +129 is the factory's options
    //   interface/JSDoc, the createNoServerWebSocketServer helper, and the
    //   one-time unparseable-allowlist-entry warning → actual 6172.
    //   Ceiling 6210 leaves ~38 headroom.
    // Task 4 quality pass (2026-06-12): ws-upgrade.ts hardening — WsRegistryLike
    //   /RawWsSocket types replacing `any`, loadModule-failure → 500 reject,
    //   explicit error for unresolvable WebSocketServer → actual 6208.
    // v0.4.x backlog Task 2 (2026-06-12, integrated after the Task 4 quality
    //   pass): wire VuraCacheConfig from vura.config into the generated server
    //   entry — build.ts cache block now emits store/dir/maxEntries/cdn-id
    //   literals, env-only secrets, redis build error, secret-literal warning
    //   (+~33; Task 2 measured 6205 against its pre-quality-pass base) and
    //   Task 5 (same day) replaced the hybrid warning in build.ts with a
    //   narrowed param-only version (+9) → combined actual 6250.
    //   Ceiling 6280 leaves ~30 headroom.
    // Client boot error overlay (2026-07-03): generateClientPageEntry in
    //   static-render.ts now wraps mount/hydrate in a try/catch that renders a
    //   readable error panel instead of leaving #app blank on a render throw
    //   (dev shows message+stack, prod stays generic). +~38 → actual ~6315.
    //   Ceiling 6320 leaves ~5 headroom.
    // Cache-tag emission hardening (2026-07-04): new runtime/cache-tags.ts
    //   (buildVuraCacheTagHeader — sanitise/cap/dedupe, mostly JSDoc rationale)
    //   + the pages.ts wrapper now sanitises authoritatively instead of passing
    //   raw tags through → actual 6415. Ceiling 6450 leaves ~35 headroom.
    // Vura Tasks Phase 1 (2026-07-10): typed task input schemas
    //   (validateTaskInput in validation.ts), per-attempt metadata + run
    //   envelope (TaskAttempt/TaskRunEnvelope/buildTaskEnvelope + attemptRecords
    //   in runtime/tasks.ts, input validation in runTaskOnce + server.ts POST
    //   /__tasks path), and the new enqueue() client (enqueue.ts — platform HTTP
    //   broker + local /__tasks fallback, mostly JSDoc). +~386 → actual 6801.
    //   Ceiling 6850 leaves ~49 headroom.
    // Vura Tasks Phase 2 (2026-07-10): durable-execution `step` API. New
    //   runtime/steps.ts (SuspendSignal, Waitpoint types, createTaskStep factory
    //   — run/enqueue/waitForTask/sleep/sleepUntil/waitForToken with memoization,
    //   suspend, and local-dev fallbacks; ~half JSDoc) + wiring into
    //   runtime/tasks.ts (RunTaskOnceOptions, suspended status, step ctx,
    //   TaskAdminJob fields) + dispatch-v2 parsing & a local child dispatcher in
    //   runtime/server.ts. +~499 → actual 7300. Ceiling 7350 leaves ~50 headroom.
    // Task-entry unification (2026-07-11): the generated serverless task entry
    //   now delegates to runTaskOnce instead of hand-rolling a third executor
    //   (prod bug: step-using tasks crashed on WfP; schemas/retries never ran
    //   serverless). generateTaskEntry template grew (header protocol + envelope
    //   + docs) + bundleTaskEntry helper in build.ts, envelope `error` field in
    //   runtime/tasks.ts. +~101 → actual 7401. Ceiling 7450 leaves ~49 headroom.
    // What 0.13 upgrade (2026-08-25): jsx-runtime.ts stopped hand-rolling a
    //   vnode and now re-exports What's runtime (the hand-rolled one emitted
    //   `type` where What reads `tag`, so every hybrid page server-rendered
    //   `<undefined>`); the replacement is mostly the comment explaining that.
    //   Plus `absWorkingDir: projectRoot` on the three esbuild calls in build.ts
    //   so a programmatic buildProject() no longer resolves against the caller's
    //   cwd. +~61 → actual 7462. Ceiling 7500 leaves ~38 headroom.
    // RFC 0001 loaders (2026-08-25): server-side data fetching for pages. New
    //   runtime/loader.ts (LoaderContext, notFound/redirect control-flow errors
    //   with structural type guards, useLoaderData over What's tree-scoped
    //   context, parallel runLoaderChain, payload serialize/read — over half
    //   JSDoc) plus the loader phase and redirect channel in runtime/pages.ts,
    //   build-time loaders in static-render.ts, and `loader` detection in
    //   manifest.ts. +~459 → actual 7921. Ceiling 7970 leaves ~49 headroom.
    // Loaders in built apps (2026-08-25): the 0.6.0 loader worked only when
    //   imported from source. New runtime-shim.ts holds the one
    //   `@celsian/vura-core` runtime allowlist that core and both adapters had
    //   been maintaining as three copies (the copy that made the feature
    //   unbuildable) plus the browser-resolve plugin; new client.ts is the
    //   browser-safe export surface a client or hybrid page bundles against;
    //   the loader context moved onto globalThis so separately bundled page
    //   and layout copies share it. Mostly the comments explaining each
    //   failure. +~187 → actual 8108. Ceiling 8160 leaves ~52 headroom.
    // Middleware (2026-08-25): `src/middleware.ts`, one function that runs
    //   before a request reaches anything. New runtime/middleware.ts (context,
    //   cookie parsing, matcher compilation, the runner) plus discovery in
    //   manifest.ts, bundling in build.ts, and dispatch in runtime/server.ts.
    //   Roughly half of the new file is the doc comment explaining the contract
    //   and the Celsian fast-response header trap. +~412 → actual 8520.
    //   Ceiling 8580 leaves ~60 headroom.
    // Server actions (2026-08-25): `src/actions/`, called from the browser by
    //   importing it. New runtime/actions.ts (globalThis-keyed registry,
    //   same-origin and double-submit CSRF gates, dispatch) and
    //   actions-build.ts (id derivation, the generated client stub, and the
    //   esbuild plugin that answers onResolve so an action file is never opened
    //   for a browser bundle) plus discovery in manifest.ts, bundling and entry
    //   codegen in build.ts, registration in runtime/server.ts and the endpoint
    //   in runtime/api-app.ts. The two new files are close to half comment: the
    //   registry, the id scheme and the stub boundary each exist because of a
    //   specific failure that is cheaper to explain than to rediscover.
    //   +~870 → actual 9390. Ceiling 9450 leaves ~60 headroom.
    // Streaming SSR (2026-08-25): `export const page = { streaming: true }`
    //   sends the shell before the body is rendered. No new file. static-render
    //   splits into a `documentShell()` the buffered wrapper composes, so the
    //   two documents cannot drift; runtime/pages.ts grows `prepareRender()`
    //   (shared by both renders, for the same reason), `isStreamingPage()`, and
    //   `createVuraStreamRoute()`. The stream route is mostly the reasoning for
    //   its own shape: why the loader chain is settled before the first byte
    //   (status is spent after it), why a lost reader is a disconnect and not a
    //   failure, and why the transfer encoding is left to the host.
    //   +~241 → actual 9631. Ceiling 9700 leaves ~69 headroom.
    // Celsian 0.6 alignment (2026-08-25): Vura now decides the HTTP status of
    //   its own errors instead of relying on the host framework to infer one.
    //   0.6 stopped honouring a bare `error.statusCode` (a driver error must
    //   not pick its own status), which flattened every `throw notFound()` from
    //   an API route to a 500. errors.ts gains a `Symbol.for` brand and
    //   `isHttpError()` — a brand rather than `instanceof`, because each server
    //   bundle inlines its own copy of core — and api-app.ts registers a
    //   trailing onError hook that answers with the error's own status. Most of
    //   the addition is the comment recording why a structural check would
    //   re-open the hole Celsian just closed, and the same brand gate in the
    //   generated serverless entry, which had the identical hole. +~76 →
    //   actual 9707. Ceiling 9760 leaves ~53 headroom.
    // Action-import boundary + shim allowlist (2026-08-28): actions-build.ts
    //   learns TypeScript's `.js` → `.ts` remap, which esbuild applies and this
    //   resolver did not, so `import { x } from '../actions/y.js'`, the only
    //   spelling the scaffold's own `moduleResolution: "Node16"` accepts, fell
    //   through to esbuild and inlined the real action module, secrets and all,
    //   into the browser bundle. It also stops failing open: a specifier aimed
    //   at src/actions/ that the resolver cannot place is now a build error, so
    //   the next gap is loud instead of silent. Most of the addition is those
    //   two reasons plus realpathOfDeepestExisting, which exists because the
    //   containment check needs both sides real-pathed and a missing file
    //   cannot be. runtime-shim.ts adds the eleven documented exports that were
    //   missing from its allowlist. +~122 → actual 9829. Ceiling 9880 leaves
    //   ~51 headroom.
    expect(locOf(join(__dirname, '..', 'src'))).toBeLessThan(9880);
  });
});
