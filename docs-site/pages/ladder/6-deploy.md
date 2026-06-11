# Rung 6 — Deploy: getting to production

You need production.

## Two doors, stated honestly

**Self-host** — `vura build` emits a `dist/` directory. You run it with Node,
Docker, Fly.io, Railway, Cloudflare Workers, or AWS Lambda. Everything works
with zero platform credentials: cache revalidation, websockets, tasks, and
cron all run in the plain Node output.

**Vura managed deploy** — `vura deploy` is the one-command managed path. In
the current open-source CLI it requires platform access and fails closed
when credentials are absent — the error message tells you so. It is in
private beta.

Neither door gates capability. The managed deploy saves effort; it does not
withhold features.

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
| Task / cron | yes | yes | yes | yes | via `scheduled` event | no |

`vura build` tells you at build time if a hot route is detected and the
selected adapter cannot support it — it will not silently omit the route.

## Vura managed deploy

```sh
vura deploy
```

This is the zero-config path: no `dist/` to manage, no server to provision.
It requires platform credentials. Without them the CLI prints a clear error
and exits with a non-zero code — it never silently proceeds. Platform access
is in private beta; see the README for how to join.

## Next

You have climbed the full ladder. Every capability — static pages, cached
server rendering, typed API routes, websockets, background tasks, and
production deploy — lives in one project with one build.

Return to **[the ladder overview →](/)** or pick a self-host guide from the
index above.
