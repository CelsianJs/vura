# @celsian/vura-vite-plugin

Vite plugin for [Vura](https://vura.io) — API middleware, route watching, and SSR page handling in development.

[![npm version](https://img.shields.io/npm/v/@celsian/vura-vite-plugin)](https://www.npmjs.com/package/@celsian/vura-vite-plugin)

## What it does

`@celsian/vura-vite-plugin` optionally wires the Vite dev server to your Vura project: it mounts CelsianJS API middleware for `src/api` routes, handles all four page modes, exposes the task admin endpoint (`/__tasks`), and hot-reloads route modules when files change. The default `create-vura` starter uses the standalone `vura dev` server; it does not install Vite or this plugin. Add them and configure the plugin explicitly when you want a Vite development server.

Static, server, and hybrid pages use the shared Vura renderer, including hooks, page/layout loaders, loader redirects and not-found responses, and opt-in streaming. Hybrid browser bundles rebuild the layout chain and use the serialized loader payload. Client pages receive a browser shell rather than server-rendering their component.

`src/middleware.ts` runs before pages, APIs, and static serving. Server actions under `src/actions` are registered at `/__vura/action`, and their browser imports become fetch stubs instead of shipping server code. The native action endpoint enforces same-origin and CSRF checks, **not user authorization**: middleware skips framework-internal endpoints, so enforce session and permission checks inside your action handlers.

Direct HTTP requests for action, API, and middleware source are blocked, including Vite's raw and filesystem URLs; internal server module loading remains available. Source edits rebuild the API/action generation and invalidate browser bundles, including changes to shared dependencies. Deleted or renamed actions stop being callable after a successful rescan without clearing another app's action registry.

## Install

```sh
npm install -D vite @celsian/vura-vite-plugin
```

## Minimal example

**vite.config.ts:**

```ts
import { defineConfig } from 'vite';
import { thenPlugin } from '@celsian/vura-vite-plugin';

export default defineConfig({
  plugins: [thenPlugin()],
});
```

Pass a `root` option to override the project root if it differs from `process.cwd()`:

```ts
thenPlugin({ root: '/path/to/project' })
```

## Documentation

- [Scaffold and dev server — /ladder/0-create/](https://vura.io/ladder/0-create/)

## License

MIT — and [it will stay MIT](https://github.com/CelsianJs/vura/blob/main/GOVERNANCE.md).
