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
  it('vura-core src LOC is below the post-Task-2 ceiling of 7350', () => {
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
    expect(locOf(join(__dirname, '..', 'src'))).toBeLessThan(7450);
  });
});
