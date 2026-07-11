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

## `vura admin`

Launch a local web dashboard for the current project — routes, deployment targets, build output, and environment variables — inspired by Vercel's dashboard.

```sh
vura admin [--port <n>] [--host <addr>]
```

| Flag | Default | Effect |
|---|---|---|
| `--port <n>` | `4000` | Port to listen on. |
| `--host <addr>` | `127.0.0.1` | Host to bind. **Must be a loopback address** (`127.0.0.1`, `localhost`, or `::1`). |

The dashboard scans your project with `buildManifest`, shows API routes and pages, reports which build artifacts exist under `dist/`, and lets you **edit `.env` and `.env.local`** in the browser.

**Loopback only, by design.** Because the dashboard reads and writes local secrets, `vura admin` refuses to bind to a non-loopback host and exits with an error. Its API is additionally guarded by a per-session token and same-origin checks.

**Expected output:**

```
  ┌─────────────────────────────────────────┐
  │                                         │
  │   vura admin                            │
  │                                         │
  │   Dashboard: http://localhost:4000      │
  │   Token:     a1b2c3d4                    │
  │   Project:   my-app                      │
  │                                         │
  │   3 API routes · 4 pages                 │
  │                                         │
  └─────────────────────────────────────────┘
```

The server runs until interrupted (`Ctrl-C`).

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

## `vura login`

Authenticate the CLI against the Vura Platform (see `vura deploy` below). Credentials are written to `~/.vura/credentials` at mode `0600`, the same file every other platform-aware command reads.

```sh
vura login
vura login --token <token>
```

| Flag | Effect |
|---|---|
| `--token <t>` | Store this token directly ("paste-token" mode) instead of prompting for email/password. The token is verified against the API before it's saved. |
| `--api-url <url>` | API base URL (else `VURA_API_URL`, else `https://api.vura.io`). |

With no flags, `vura login` prompts interactively for an email and password (masked) and exchanges them for a token. Interactive mode requires a real terminal — in CI or other non-interactive environments, use `--token` with a token obtained separately.

---

## `vura teams` / `vura projects`

Thin wrappers over the Vura Platform's team and project APIs. Every subcommand resolves the auth token the same way `vura deploy` does (`--token` > `VURA_TOKEN` > `~/.vura/credentials`) and prints `run vura login` on a `401`.

```sh
vura teams list
vura teams create <name> [--slug <slug>]

vura projects list [--team <id-or-slug>]
vura projects create <name> [--team <id-or-slug>]
```

- `--team` accepts either a team id or a team slug. If omitted, the CLI uses your only team — every account gets one automatically at signup. With multiple teams, `--team` is required and the error lists your team slugs to choose from.
- `vura projects create` derives a slug from `<name>` automatically (mirroring how the API itself derives slugs) — an explicit slug flag isn't needed.
- If the current directory looks like a Vura project (a `vura.config.*` is present) and isn't already linked, `vura projects create` writes `.vura/project.json` for you, so `vura deploy` picks up the new project immediately. It never overwrites an existing link.

---

## `vura deploy`

```sh
vura deploy [--prod] [--token <t>] [--api-url <u>] [--project-id <id>]
```

Deploys the `dist/` build output to the Vura Platform. The command ships in the open-source CLI and runs through these checks —

1. Resolve an auth token (`--token` > `VURA_TOKEN` > `~/.vura/credentials`, i.e. whatever `vura login` wrote). Missing → `Not authenticated. Run vura login, set VURA_TOKEN, or pass --token <token>.`
2. Resolve a linked project (`--project-id` > `VURA_PROJECT_ID` > `.vura/project.json`, i.e. whatever `vura projects create` wrote). Missing → points you at `vura teams list` and `vura projects create`.
3. Require a build at `dist/manifest.json` → run `vura build` first if missing.
4. Upload via `@celsian/vura-adapter-vura`'s `deployToVura`. That adapter package is published to npm as an optional peer dependency of the CLI, so it isn't pulled in automatically — if it's missing, this step fails with:

   ```
     Managed Vura deploy support is not installed in this CLI package.
     Install it with: npm install @celsian/vura-adapter-vura
   ```

Exits with code `1` when any step fails. This is not a gate on capability — `vura build` produces deployable artifacts for all self-host targets today regardless of platform access. See the [self-host guides](/self-host/).

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
