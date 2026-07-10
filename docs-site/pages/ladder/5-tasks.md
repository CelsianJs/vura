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

## Where tasks run self-hosted

On a self-hosted Node deployment, task routes run inside the same `entry.js`
process — no external queue or separate worker process is required. The cron
engine is the Celsian cron scheduler, which fires in-process.

On Cloudflare Workers, task cron schedules are wired to the Worker's
`scheduled` event via `wrangler.toml` cron triggers. The adapter generates
this automatically when it detects scheduled task routes.

## Next

**[Rung 6 — Deploy →](/ladder/6-deploy/)**
