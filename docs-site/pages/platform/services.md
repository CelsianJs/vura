# Services

**What you'll have at the end:** one or more long-running processes, such as an API, a collector and a queue worker, running on Vura from their start commands, each on its own machine.

> Services are rolling out team by team. If saving services says they are not enabled, ask us to turn them on.

## Declare services

In `vura.json` at your project root:

```json
{
  "node": 24,
  "build": "pnpm run build",
  "services": {
    "api":    { "type": "web", "start": "node dist/api.mjs", "health": "/health" },
    "worker": { "type": "worker", "start": "node dist/worker.mjs", "size": "small" }
  }
}
```

Or add them in the dashboard under **Settings → Services**. When `vura.json` has `services`, it wins field by field. The dashboard marks fields it sets as "set in vura.json", and dashboard services the file leaves out as "not in vura.json".

| Field | Meaning |
|---|---|
| `type` | `web` gets an HTTPS host; `worker` has no public port at all |
| `start` | the command, run with `/bin/sh -c` in the service directory. It must stay in the foreground (no `&`, `nohup`, `pm2 start`) |
| `root` | directory to run in, relative to the repo (default: the project root) |
| `health` | web: a path such as `"/health"` that must answer 2xx within 2 s (default: the port accepts connections). worker: `{ "port": 4711, "path": "/health" }` (default: the process is alive) |
| `size` | `nano` 256 MB · `small` 512 MB (default) · `medium` 1 GB · `large` 2 GB / 2 vCPU. Pro allows up to 1 GB / 2 vCPU per machine, so `medium` is the largest size Pro plans currently reach |
| `concurrency` | web only: connections one machine takes at once (default 250, max 2000) |

Service names start with a lowercase letter and use only lowercase letters, digits and `-`, up to 20 characters. They cannot contain `--`, start with `d-`, or end with `-`. A project has at most 10 services.

## Ports and hosts

Your app must listen on `process.env.PORT` (3001) and host `process.env.HOST` (loopback, `127.0.0.1`). Vura's supervisor is the only thing listening publicly on the machine, and it forwards only signed requests from the Vura edge. Binds to `0.0.0.0` or `::` are pinned back to that same loopback host.

- The **primary** web service (named `web`, or else the first web service) answers on `<project>-<team>.vura.app` and on your custom domains.
- Every other web service answers on `<service>--<project>-<team>.vura.app`. You can also point a custom domain at it: pick the service when adding the domain.
- Workers have no host.

## Env vars per service

On **Settings → Environment Variables**, choose **All services** or one service. A service gets the all-services values, overridden by its own. The build only sees all-services values. Names starting with `FLY_`, `R2_`, `CLOUDFLARE_`, `EDGE_`, `HOT_ORIGIN_`, `INTERNAL_EDGE_`, `VURA_ORIGIN_AUTH_`, `VURA_RUNTIME_` or `VURA_SERVICE_` are reserved at runtime; save them with target "Build" instead if you need them during the build.

## Client IP

Read the caller's address from `x-vura-client-ip`. The Vura edge always overwrites it from Cloudflare's verified connecting IP before your request reaches your service, so it is the one header you can trust. `x-forwarded-for`, `x-real-ip` and `fly-client-ip` are also rewritten to the same address for compatibility with generic middleware, but `x-vura-client-ip` is the canonical, documented one to read.

## Deploys, promotion and rollback

- Services run on production deployments. A preview responds "Services run on production deployments only. Promote this deployment to serve it."
- Every service must pass its health check and stay up for a few seconds, or the deploy fails and production stays where it was.
- On promotion, the previous deployment's workers stop right away. Its web machines keep serving in-flight requests for an hour, for instant rollback.
- Rollback starts the older deployment's machines again, or re-creates them.

## Logs

Runtime logs show `[service]` on each line. Filter by service on the deployment page.
