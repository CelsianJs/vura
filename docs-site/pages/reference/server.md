# Programmatic server

`vura build` generates a `dist/server/entry.js` that boots your app for you — most projects never start the server by hand. When you need to embed Vura in a larger process, wire up a custom host, or write an integration test, `@celsian/vura-core` exports the same primitives the generated entry uses: `startVuraServer` and `createApiApp`.

---

## `startVuraServer`

Start the full Vura server — API routes, server/hybrid pages, the ISR cache, WebSocket upgrades, static files, and graceful shutdown — on one HTTP port.

```ts
startVuraServer(opts: VuraServerOptions): Promise<VuraServer>
```

```ts
import { startVuraServer } from '@celsian/vura-core';

const server = await startVuraServer({
  port: 3000,
  apiRoutes: [
    { ...helloRoute, module: await import('./api/hello.js') },
  ],
  pages: [],
  cache: { store: 'memory' },
});

console.log(`listening on ${server.port}`);
```

### Options

| Option | Type | Default | Effect |
|---|---|---|---|
| `apiRoutes` | `RuntimeApiRoute[]` | — (required) | API routes, each a manifest entry plus its loaded `module` exports. |
| `pages` | `RuntimePage[]` | — (required) | Page routes. Only `server` and `hybrid` pages are rendered at request time; `static` and `client` pages are served from `staticDirs`. |
| `port` | `number` | `3000` | Port to listen on. Pass `0` for an ephemeral port (read the real one from `server.port`). |
| `host` | `string` | `HOST` env, else `0.0.0.0` in production | Interface to bind. |
| `cache` | `VuraCacheConfig` | `{}` | ISR cache configuration. |
| `globalHooks` | `GlobalHooks` | unset | Global `onRequest` / `onError` / `onResponse` hooks (see [Hooks](/reference/hooks)). |
| `staticDirs` | `string[]` | unset | Directories to serve static assets from, tried in order — typically `[publicDir, distStaticDir]`. |
| `shutdownTimeoutMs` | `number` | `30000` | Graceful-shutdown drain timeout before a forced exit. |
| `installSignalHandlers` | `boolean` | `true` (except when `NODE_ENV=test`) | Install `SIGTERM`/`SIGINT` handlers that drain in-flight requests and exit. Set `false` in tests. |

### Returns — `VuraServer`

| Member | Description |
|---|---|
| `server` | The underlying Node `http.Server`, for advanced use. |
| `port` | The port actually bound (useful with `port: 0`). |
| `close()` | Stop accepting connections, drain WebSockets, and close. Resolves when done. |
| `closeWebSockets(code?, reason?)` | Gracefully close all open WebSocket connections (default code `1001`). |

### Built-in endpoints

Every server started this way exposes:

- **`GET /__health`** → `{ "ok": true, "framework": "Vura" }` — a liveness probe.
- **`/__tasks`** — the [task admin interface](/reference/tasks) (auth-gated).
- **`/__vura/revalidate`** — the ISR revalidation webhook, when a cache is configured.

Hot routes that export a `websocket()` handler are wired to the HTTP `upgrade` event automatically (requires the `ws` package). See [Route kinds](/reference/route-kinds).

---

## `createApiApp`

Build just the API application — a Celsian app — from your routes and global hooks, without pages, static serving, or WebSockets. Use it when you only need the HTTP API surface, for example to mount on a serverless runtime.

```ts
createApiApp(opts: ApiAppOptions): CelsianApp
```

```ts
import { createApiApp } from '@celsian/vura-core';

const app = createApiApp({
  routes: manifest.api.map((r) => ({ ...r, module: modules[r.filePath] })),
  globalHooks: {
    onRequest: [cookieSession({ secret })],
  },
});

// Mount the standard fetch handler anywhere that speaks Web Request/Response:
export default { fetch: app.fetch };
```

`ApiAppOptions`:

| Option | Type | Description |
|---|---|---|
| `routes` | `RuntimeApiRoute[]` | API routes with loaded `module` exports. `task`-kind routes are skipped (they aren't HTTP endpoints). |
| `globalHooks` | `GlobalHooks` | `{ onRequest?, onError?, onResponse? }` — arrays of hook functions. |
| `revalidateWebhook` | `(reqLike) => Promise<{ status, body? }>` | When provided, mounts `POST /__vura/revalidate` for ISR cache invalidation. |

A route's optional `export const schema` is applied to its handler automatically (Vura's `query` key maps to Celsian's `querystring`).

> **You usually don't call these directly.** For normal development and deployment, run `vura dev` and `vura build` — the generated `dist/server/entry.js` calls `startVuraServer` with your project's routes, pages, hooks, and cache already wired. Reach for these APIs only for embedding, custom hosting, or tests. See the [CLI reference](/reference/cli) and [self-host guides](/self-host/).
