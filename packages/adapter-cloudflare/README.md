# @celsian/vura-adapter-cloudflare

Cloudflare Workers adapter for [Vura](https://vura.dev) applications.

[![npm version](https://img.shields.io/npm/v/@celsian/vura-adapter-cloudflare)](https://www.npmjs.com/package/@celsian/vura-adapter-cloudflare)

## What it does

`@celsian/vura-adapter-cloudflare` runs after `vura build` and generates a `wrangler.toml` and Worker entry files that wire your API routes to a CelsianJS app running in the Workers runtime. KV, D1, and R2 bindings are configurable. Cloudflare Workers does not support persistent Node.js processes, so routes with `kind: 'hot'` (WebSocket hot routes) cannot run on Workers — use a self-hosted Node.js server for those. Cloudflare-specific environment bindings and execution context are accessible on the request object as `__cf_env` and `__cf_ctx`.

## Install

```sh
npm install @celsian/vura-adapter-cloudflare
```

## Minimal example

**vura.config.ts:**

```ts
import { defineConfig } from '@celsian/vura-core';
import { cloudflareAdapter } from '@celsian/vura-adapter-cloudflare';

export default defineConfig({
  adapter: cloudflareAdapter({ name: 'my-vura-app' }),
});
```

Build and preview locally with Wrangler:

```sh
vura build
wrangler dev
```

## Documentation

- [Self-host on Cloudflare — /self-host/cloudflare/](https://vura.dev/self-host/cloudflare/)
- [Adapters overview — /self-host/](https://vura.dev/self-host/)

## License

MIT — and [it will stay MIT](https://github.com/zvndev/vura/blob/main/GOVERNANCE.md).
