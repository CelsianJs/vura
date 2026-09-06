# Rung 6 — Deploy: getting to production

You need production.

## Two doors, stated honestly

**Self-host** — `vura build` emits a `dist/` directory. You run it with Node,
Docker, Fly.io, Railway, Cloudflare Workers, or AWS Lambda, within each target's
support matrix. Cache revalidation, websockets, ordinary tasks, and cron run in
the plain Node output without platform credentials. Its task state and waits
are in-process, not restart-durable.

**Vura managed deploy** — `vura deploy` ships in the open-source CLI. It requires
authentication, a linked project, a completed build, and the managed adapter.
The service is in private beta; [signup](https://app.vura.io/signup) requires an
access code. Installing the package does not grant service access.

The framework remains MIT-licensed. Managed deployment saves operational work,
but its durable task broker is not part of the standalone Node runner today.

## Self-host: the Node three-liner

```sh
pnpm build
PORT=3000 NODE_ENV=production node dist/server/entry.js
# → [vura] listening on port 3000
```

That is it for a VPS or any machine with Node 20+. `dist/server/entry.js` is
the unified server that handles static files, server-rendered pages, serverless
API routes, hot routes, and task cron — one process, one port.

For Docker, the build also emits `dist/Dockerfile` when the project has hot
routes. For Fly.io, `dist/fly.toml` is emitted with `auto_stop_machines = "off"`
and `kill_timeout = "30s"` so Fly never idle-stops a process holding live sockets.

## Self-host guide index

| Target | What it needs |
|---|---|
| [Node / VPS](/self-host/node-vps/) | Node 20+, a port |
| [Docker](/self-host/docker/) | Docker, any host |
| [Fly.io](/self-host/fly/) | `fly` CLI, persistent machines |
| [Railway](/self-host/railway/) | Railway project |
| [Cloudflare Workers](/self-host/cloudflare/) | `wrangler`, Workers account |
| [AWS Lambda](/self-host/lambda/) | `aws` CLI, Lambda + API Gateway |

## What hot routes need

Hot routes (websockets, in-memory state) require a **persistent process**. They
cannot run on Cloudflare Workers or AWS Lambda — those runtimes terminate the
process between requests and cannot hold a WebSocket open.

| Route kind | Node / VPS | Docker | Fly.io | Railway | CF Workers | Lambda |
|---|---|---|---|---|---|---|
| Serverless | yes | yes | yes | yes | yes | yes |
| Hot (WebSocket) | yes | yes | yes | yes | no | no |
| Task / cron | yes | yes | yes | yes | via `scheduled` event | yes (EventBridge) |

`vura build` emits a `[vura] N hot route(s) cannot run on <adapter> and were not bundled`
warning at build time if a hot route is detected and the selected adapter
cannot support it — it does not silently omit the route.

## Vura managed deploy

```sh
vura deploy
```

First authenticate with `vura login`, link a project, install
`@celsian/vura-adapter-vura`, and run `vura build`. The command uploads the
existing `dist/` output; `--prod` selects production instead of a preview.
Missing credentials, project linkage, build output, or adapter support produce
a non-zero exit. See the [CLI reference](/reference/cli/) for exact commands.

## Next

You have climbed the full ladder. Every capability — static pages, cached
server rendering, typed API routes, websockets, background tasks, and
production deploy — lives in one project with one build.

Return to **[the ladder overview →](/)** or pick a self-host guide from the
index above.
