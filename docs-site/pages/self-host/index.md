# Self-host guides

`vura build` emits a `dist/` directory. Everything in it runs without Vura Platform credentials: cache revalidation, websockets, background tasks, and cron all work in the plain Node output. No account required.

## Route kind support by target

| Target | Serverless | Hot (WebSocket) | Task / cron |
|---|---|---|---|
| [Node / VPS](/self-host/node-vps/) | yes | yes | yes |
| [Docker](/self-host/docker/) | yes | yes | yes |
| [Fly.io](/self-host/fly/) | yes | yes | yes |
| [Railway](/self-host/railway/) | yes | yes | yes |
| [Cloudflare Workers](/self-host/cloudflare/) | yes | no | yes |
| [AWS Lambda](/self-host/lambda/) | yes | no | yes |

Hot routes (WebSockets, in-memory state) require a persistent process. Cloudflare Workers and Lambda terminate the process between invocations and cannot hold a socket open. `vura build` warns by name when hot routes are excluded.

## The CI-tested promise

Every guide below runs in CI on every commit — the exact commands you'll paste, executed by the six jobs in [`.github/workflows/selfhost.yml`](https://github.com/CelsianJs/vura/blob/main/.github/workflows/selfhost.yml). If a guide breaks, the build is red.

The CI jobs execute fenced code blocks extracted directly from each guide, so a guide can never silently drift from what CI actually runs.

## No-gating commitment

No framework capability is gated on the managed platform or any paid tier. The MIT license and no-gating commitment are documented in [GOVERNANCE.md](https://github.com/CelsianJs/vura/blob/main/GOVERNANCE.md) and enforced by [`tests/self-host-audit/`](https://github.com/CelsianJs/vura/tree/main/tests/self-host-audit) — assertions A0–A12 run in CI on every commit via the `selfhost-audit` job in `.github/workflows/ci.yml`.

## Choose a target

- **[Node / VPS](/self-host/node-vps/)** — the simplest path. One Node process, one port. All route kinds. Add a reverse proxy (Caddy) for HTTPS and WebSocket passthrough.
- **[Docker](/self-host/docker/)** — containerized. Same Node server, reproducible image. Good baseline for Kubernetes or any container-capable host.
- **[Fly.io](/self-host/fly/)** — the recommended host for hot routes. Persistent machines, global anycast, built-in TLS. `fly deploy ./dist` is the one-command path.
- **[Railway](/self-host/railway/)** — Dockerfile-based deploy on Railway's managed infrastructure. Shares the Docker guide's Dockerfile.
- **[Cloudflare Workers](/self-host/cloudflare/)** — edge-native serverless and task routes. Hot routes not supported. Uses `@celsian/vura-adapter-cloudflare` + `wrangler deploy`.
- **[AWS Lambda](/self-host/lambda/)** — serverless and task routes via Lambda + API Gateway SAM. Hot routes not supported. Uses `@celsian/vura-adapter-lambda` + AWS SAM.
