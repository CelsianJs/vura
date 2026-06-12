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

Expected output:

```json
{
  "status": "completed",
  "result": { "deletedCount": 0 },
  "attempts": 1
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
finish. To run a task synchronously and see its result, use the CLI:
`vura tasks run <name>`.

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
