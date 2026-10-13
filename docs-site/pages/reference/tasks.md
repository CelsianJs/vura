# Tasks

A **task** is a route that runs off the request path — on a schedule, on demand, or enqueued from your own code. Tasks get typed inputs and automatic retries with backoff. `ctx.step` supports replay from recorded outputs; restart-durable delivery and waits currently require the managed broker. Standalone Node runs use in-process state and timers.

This is the API reference. For a step-by-step walkthrough, start with the [Background task rung](/ladder/5-tasks).

```ts
// src/api/cleanup.ts
export const route = { kind: 'task', retries: 2, timeout: 60_000 };
export const schedule = '0 3 * * *'; // nightly at 03:00 UTC

export async function POST(ctx: { attempt: number; input: unknown }) {
  const deleted = await db.deleteExpiredSessions();
  return { deleted };
}
```

A task is a file in `src/api/` with `kind: 'task'`. It is **not** an HTTP endpoint — it's invoked through the task surface below.

---

## Route config

Set the kind (and optional retry/timeout) with an exported `route` object. Use the `kind` shorthand when you have no other config.

```ts
export const route = { kind: 'task', retries: 2, timeout: 60_000 };
// or, with no config:
export const kind = 'task';
```

| Field | Type | Default | Effect |
|---|---|---|---|
| `retries` | `number` | `0` | Extra attempts after the first failure. `retries: 2` → up to 3 attempts. |
| `timeout` | `number` (ms) | `30000` | Per-attempt timeout before the attempt fails (and retries, if any remain). |

Between attempts Vura applies exponential backoff: `100 × 2^(attempt−1)` ms, capped at 30 seconds.

---

## Schedule

Export a `schedule` — a standard five-field cron expression — to run the task automatically. It can be a top-level export; it does not need to live inside `route`.

```ts
export const schedule = '*/15 * * * *'; // every 15 minutes
```

When a task has a schedule, the cron engine starts with the server. Scheduled runs receive `{ _cron: true }` as `ctx.input` and **skip input validation**. Set `VURA_DISABLE_IN_PROCESS_CRON=1` to turn off the in-process scheduler (e.g. when an external scheduler drives runs).

---

## Typed input

Export an `input` schema to validate the payload before the handler runs. Use `defineSchema` or any Zod-compatible schema.

```ts
import { z } from 'zod';

export const input = z.object({
  olderThanDays: z.number().int().positive(),
  dryRun: z.boolean().default(false),
});
```

Validation runs on every payload-bearing path — the CLI, the `/__tasks/<name>` trigger, and the dev server — **before** the handler. A failure responds `400` with `{ error, code: "VALIDATION_FAILED", details }`, never invokes the handler, and **consumes no retry attempt**. Scheduled (cron) runs use synthetic input and are exempt.

---

## The handler context

```ts
export async function POST(ctx) {
  ctx.attempt; // 1-based attempt number
  ctx.input;   // validated payload (or { _cron: true } for scheduled runs)
  ctx.step;    // durable-execution API — see below
}
```

---

## `enqueue()`

Fire a task from anywhere in your app — a request handler, another task, a hook.

```ts
import { enqueue } from '@celsian/vura-core';

await enqueue('cleanup', { olderThanDays: 30 }, {
  delaySeconds: 60,
  idempotencyKey: 'nightly',
});
```

```ts
enqueue(taskName: string, payload?: unknown, opts?: EnqueueOptions): Promise<EnqueueResult>
```

| Option | Type | Effect |
|---|---|---|
| `delaySeconds` | `number` | Delay before the task runs. Durable **only** on the platform. |
| `idempotencyKey` | `string` | Key the platform uses to de-duplicate enqueues. |

`enqueue()` returns the run record (`{ runId, status }`; extra fields preserved) and **throws** on a network or non-2xx failure — it never swallows errors.

- **On the platform.** `VURA_TASK_ENQUEUE_URL` and `VURA_TASK_ENQUEUE_TOKEN` are injected automatically; `enqueue()` posts to the durable broker (at-least-once delivery, durable `delaySeconds`).
- **Self-hosted / local.** Without those vars, `enqueue()` posts to your app's own `/__tasks/<name>` endpoint (authorized with `THEN_TASK_SECRET`, or plain localhost in dev). No durable queue: `delaySeconds` is a best-effort in-process timer that a restart loses. Set `VURA_LOCAL_TASK_URL` to override the target base URL.

---

## Durable steps — `ctx.step`

Long tasks can use **step memoization** to reuse recorded outputs on replay.
With the managed broker persisting completed steps and re-dispatching runs,
waits can suspend without keeping a process alive. Standalone Node does not
provide that persistence or re-dispatch loop. Memoization is not an exactly-once
guarantee for external side effects: an effect may succeed before its checkpoint
is persisted. Use provider idempotency keys or transactional deduplication for
payments, emails, and other non-idempotent writes.

```ts
export async function POST({ input, step }) {
  const profile = await step.run('load', () => db.users.find(input.userId));
  const enriched = await step.waitForTask('enrich', 'tasks.enrich', profile);
  await step.sleep('cooldown', 24 * 60 * 60);
  await step.run('welcome', () => sendEmail(profile.email));
  return { enriched };
}
```

### The one rule: side effects go inside `step.run`

**The handler body re-runs from the top on every re-invocation.** When a run resumes after a wait, Vura calls your handler again from the first line; each `step.*` call replays its recorded result until execution reaches the next unmet wait. So anything with a side effect — a write, an email, a charge — must live **inside** a step:

```ts
await chargeCard();                     // ❌ runs on every replay — double charge
await step.run('charge', chargeCard);   // reuses a recorded result; chargeCard must be idempotent
```

Reads and pure computation are safe to leave in the body.

### Step API

| Call | Signature | What it does |
|---|---|---|
| `step.run` | `run<T>(key, fn): Promise<T>` | Runs `fn` when no recorded result exists. Replays reuse the recorded output; external effects still need idempotency. |
| `step.enqueue` | `enqueue(key, task, payload?, opts?): Promise<{ runId }>` | Memoized enqueue. Fire-and-forget. |
| `step.waitForTask` | `waitForTask(key, task, payload?, opts?): Promise<ChildRunResult>` | Enqueues a child and **waits** for its `{ ok, result?, error? }`. A child failure is **returned**, never thrown. |
| `step.sleep` | `sleep(key, seconds): Promise<void>` | Durable wait with the managed broker; in-process timer otherwise. |
| `step.sleepUntil` | `sleepUntil(key, date): Promise<void>` | Sleep until an absolute instant (`Date` or ISO string). |
| `step.waitForToken` | `waitForToken<T>(key, { timeoutSeconds? }): Promise<{ payload?: T } \| { timedOut: true }>` | Wait for an externally-completed token. |

Every `key` must be **unique within one run** — reusing a key throws a `DuplicateStepKeyError`. Keys are how replays line up recorded outputs with `step.*` calls.

### Suspend / resume

When your handler hits a `waitForTask` / `sleep` / `sleepUntil` / `waitForToken` that isn't already satisfied, the step throws an internal `SuspendSignal` that unwinds the handler and **suspends** the run. This is not a failure and consumes **no retry attempt** — the run envelope reports `ok: true` with a `suspended` waitpoint and the steps completed so far. On the platform, when the waitpoint completes, Vura re-dispatches the **same run** with the accumulated `steps` map, and your handler replays to the next wait or to completion.

### Local dev and standalone self-hosting

Under `vura dev` (and any self-hosted run with no platform), there's no durable queue, so waits resolve **best-effort in-process**:

- `sleep` / `sleepUntil` — real in-process timers (a very long sleep can exceed the task `timeout` — a dev-only artifact).
- `waitForTask` — directly dispatches the child and awaits it in-process.
- `waitForToken` — resolves `{ timedOut: true }` after `timeoutSeconds` (capped at 60s).

Vura logs a one-time note the first time a durable wait runs locally. Deploy on Vura for real suspend/resume that survives restarts.

---

## Running and inspecting tasks

### CLI

```sh
vura tasks list                          # list task routes and schedules
vura tasks run cleanup                    # run once, synchronously, print the envelope
vura tasks run cleanup --input '{"dryRun":true}'
```

See the [CLI reference](/reference/cli#vura-tasks-list) for full flags.

### HTTP surface

Task names derive from the file path: `/api/report` → `report`, `/api/jobs/notify` → `jobs.notify`.

| Request | Effect |
|---|---|
| `GET /__tasks` | List registered task routes. |
| `POST /__tasks/<name>` | Enqueue a run; responds `202 { id, status: "running" }` immediately (does not wait). |
| `GET /__tasks/<id>` | Poll a run's job — includes `ok`, `attempts`, and any `suspended` waitpoint. |

In production, `/__tasks/*` requires `Authorization: Bearer $THEN_TASK_SECRET`. In dev with no secret set, localhost requests are allowed without a token.

```sh
curl -s -X POST http://localhost:3000/__tasks/cleanup \
  -H "Authorization: Bearer $THEN_TASK_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"dryRun":true}'
```

### Run envelope

Every execution produces an envelope carrying the full retry history:

```ts
{
  ok: boolean;          // true unless the run failed
  taskName: string;     // dot-form name, e.g. "cleanup"
  attempts: Array<{
    index: number;      // 1-based attempt number
    startedAt: string;  // ISO timestamp
    durationMs: number; // wall-clock duration
    error?: string;     // message-only error when the attempt failed
  }>;
  result?: unknown;     // present when ok is true
  suspended?: { stepKey: string; waitpoint: Waitpoint }; // present when a step suspended the run
  steps?: Record<string, { status: 'completed' | 'timed_out'; output?: unknown }>;
}
```

`error` is always the message only — never a stack trace.

---

## Where tasks run

| Target | Behavior |
|---|---|
| Node / VPS, Docker, Fly, Railway | Tasks run inside the same server process. The in-process cron engine fires schedules. No external queue or worker needed. |
| Cloudflare Workers | Cron schedules are wired to the Worker's `scheduled` event via generated `wrangler.toml` triggers. |
| Vura Platform | Broker integration for at-least-once delivery, durable `delaySeconds`, and `ctx.step` suspend/resume; requires managed-service access. |

See [Route kinds](/reference/route-kinds) and the [Adapters reference](/reference/adapters) for the full per-target picture.
