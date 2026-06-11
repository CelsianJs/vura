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

No install step — `dist/server/entry.js` is a self-contained bundle. See the [Node / VPS](/self-host/node-vps/) and [Docker](/self-host/docker/) guides.

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
  wrangler.toml   ← generated with cron triggers for task routes
  entry.js        ← Worker entry, routes all requests
  routes/         ← per-route module bundles
```

Deploy: `cd dist/cloudflare && wrangler deploy`

**Route kind support:** serverless, task (via `scheduled` cron event). Hot routes are not supported.

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

**`revalidateTag` on Cloudflare:** calling `revalidateTag()` inside a Worker function reaches the `/__vura/revalidate` webhook of your Node cache host (if you have one running separately). Workers have no local ISR cache. This is the same pattern as Lambda — see below.

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
    template.yaml       ← SAM template with API Gateway + Lambda functions
    samconfig.toml      ← SAM deploy defaults (stack name, region, resolve_s3)
```

Deploy with AWS SAM:

```sh
sam validate --template dist/lambda/template.yaml --lint
sam build --template dist/lambda/template.yaml
sam deploy --guided
```

Or shorthand after the first deploy: `sam deploy` (reads `samconfig.toml`).

**Route kind support:** serverless, task (via EventBridge `Schedule` event). Hot routes are not supported.

`vura build` emits a named warning when hot routes are present:

```
[vura] N hot route(s) cannot run on lambda and were not bundled: /api/live/room — deploy them to a persistent host (see /self-host/)
```

**`revalidateTag` in Lambda — warn-only stub:** Lambda function bundles include a `revalidateTag`/`revalidatePath` shim that logs a warning instead of calling a local cache engine:

```
[vura] revalidateTag("posts") is a no-op inside Lambda functions today — call your cache host's /__vura/revalidate webhook instead.
```

This is intentional: pulling the full `what-isr` runtime into every function bundle would inflate cold-start size. To invalidate ISR cache from a Lambda function, make an HTTP POST to your Node server's `/__vura/revalidate` endpoint with the `x-vura-revalidate-secret` header.

---

## `@celsian/vura-adapter-vura`

> **Closed alpha — not publicly available yet.** The package is published to npm but the Vura managed platform is in closed alpha. `npm install @celsian/vura-adapter-vura` succeeds, but the adapter cannot connect to the platform without an alpha access grant. Use `adapter-lambda` or `adapter-cloudflare` for self-hosted deployments today.

**Config (preview):**

```ts
// vura.config.ts
import { defineConfig } from '@celsian/vura-core';
import { vuraAdapter } from '@celsian/vura-adapter-vura';

export default defineConfig({
  adapter: vuraAdapter({ team: 'my-team' }),
});
```

No framework capability is gated on this adapter. Everything (websockets, cache revalidation, tasks, cron) works fully self-hosted via the Node, Lambda, or Cloudflare adapters. This adapter is a convenience for teams on the managed platform once access is available.

---

## Support matrix summary

| Adapter | Serverless | Hot (WebSocket) | Task / cron |
|---|---|---|---|
| Node (built-in) | yes | yes | yes |
| `adapter-cloudflare` | yes | no | yes (Cloudflare scheduled) |
| `adapter-lambda` | yes | no | yes (EventBridge) |
| `adapter-vura` | yes | yes | yes |
