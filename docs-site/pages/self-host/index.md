# Self-host guides

`vura build` emits a `dist/` directory. Cache revalidation, websockets, ordinary background tasks, and cron run in the plain Node output without Vura Platform credentials. No account required. Standalone task state and waits are in-process; restart-durable queue delivery and suspend/resume currently require the managed broker.

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

## Page mode support by target

| Target | `static` | `client` | `hybrid` | `server` | `revalidate` (ISR) | `streaming` |
|---|---|---|---|---|---|---|
| [Node / VPS](/self-host/node-vps/) | yes | yes | yes | yes | yes | yes |
| [Docker](/self-host/docker/) | yes | yes | yes | yes | yes | yes |
| [Fly.io](/self-host/fly/) | yes | yes | yes | yes | yes | yes |
| [Railway](/self-host/railway/) | yes | yes | yes | yes | yes | yes |
| [Cloudflare Workers](/self-host/cloudflare/) | yes | yes | yes | yes | no | yes |
| [AWS Lambda](/self-host/lambda/) | yes | yes | yes | yes | no | buffered |

`static`, `client` and `hybrid` pages are rendered at build time; every target
serves them as files. `server` pages render per request, with their loaders, on
every target.

Where a target cannot match the Node server, `vura build` says so by name
rather than shipping quietly: an `revalidate` page that will not be cached, a
`streaming` page that will be buffered, and a `server` page that cannot be
bundled at all (which fails the build outright, because a build that ships
without a page serves 404 for it).

## The CI-tested promise

**Middleware and actions:** `src/middleware.ts` and server actions run in Node,
Docker, Fly, and Railway output, but are not executed by the Cloudflare or Lambda
adapters. On those targets, authorization must live in the API handler or page
loader accessing protected data. Server-page support does not imply middleware
or action support. See [middleware](/reference/middleware/) and
[actions](/reference/actions/).

Every guide below runs in CI on every commit — the exact commands you'll paste, executed by the seven jobs in [`.github/workflows/selfhost.yml`](https://github.com/CelsianJs/vura/blob/main/.github/workflows/selfhost.yml). If a guide breaks, the build is red.

The CI jobs execute fenced code blocks extracted directly from each guide, so a guide can never silently drift from what CI actually runs.

## No-gating commitment

The MIT license and commitment not to move framework features behind the managed service are documented in [GOVERNANCE.md](https://github.com/CelsianJs/vura/blob/main/GOVERNANCE.md). The [`self-host audit`](https://github.com/CelsianJs/vura/tree/main/tests/self-host-audit) verifies ordinary Node capabilities without platform credentials, including assertions A0–A12. It does not prove restart-durable task execution or identical capabilities on every target; those limitations are stated above.

## Choose a target

- **[Node / VPS](/self-host/node-vps/)** — the simplest path. One Node process, one port. All route kinds. Add a reverse proxy (Caddy) for HTTPS and WebSocket passthrough.
- **[Docker](/self-host/docker/)** — containerized. Same Node server, reproducible image. Good baseline for Kubernetes or any container-capable host.
- **[Fly.io](/self-host/fly/)** — the recommended host for hot routes. Persistent machines, global anycast, built-in TLS. `fly deploy ./dist` is the one-command path.
- **[Railway](/self-host/railway/)** — Dockerfile-based deploy on Railway's managed infrastructure. Shares the Docker guide's Dockerfile; upload `dist/` so the build context matches it.
- **[Cloudflare Workers](/self-host/cloudflare/)** — edge-native serverless and task routes. Hot routes not supported. Uses `@celsian/vura-adapter-cloudflare` + `wrangler deploy`.
- **[AWS Lambda](/self-host/lambda/)** — serverless and task routes via Lambda + API Gateway SAM. Hot routes not supported. Uses `@celsian/vura-adapter-lambda` + AWS SAM.
