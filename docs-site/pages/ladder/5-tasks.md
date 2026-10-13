# Rung 5 — Background task: work off the request path

You need background work.

## A task route

A task route is a file in `src/api/` that is marked with `kind: 'task'`. It is
**not** exposed as a regular HTTP endpoint. Calls go through `/__tasks`. The
handler is the `POST` export, and it receives a context object with `attempt`
and `input`:

```ts
// src/api/cleanup.ts
export const route = { kind: 'task', retries: 2, timeout: 60_000 };

export const schedule = '0 3 * * *'; // nightly at 03:00 UTC

export async function POST(ctx: { attempt: number; input: unknown }) {
  console.log(`[cleanup] starting attempt ${ctx.attempt}`);

  const deletedCount = 0; // e.g. await db.deleteExpiredSessions();

  console.log(`[cleanup] done — deleted ${deletedCount} records`);
  return { deletedCount };
}
```

This is the exact shape the scaffold emits. The key points:

- `retries` and `timeout` go inside the `route` object — they are not
  top-level exports.
- `export const schedule` is a top-level sugar field that Vura reads to
  register the cron — it does not need to be inside `route`.
- `export const kind = 'task'` shorthand also works in place of
  `export const route = { kind: 'task' }` when you have no other config.

## Scheduling

The `schedule` field takes a standard five-field cron expression:

```
'0 3 * * *'   → every day at 03:00 UTC
'*/15 * * * *' → every 15 minutes
'0 9 * * 1'   → every Monday at 09:00 UTC
```

When the task has a schedule, the cron engine starts automatically with the
production server. Scheduled runs receive `{ _cron: true }` as `ctx.input`.
Manual triggers receive whatever JSON body was posted to `/__tasks/<name>`.

## Running a task manually

Use the CLI to trigger a task by name without waiting for the cron tick:

```sh
vura tasks run cleanup
```

Expected output (the task run envelope, see "Attempt metadata" below):

```json
{
  "ok": true,
  "taskName": "cleanup",
  "attempts": [
    { "index": 1, "startedAt": "2026-07-10T03:00:00.000Z", "durationMs": 4 }
  ],
  "status": "completed",
  "result": { "deletedCount": 0 }
}
```

Pass optional input with `--input`:

```sh
vura tasks run cleanup --input '{"dryRun":true}'
```

List all task routes in the project:

```sh
vura tasks list
```

Output:

```
  Task routes:

    cleanup  (cron: 0 3 * * *)
```

## Retries and timeouts

| Config key | Where | Default | Meaning |
|---|---|---|---|
| `retries` | inside `route` | `0` | extra attempts after first failure |
| `timeout` | inside `route` | `30000` | ms per attempt before timeout error |

Between attempts, Vura applies exponential backoff: `100 * 2^(attempt−1)` ms,
capped at 30 seconds. So with `retries: 2` you get three attempts: immediate,
~200 ms later, ~400 ms later.

## Typed input

A task can validate its payload before the handler runs by exporting an `input`
schema. Use the same validation kit as API routes — `defineSchema`, or any
Zod-compatible schema:

```ts
// src/api/cleanup.ts
import { z } from 'zod';

export const route = { kind: 'task', retries: 2 };

// The whole payload is validated against this schema.
export const input = z.object({
  olderThanDays: z.number().int().positive(),
  dryRun: z.boolean().default(false),
});

export async function POST(ctx: { attempt: number; input: unknown }) {
  const { olderThanDays, dryRun } = ctx.input as { olderThanDays: number; dryRun: boolean };
  // ...
}
```

You can also wrap it in `defineSchema({ body })` if you prefer the API-route
form — both are accepted, and the payload is validated against `body`.

When `input` is present, Vura validates the payload **before** invoking the
handler on every path that supplies a payload: the CLI `vura tasks run`, the
`/__tasks/<name>` HTTP trigger, and the dev server. A validation failure:

- responds with `400` and the standard validation body
  (`{ error, code: "VALIDATION_FAILED", details }`),
- does **not** invoke the handler, and
- consumes **no** retry attempts.

Scheduled (cron) runs use the synthetic `{ _cron: true }` input and are not
subject to `input` validation.

## Attempt metadata

Task runs are additive: the run response carries the full retry history so you
can see exactly what happened. Every task execution produces an envelope:

```ts
{
  ok: boolean;           // true when the run completed
  taskName: string;      // dot-form name, e.g. "cleanup"
  attempts: Array<{
    index: number;       // 1-based attempt number
    startedAt: string;   // ISO timestamp
    durationMs: number;  // wall-clock duration of the attempt
    error?: string;      // message-only error string when the attempt failed
  }>;
  result?: unknown;      // present only when ok is true
}
```

`error` is always the message only — never a stack trace. The envelope is
surfaced by `vura tasks run` (as shown above) and recorded on the job you poll
at `GET /__tasks/<id>` (as `ok` + `attempts`).

## Enqueuing from code

Call `enqueue()` to fire a task from anywhere in your app — a request handler,
another task, a hook:

```ts
import { enqueue } from '@celsian/vura-core';

await enqueue('cleanup', { olderThanDays: 30 }, {
  delaySeconds: 60,          // run ~1 minute from now
  idempotencyKey: 'nightly', // de-duplicate on the platform
});
```

| Option | Meaning |
|---|---|
| `delaySeconds` | delay before the task runs |
| `idempotencyKey` | key the platform uses to de-duplicate enqueues |

`enqueue()` returns the run record (`{ runId, status }` shape; extra fields are
preserved) and **throws** on a network or non-2xx failure — it never swallows
errors.

**On the platform.** When your app is deployed on Vura, `VURA_TASK_ENQUEUE_URL`
and `VURA_TASK_ENQUEUE_TOKEN` are injected automatically. `enqueue()` posts to
the platform's durable broker, which gives you at-least-once delivery and
honours `delaySeconds` durably.

**Self-hosted / local.** Without those env vars, `enqueue()` posts the payload
directly to your app's own `/__tasks/<name>` endpoint (authorised with
`THEN_TASK_SECRET`, or plain localhost in dev). This has **no durable queue**:
`delaySeconds` becomes a best-effort in-process timer, and a process restart
loses pending delayed runs. Set `VURA_LOCAL_TASK_URL` to override the target
base URL if your app does not listen on `http://127.0.0.1:$PORT`.

## Manual HTTP trigger

In production, POST to `/__tasks/<name>` with a `Bearer` token matching
`THEN_TASK_SECRET`:

```sh
curl -s -X POST http://localhost:3000/__tasks/cleanup \
  -H "Authorization: Bearer $THEN_TASK_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"dryRun":true}'
```

The HTTP trigger enqueues the run and responds immediately with
`202 {"id": "...", "status": "running"}` — it does not wait for the task to
finish. Poll `GET /__tasks/<id>` for the completed job, which includes `ok`
and the `attempts` metadata described above. To run a task synchronously and
see its result in one call, use the CLI: `vura tasks run <name>`.

If the task exports an `input` schema and the posted payload is
invalid, the trigger responds `400` with the standard validation body and never
starts a run.

In development with no `THEN_TASK_SECRET` set, localhost requests are allowed
without a token.

## Durable steps (`ctx.step`)

Long tasks can use **step memoization** to reuse recorded outputs on replay.
Restart-durable delivery and waits currently require the managed broker to
persist steps and re-dispatch runs. Standalone Node keeps task state and waits
in-process; it does not provide that persistence loop. An external effect can
succeed before its checkpoint is persisted, so payments and other
non-idempotent writes still need provider idempotency keys or transactional
deduplication. A step is not an exactly-once side-effect guarantee.

The task handler receives a `step` object on its context:

```ts
// src/api/onboard.ts
export const route = { kind: 'task', retries: 3 };

export async function POST({ input, step }) {
  const user = input as { userId: string };

  // Reuses its recorded output on replay when a checkpoint exists.
  const profile = await step.run('load-profile', async () => {
    return await db.users.find(user.userId);
  });

  // Kick off a child task and wait for its result (suspends the run).
  const enriched = await step.waitForTask('enrich', 'tasks.enrich', profile);

  // Wait 24h before the follow-up — durably, not a held-open process.
  await step.sleep('cooldown', 24 * 60 * 60);

  // Block until someone completes a token (e.g. an approval webhook).
  const decision = await step.waitForToken('approval', { timeoutSeconds: 3600 });
  if ('timedOut' in decision) return { status: 'expired' };

  await step.run('send-welcome', async () => sendEmail(profile.email));
  return { status: 'onboarded', enriched };
}
```

### The step API

| Call | What it does |
|---|---|
| `step.run(key, fn)` | Runs `fn` when no recorded result exists; reuses recorded output on replay. External effects still need idempotency. |
| `step.enqueue(key, task, payload?, opts?)` | Enqueues a task (memoized), returns `{ runId }`. Fire-and-forget. |
| `step.waitForTask(key, task, payload?, opts?)` | Enqueues a child and **waits** for its terminal `{ ok, result?, error? }`. A child failure is **returned**, never thrown. |
| `step.sleep(key, seconds)` | Durable wait with the managed broker; in-process timer otherwise. |
| `step.sleepUntil(key, date)` | Sleep until an absolute instant. |
| `step.waitForToken(key, { timeoutSeconds? })` | Wait for an externally-completed token; resolves to `{ payload }` or `{ timedOut: true }`. |

Every `key` must be **unique within one run** — reusing a key throws a clear
error. Keys are how replays line up recorded outputs with `step.*` calls.

### Replay semantics — put side effects inside `step.run`

This is the one rule that matters: **the handler body re-runs from the top on
every re-invocation.** When a run resumes after a wait, Vura calls your handler
again from the first line; each `step.*` call replays its memoized result until
execution reaches the point that must wait next.

So anything with a side effect — a database write, an email, a charge — must
live **inside** `step.run` (or another step). Code in the bare handler body runs
on *every* replay:

```ts
export async function POST({ step }) {
  // ❌ BAD: runs on every replay — the user gets charged multiple times.
  await chargeCard();

  // Reuses a recorded result; chargeCard must also use a stable idempotency key.
  await step.run('charge', () => chargeCard());
}
```

Reads and pure computation are fine to leave in the body (they just re-run), but
when in doubt, wrap it in a step.

### How suspend/resume works

When your handler hits a `waitForTask`/`sleep`/`sleepUntil`/`waitForToken` that
isn't already satisfied, the step throws an internal signal that unwinds the
handler and **suspends** the run. This is not a failure and consumes **no retry
attempt** — the run envelope reports `ok: true` with a `suspended` waitpoint and
the steps completed so far:

```jsonc
{
  "ok": true,
  "taskName": "onboard",
  "suspended": {
    "stepKey": "approval",
    "waitpoint": { "kind": "TOKEN", "timeoutSeconds": 3600 }
  },
  "steps": {
    "load-profile": { "status": "completed", "output": { /* ... */ } }
  }
}
```

On the platform, when the waitpoint completes (the child run finishes, the sleep
elapses, or the token is completed) Vura re-dispatches the **same run** with the
merged `steps` map — the waited step now present as completed — and your handler
replays to the next wait or to completion.

### Local dev caveats

Under `vura dev` (and any self-hosted run without the platform), there is no
durable queue to suspend into, so waits resolve **best-effort in-process**:

- `step.sleep` / `step.sleepUntil` are real in-process timers (a very long sleep
  can exceed the task `timeout` and fail — that's a dev-only artifact).
- `step.waitForTask` **directly dispatches the child task and awaits its
  result** — `vura dev`, the standalone server, and `vura tasks run` all resolve
  children in-process.
- `step.waitForToken` resolves `{ timedOut: true }` after its `timeoutSeconds`
  (capped at 60s), since there is no platform to complete the token.

Vura logs a one-time note the first time a durable wait runs locally. Deploy on
Vura for real suspend/resume that survives restarts.

## Where tasks run self-hosted

On a self-hosted Node deployment, task routes run inside the same `entry.js`
process — no external queue or separate worker process is required. The cron
engine is the Celsian cron scheduler, which fires in-process.

On Cloudflare Workers, task cron schedules are wired to the Worker's
`scheduled` event via `wrangler.toml` cron triggers. The adapter generates
this automatically when it detects scheduled task routes.

## Next

**[Rung 6 — Deploy →](/ladder/6-deploy/)**
