# Cloudflare Workers

**What you'll have at the end:** a Vura app deployed to Cloudflare Workers for edge-native serverless and task routes.

Supports: serverless, task (via `scheduled` cron event). **Hot routes are not supported** — see the limitation box below.

---

## Steps

### 1. Install the adapter

```sh
npm install @celsian/vura-adapter-cloudflare
```

### 2. Configure the adapter

```ts
// vura.config.ts
import { defineConfig } from '@celsian/vura-core';
import { cloudflareAdapter } from '@celsian/vura-adapter-cloudflare';

export default defineConfig({
  adapter: cloudflareAdapter({
    name: 'my-worker',
  }),
});
```

### 3. Build

```sh
npm run build
```

Expected output includes the adapter step:

```
  Adapter: cloudflare
```

Emitted artifacts:

```
dist/cloudflare/
  wrangler.toml
  entry.js
  routes/
    src_api_hello.js
    ...
  pages.js            # only when the project has `server` pages
  assets/             # only when the project has pages
    index.html
    about/index.html
    _then/pages/...
```

### 4. The wrangler.toml

The generated `dist/cloudflare/wrangler.toml` for a project with one serverless
route, one task route with a schedule, and pages looks like:

```toml
name = "my-worker"
main = "entry.js"
compatibility_date = "2026-06-11"

# Prerendered pages, client bundles and public/ files.
[assets]
directory = "./assets"
binding = "ASSETS"
html_handling = "drop-trailing-slash"
not_found_handling = "none"

# Cron Triggers
[triggers]
crons = ["0 3 * * *"]
```

For a project with KV, D1, or R2 bindings configured in the adapter, those sections are appended automatically.

The `[assets]` block appears only when the project has pages. It is
[Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/):
`wrangler deploy` uploads that directory along with the Worker, the edge serves
a matching path without invoking the Worker, and anything unmatched falls
through to `entry.js` — which is where the API routes and `server` pages are.
There is no second upload command and no KV namespace to create.

### 5. Deploy

```sh
cd dist/cloudflare
wrangler deploy
```

Expected output:

```
Total Upload: 42.3 KiB / gzip: 12.1 KiB
Uploaded my-worker (1.23 sec)
Published my-worker (0.42 sec)
  https://my-worker.your-subdomain.workers.dev
```

---

## Smoke test

```sh
URL=https://my-worker.your-subdomain.workers.dev

# API route
curl -fsS "$URL/api/hello"

# Prerendered page, served by Workers Static Assets
curl -fsS "$URL/" | grep -q '<h1'

# Client-mode page, and the browser bundle it boots from
curl -fsS "$URL/dashboard" | grep -o '/_then/pages/[^"]*\.js'

# Server-mode page: rendered in the Worker, per request, with its loader
curl -fsS "$URL/posts" | grep -q '__VURA_LOADER__'
```

The repo ships this as one script, which is what CI runs against every target:

```sh
node scripts/assert-served-pages.mjs "$URL"
```

---

> **Limitation: hot routes are not supported**
>
> Cloudflare Workers terminate the process between requests and cannot hold a WebSocket connection open. Hot routes (websockets, in-memory state) require a persistent process.
>
> When hot routes are present, `vura build` warns at build time:
>
> ```
> [vura] N hot route(s) cannot run on cloudflare and were not bundled: /api/live/room — deploy them to a persistent host (see /self-host/)
> ```
>
> Hot routes are not silently excluded — they are named in the warning. Deploy hot routes to a persistent host ([Node / VPS](/self-host/node-vps/), [Docker](/self-host/docker/), or [Fly.io](/self-host/fly/)) alongside your Worker deployment.

---

> **Limitation: no ISR cache**
>
> A page declaring `revalidate` renders on every request instead of being
> cached: the Worker carries no ISR engine, and pulling `what-isr` into every
> Worker bundle would inflate it for no gain. Those pages are named at build
> time:
>
> ```
> [vura] N page(s) declare `revalidate` but Cloudflare Workers has no ISR cache attached, so they render on every request instead of being cached: /posts
> ```
>
> Put a CDN in front of the Worker, or serve those pages from a persistent host.

---

> **Limitation: a `server` page cannot import a Node built-in**
>
> Workers have no `node:` modules. A `server` page, layout or loader that
> imports one **fails the build** rather than being dropped:
>
> ```
> [vura] server-mode page(s) could not be bundled for Cloudflare Workers: src/pages/report.tsx.
> ```
>
> Move that work into an API route the page fetches with its loader.

---

## Cloudflare bindings (KV, D1, R2)

Access Cloudflare-specific bindings via the `__cf_env` escape hatch on the request object:

```ts
// src/api/data.ts
export async function GET(req, reply) {
  const env = (req as any).__cf_env;
  const value = await env.MY_KV.get('key');
  return reply.json({ value });
}
```

Configure bindings in the adapter:

```ts
cloudflareAdapter({
  name: 'my-worker',
  kv: [{ binding: 'MY_KV', id: 'abc123' }],
  d1: [{ binding: 'DB', database_name: 'my-db', database_id: 'def456' }],
  r2: [{ binding: 'BUCKET', bucket_name: 'my-bucket' }],
})
```

The `__cf_env` and `__cf_ctx` fields are intentionally narrow — they expose CF-specific bindings without changing the shared `req` type used across all adapters.

---

> **CI-tested:** this guide is verified by the `cloudflare` job in `.github/workflows/selfhost.yml`. The job builds the project with the Cloudflare adapter and runs `wrangler dev --local` (workerd, local emulation), then runs `scripts/assert-served-pages.mjs` against it: every page mode, the browser bundle a client page boots from, the loader payload on a `server` page (twice, a second apart, to prove the loader runs per request), the API route, and the 404. It does **not** deploy to Cloudflare — no cloud credentials are in CI; Cloudflare's edge network behavior is out of scope.

---

## Route kind support

| Kind | Supported |
|---|---|
| Serverless | yes |
| Hot (WebSocket) | **no** — build warns by name |
| Task (cron) | yes — via Cloudflare `scheduled` event |
