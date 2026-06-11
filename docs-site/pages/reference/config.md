# vura.config reference

Complete reference for `vura.config.ts`. Defaults shown are what you get with no config file at all.

```ts
// vura.config.ts
import { defineConfig } from '@celsian/vura-core';

export default defineConfig({
  // all fields are optional
});
```

## Top-level keys

| Key | Type | Default | Effect |
|---|---|---|---|
| `root` | `string` | `process.cwd()` | Project root directory. Auto-detected from the working directory at build and dev time. Override when calling the programmatic API from a different directory. |
| `pages.dir` | `string` | `src/pages` | Directory scanned for page components. |
| `pages.defaultMode` | `'static' \| 'server' \| 'client' \| 'hybrid'` | `'static'` | Rendering mode used when a page file does not export a `page` config. |
| `api.dir` | `string` | `src/api` | Directory scanned for API route files. |
| `api.defaultKind` | `'serverless' \| 'hot' \| 'task'` | `'serverless'` | Route kind used when a file does not export `kind` or `route`. |
| `adapter` | `ThenAdapter` | `undefined` (Node built-in) | Deployment adapter. Omit for Node/VPS/Docker/Fly; set to one of the adapter packages for Cloudflare Workers or Lambda. |
| `vite` | `Record<string, unknown>` | `{}` | Vite config overrides merged into the dev and build Vite config. Same keys as `vite.config.ts`; Vura's own settings take precedence over conflicting keys. |
| `cache` | `VuraCacheConfig` | `undefined` | ISR/on-demand revalidation cache. See the cache sub-keys below. |

## Cache sub-keys (`cache.*`)

These are the fields of `VuraCacheConfig`, nested under the `cache` key.

| Key | Type | Default | Effect |
|---|---|---|---|
| `cache.store` | `'memory' \| 'filesystem' \| 'redis'` | `'memory'` | Backing store for the ISR cache. `filesystem` persists across server restarts; `redis` shares state across multiple instances. |
| `cache.dir` | `string` | `.vura/cache` | Directory for `filesystem` store. Ignored when `store` is not `'filesystem'`. |
| `cache.redisClient` | `unknown` | `undefined` | An already-constructed Redis client (e.g. from `ioredis`). Required when `store === 'redis'`. Vura does not own the connection lifecycle — open and close it yourself. |
| `cache.maxEntries` | `number` | `1000` | Maximum in-memory cache entries for `memory` store. Ignored for other stores. |
| `cache.revalidateSecret` | `string` | `undefined` | Shared secret for the `POST /__vura/revalidate` webhook. If omitted, the webhook handler is not registered and on-demand revalidation is disabled. |
| `cache.cdn.provider` | `'cloudflare' \| 'fastly'` | `undefined` | Optional edge-purge CDN adapter. |
| `cache.cdn.zoneId` | `string` | — | Cloudflare zone ID. Required when `provider === 'cloudflare'`. |
| `cache.cdn.apiToken` | `string` | — | Cloudflare or Fastly API token. |
| `cache.cdn.serviceId` | `string` | — | Fastly service ID. Required when `provider === 'fastly'`. |

## What is wired today vs planned

The generated server entry (`dist/server/entry.js`) currently wires **only `revalidateSecret`** from the `cache` config — it injects `process.env.VURA_REVALIDATE_SECRET` at build time so the webhook handler is active in production. The rest of the `VuraCacheConfig` fields (`store`, `dir`, `redisClient`, `maxEntries`, `cdn`) are accepted by `defineConfig` and type-safe, but the generated entry does not yet pass them through to `createVuraCache()`. A `TODO` in `packages/core/src/build.ts` marks this gap: _"wire full VuraCacheConfig from vura.config when Task X lands"_.

**Practical consequence:** to use `filesystem` or `redis` store today, call `createVuraCache()` directly in a `src/server.ts` global hooks file rather than relying on the generated entry. The `revalidateSecret` path works as-is via the env variable.

## Full example

```ts
// vura.config.ts
import { defineConfig } from '@celsian/vura-core';

export default defineConfig({
  pages: {
    defaultMode: 'server',
  },
  api: {
    defaultKind: 'serverless',
  },
  cache: {
    store: 'filesystem',
    revalidateSecret: process.env.VURA_REVALIDATE_SECRET,
  },
});
```

## Adapter-specific config

When using `@celsian/vura-adapter-lambda` or `@celsian/vura-adapter-cloudflare`, the adapter factory is assigned to the `adapter` key. See the [Adapters reference](/reference/adapters/) for install instructions and config snippets.
