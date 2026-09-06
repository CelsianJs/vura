# Adapters reference

Adapters tell `vura build` what to emit. The built-in Node adapter requires no configuration. The three published adapters target Cloudflare Workers, AWS Lambda, and the Vura managed platform.

---

## Built-in: Node (no adapter needed)

When `adapter` is omitted from `vura.config.ts`, `vura build` emits a Node-compatible server:

```
dist/
  server/entry.js   ← unified server: static files, server pages, API routes, hot routes, task cron
  static/           ← prerendered and client pages
  manifest.json
  Dockerfile        ← emitted only when hot routes are present
  fly.toml          ← emitted only when hot routes are present
```

Run it:

```sh
PORT=3000 NODE_ENV=production node dist/server/entry.js
```

Install the output's production dependencies before starting it on a fresh host.
Server page modules keep `what-framework` external, and hot routes need `ws`.
Use the emitted `dist/package.json` when present; follow the
[Node / VPS](/self-host/node-vps/) or [Docker](/self-host/docker/) guide for the
complete copy/install/start sequence. The entry file alone is not the deployment.

**Route kind support:** all (serverless, hot, task).

---

## `@celsian/vura-adapter-cloudflare`

**Install:**

```sh
npm install @celsian/vura-adapter-cloudflare
```

**Config:**

```ts
// vura.config.ts
import { defineConfig } from '@celsian/vura-core';
import { cloudflareAdapter } from '@celsian/vura-adapter-cloudflare';

export default defineConfig({
  adapter: cloudflareAdapter({
    name: 'my-worker',           // Worker name in wrangler.toml
    // compatibilityDate defaults to today's date at build time
    // kv: [{ binding: 'MY_KV', id: '...' }]
    // d1: [{ binding: 'DB', database_name: '...', database_id: '...' }]
    // r2: [{ binding: 'BUCKET', bucket_name: '...' }]
    // routes: [{ pattern: 'example.com/api/*', zone_name: 'example.com' }]
  }),
});
```

**Emitted artifacts:**

```
dist/cloudflare/
  wrangler.toml     ← cron triggers for task routes, and the [assets] block
  entry.js          ← Worker entry: API routes, then server-mode pages
  routes/           ← per-route module bundles
  pages.js          ← server-mode page renderer (omitted when there are none)
  pages.source.mjs  ← the un-bundled wiring for pages.js, for inspection
  assets/           ← prerendered pages, client bundles and public/ files
```

Deploy: `cd dist/cloudflare && wrangler deploy`

**Route kind support:** serverless, task (via `scheduled` cron event). Hot routes are not supported.

**Pages on Cloudflare.** All four page modes are served.

`static`, `client` and `hybrid` pages are rendered at build time into
`dist/static`, and the adapter copies that tree (plus `dist/public`) into
`dist/cloudflare/assets`. The generated `wrangler.toml` points
[Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
at it:

```toml
[assets]
directory = "./assets"
binding = "ASSETS"
html_handling = "drop-trailing-slash"
not_found_handling = "none"
```

That is the whole deploy: `wrangler deploy` uploads the directory with the
Worker. Assets are chosen over KV (which would need a namespace, an id in this
file and a second upload command) and over inlining (every page and bundle
would count against the 3 MB script limit).

Two settings are pinned rather than left at their defaults, and both matter:

- `html_handling = "drop-trailing-slash"` serves `about/index.html` at
  `/about`. The default, `auto-trailing-slash`, would answer `/about` with a
  307 to `/about/` — while the Node server the same build emits serves
  `/about` directly. `/about/` still redirects to `/about` on Cloudflare; on
  Node both paths return the page.
- `not_found_handling = "none"` is what lets a request that matches no asset
  reach the Worker, which is where the API routes and `server` pages live.

`server` pages render inside the Worker, per request, with their loaders. The
Worker checks the API route table first, then its page table, so nothing about
existing API routing changes.

`dist/public` is copied too, whether or not the project has pages — the Node
server serves it either way. A deployment with no pages **and** no
`public/` keeps exactly the Worker it had before: no `[assets]` block, no
`pages.js`, and the same JSON 404 for an unmatched path. Once there is a site
surface, an unmatched path answers the way the Node server does: JSON under
`/api/` and `/__vura/`, the 404 page everywhere else.

A `server` page that imports a Node built-in **fails the build**, by name:
Workers have no `node:` modules, and shipping the Worker without that page
would serve a 404 for it while the build reported success.

**Not served the same as Node:** a page declaring `revalidate` renders on every
request rather than being cached, because the Worker carries no ISR engine.
`vura build` names those pages in a warning. Put a CDN in front, or deploy them
to a persistent host.

`vura build` emits a named warning when hot routes are present:

```
[vura] N hot route(s) cannot run on cloudflare and were not bundled: /api/live/room — deploy them to a persistent host (see /self-host/)
```

**Task routes on Cloudflare:** the generated `wrangler.toml` includes a `[triggers]` cron block for task routes that have a `schedule` export. The Worker's `scheduled` handler dispatches these.

**Escape hatches:** the Cloudflare `env` and `ctx` objects are attached to the request as `req.__cf_env` and `req.__cf_ctx`. These are intentionally narrow — they let you reach KV, D1, or `ctx.waitUntil()` without breaking the shared request type used across adapters.

```ts
export async function GET(req, reply) {
  const cf_env = (req as any).__cf_env;
  const value = await cf_env.MY_KV.get('key');
  return reply.text(value);
}
```

**`revalidateTag` on Cloudflare (warn-only stub):** Worker bundles include a `revalidateTag`/`revalidatePath` shim that logs a warning instead of calling a cache engine:

```
[vura] revalidateTag("posts") is a no-op inside Workers today — call your cache host's /__vura/revalidate webhook instead.
```

Workers have no local ISR cache, and pulling the full `what-isr` runtime into every Worker bundle would inflate it for no gain. To invalidate ISR cache from a Worker, make an HTTP POST to your Node server's `/__vura/revalidate` endpoint with the `x-vura-revalidate-secret` header. This is the same stub the Lambda adapter emits; see below.

---

## `@celsian/vura-adapter-lambda`

**Install:**

```sh
npm install @celsian/vura-adapter-lambda
```

**Config:**

```ts
// vura.config.ts
import { defineConfig } from '@celsian/vura-core';
import { lambdaAdapter } from '@celsian/vura-adapter-lambda';

export default defineConfig({
  adapter: lambdaAdapter({
    region: 'us-east-1',      // default
    memory: 256,              // default, MB
    timeout: 30,              // default, seconds
    stackName: 'then-app',    // CloudFormation stack name
    runtime: 'nodejs20.x',   // default
    architecture: 'arm64',   // default
  }),
});
```

**Emitted artifacts:**

```
dist/
  lambda/
    api_hello_get/      ← one directory per route+method
      index.js
      route.js
    __pages/            ← the single pages function (omitted with no pages)
      index.js          ← prerendered assets, then server-mode pages, then 404
      pages.js          ← server-mode page renderer
      assets/           ← prerendered pages, client bundles and public/ files
  template.yaml         ← SAM template with API Gateway + Lambda functions
  samconfig.toml        ← SAM deploy defaults (stack name, region, resolve_s3)
```

The two SAM files sit in `dist/`, beside `lambda/` rather than inside it, because the template's `CodeUri` paths are written relative to it (`lambda/api_hello_get/`).

Deploy with AWS SAM:

```sh
sam validate --template dist/template.yaml --lint
sam build --template dist/template.yaml
sam deploy --guided
```

Or shorthand after the first deploy: `sam deploy` (reads `samconfig.toml`).

**Route kind support:** serverless, task (via EventBridge `Schedule` event). Hot routes are not supported.

`vura build` emits a named warning when hot routes are present:

```
[vura] N hot route(s) cannot run on lambda and were not bundled: /api/live/room — deploy them to a persistent host (see /self-host/)
```

**Pages on Lambda.** All four page modes are served, by one function.

The SAM template declares a `VuraPagesFunction` with a GET route per page
pattern plus a greedy `/{proxy+}` on `ANY`. HTTP API matches the most specific
route first, so every API route still wins; the catch-all is what serves the
client bundles under `/_then/`, anything from `public/`, and what turns an
unknown path into the 404 page instead of API Gateway's
`403 Missing Authentication Token`.

Prerendered pages, client bundles and `public/` files are copied into the
function's own `assets/` directory and served from `/var/task`. **This is not
S3.** `sam deploy` uploads code, not site content, so an S3 + CloudFront story
needs a bucket, a distribution and an `aws s3 sync` you run yourself — a step
this adapter cannot perform on your behalf. Serving from the bundle keeps
`sam deploy` as the whole deploy, at the cost of every asset byte being billed
as function time. `vura build` warns by name once that tree passes 25 MB, and
warns about any single file too large for API Gateway's 6 MB response cap.

`server` pages render inside the same function, per request, with their loaders.
A page that imports a Node built-in fails the build by name: the pages bundle is
built runtime-neutral so the same artifact runs on every serverless target.

`dist/public` is copied too, whether or not the project has pages. A deployment
with no pages **and** no `public/` gets no pages function and no extra route:
its `template.yaml` is what it always was.

**Not served the same as Node:** a page with `streaming: true` still renders
correctly but is **buffered** — API Gateway's proxy integration has no early
flush, so the shell cannot go out before the body. A page declaring
`revalidate` renders on every request rather than being cached. Both are named
in build warnings.

**`revalidateTag` in Lambda — warn-only stub:** Lambda function bundles include a `revalidateTag`/`revalidatePath` shim that logs a warning instead of calling a local cache engine:

```
[vura] revalidateTag("posts") is a no-op inside Lambda functions today — call your cache host's /__vura/revalidate webhook instead.
```

This is intentional: pulling the full `what-isr` runtime into every function bundle would inflate cold-start size. To invalidate ISR cache from a Lambda function, make an HTTP POST to your Node server's `/__vura/revalidate` endpoint with the `x-vura-revalidate-secret` header.

---

## `@celsian/vura-adapter-vura`

> **Private beta.** [Signup](https://app.vura.io/signup) requires an access code. The adapter package is published, but installing it does not grant managed-service access. The built-in Node output and Cloudflare/Lambda adapters remain available for self-hosting within their support matrices.

**Config (preview):**

```ts
// vura.config.ts
import { defineConfig } from '@celsian/vura-core';
import { vuraAdapter } from '@celsian/vura-adapter-vura';

export default defineConfig({
  adapter: vuraAdapter({ team: 'my-team' }),
});
```

Self-hosted Node supports websockets, cache revalidation, ordinary tasks, and
cron. Durable task delivery and restart-safe waits currently require the managed
broker; standalone task state and waits are in-process. Cloudflare and Lambda
have additional limitations, including no hot routes, middleware, or server
actions. See the [self-host support matrix](/self-host/).

---

## Support matrix summary

| Adapter | Serverless | Hot (WebSocket) | Task / cron |
|---|---|---|---|
| Node (built-in) | yes | yes | yes |
| `adapter-cloudflare` | yes | no | yes (Cloudflare scheduled) |
| `adapter-lambda` | yes | no | yes (EventBridge) |
| `adapter-vura` | yes | yes | yes |
