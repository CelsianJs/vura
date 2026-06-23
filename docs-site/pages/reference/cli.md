# CLI reference

Vura ships two executables: `vura` (the project CLI) and `create-vura` (the scaffolder).

---

## `vura dev`

Start the local development server.

```sh
vura dev [--port <n>] [--host <addr>]
```

| Flag | Default | Effect |
|---|---|---|
| `--port <n>` | `3000` | Port to listen on. |
| `--host <addr>` | `127.0.0.1` | Host to bind. Use `0.0.0.0` to expose on the local network. |

**Expected output:**

```
  vura dev

  Root: /home/user/my-app
  Scanning routes...
  Found 3 API routes (2 serverless, 1 hot, 0 task)
  Found 4 pages
  Ready on http://localhost:3000
```

File changes to `src/api/` and `src/pages/` are picked up without restart. Type changes to route config (e.g. changing `kind`) require a page reload.

Hot routes that export a `websocket()` handler accept WebSocket upgrades in dev (requires the `ws` package; the scaffold includes it). Edits to a hot route file apply on the next connection, and per-route `origins` allowlists are enforced just like in production.

---

## `vura build`

Build the project for production.

```sh
vura build
```

No flags. Reads `vura.config.ts` (or `.js`) from the current directory.

**Expected output:**

```
  vura build

  Root: /home/user/my-app
  Scanning routes...
  Found 3 API routes (2 serverless, 1 hot, 0 task)
  Found 4 pages
  Bundling server entry...
  Bundling serverless functions...
  Bundling browser entries...
  Rendering static pages...
  Running adapter buildEnd...
  Writing manifest.json
  Emitting hot deploy templates (Dockerfile, fly.toml)...

  Route summary:
  λ /api/hello                  serverless
  λ /api/orders                 serverless
  ● /api/live/room               hot
  ◆ /                            static
  ◆ /about                       static
  ◈ /blog/:slug                  server
  ◇ /dashboard                   client

  built in 1.4s → dist/
```

`dist/Dockerfile` and `dist/fly.toml` are emitted only when hot routes are present in the project.

---

## `vura tasks list`

List all task routes in the project.

```sh
vura tasks list
```

**Expected output:**

```
  Task routes:

    cleanup  (cron: 0 3 * * *)
    notify
```

Runs against the source files; does not require a running server.

---

## `vura tasks run`

Trigger a task by name immediately, with the same retry and timeout semantics as the production server.

```sh
vura tasks run <name> [--input <json>]
```

| Argument / Flag | Description |
|---|---|
| `<name>` | Task name derived from the file path: `/api/report` → `report`, `/api/jobs/notify` → `jobs.notify` |
| `--input <json>` | Optional JSON string passed as `ctx.input` to the handler. |

**Expected output (success):**

```json
{
  "status": "completed",
  "result": { "deletedCount": 42 },
  "attempts": 1
}
```

**Expected output (unknown task):**

```
  Unknown task: "typo"
  Available tasks: cleanup, jobs.notify
```

Exits with code `1` on failure (unknown task, handler throws, exhausted retries).

---

## `vura routes inspect`

Inspect source routes as user-facing runtime profiles without deploying or
mutating infrastructure.

```sh
vura routes inspect [--json]
```

Profiles map current route/page declarations into Vura Platform vocabulary:
`static`, `cold`, `hot`, `task-cold`, and `cron-cold`. Planned profiles such as
`task-hot` remain advice only until platform proof exists.

Use `--json` for agent-readable output with:

- route/task pattern,
- source intent (`kind:*` or `mode:*`),
- effective profile,
- backing target,
- schedule/websocket metadata,
- warnings,
- exact next command where one exists.

---

## `vura runtime advise`

Explain deterministic runtime-placement recommendations from the local manifest.
This command is read-only and never promotes, demotes, deploys, or creates
provider resources.

```sh
vura runtime advise [--json]
```

The first advisor pass is manifest-only:

- WebSocket routes confirm or recommend `hot`.
- Server/hybrid pages confirm `hot` server entry placement.
- Task routes confirm `task-cold`.
- Scheduled task routes confirm `cron-cold` dispatch.
- Long task timeouts warn about planned `task-hot` placement.

---

## `vura deploy`

```sh
vura deploy
```

Reserved for the managed Vura Platform. The current open-source CLI exits immediately with:

```
  vura deploy is not available in the open-source CLI yet.

  What works today:
    vura build      Build production artifacts locally
    vura manifest   Inspect route/deployment classification
    vura dev        Run the local development server

  Managed deployments are handled by Vura Platform and are not part of this
  OSS package release. See https://github.com/CelsianJs/vura#readme for the
  current self-hosted build and adapter guidance.
```

Exits with code `1`. This is not a gate on capability — `vura build` produces deployable artifacts for all self-host targets today. See the [self-host guides](/self-host/).

---

## `create-vura`

Scaffold a new Vura project.

```sh
npm create vura@latest [project-name] [--no-install]
# or
npx create-vura [project-name] [--no-install] [--dry-run]
```

| Flag | Effect |
|---|---|
| `--no-install` | Write files but skip dependency installation. Useful for CI or offline environments. |
| `--dry-run` | Print what would be written without touching the filesystem. |
| `--help` / `-h` | Print usage. |

When `project-name` is omitted, the scaffolder prompts interactively.

**Expected output:**

```
  create-vura

  Creating project in /home/user/my-app...

  ✓ package.json
  ✓ vura.config.ts
  ✓ src/pages/index.tsx
  ✓ src/api/hello.ts
  ✓ src/api/live/room.ts

  Installing dependencies...
  ✓ done

  Next:
    cd my-app
    npm run dev
```

The scaffold includes a static home page, a serverless `/api/hello` route, and a hot `/api/live/room` WebSocket route — the same surface the self-host CI jobs smoke-test.
