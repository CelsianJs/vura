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

## How the generated entry wires `cache`

`vura build` passes the non-secret `cache` fields from `vura.config` into the generated server entry (`dist/server/entry.js`) as build-time literals: `store`, `dir`, `maxEntries`, and `cdn.provider` / `cdn.zoneId` / `cdn.serviceId`.

**Secrets are never serialized into the build artifact.** `cache.revalidateSecret` and `cache.cdn.apiToken` are always read from the environment when the server starts — set `VURA_REVALIDATE_SECRET` and `VURA_CDN_API_TOKEN` on the server process. If either field holds a value in `vura.config` at build time, the build prints a warning and ignores the value.

**`store: 'redis'` is a build error.** A redis store needs a live client instance, which cannot be serialized into a generated file. Use the programmatic path instead — `createVuraCache({ store: 'redis', redisClient })` with `startVuraServer()` in your own server entry. The generated entry supports `memory` and `filesystem`.

**A relative `cache.dir` resolves from the server process cwd.** The value passes through verbatim; with the generated `dist/Dockerfile` (`WORKDIR /app`), the default `.vura/cache` lands at `/app/.vura/cache`. Use an absolute path (or mount a volume at the relative location) if the cache should live elsewhere.

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
    dir: '.vura/cache',
    // revalidateSecret / cdn.apiToken: do NOT put secrets here — the generated
    // entry reads VURA_REVALIDATE_SECRET / VURA_CDN_API_TOKEN at runtime.
  },
});
```

## Adapter-specific config

When using `@celsian/vura-adapter-lambda` or `@celsian/vura-adapter-cloudflare`, the adapter factory is assigned to the `adapter` key. See the [Adapters reference](/reference/adapters/) for install instructions and config snippets.
