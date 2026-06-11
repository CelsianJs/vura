# @celsian/vura-vite-plugin

Vite plugin for [Vura](https://vura.dev) — API middleware, route watching, and SSR page handling in development.

[![npm version](https://img.shields.io/npm/v/@celsian/vura-vite-plugin)](https://www.npmjs.com/package/@celsian/vura-vite-plugin)

## What it does

`@celsian/vura-vite-plugin` wires the Vite dev server to your Vura project: it mounts CelsianJS API middleware for `src/api` routes, handles server-rendered pages, exposes the task admin endpoint (`/__tasks`), and hot-reloads route modules when files change. It is installed automatically into the Vite config by `create-vura` — you only configure it directly when customising the Vite setup.

## Install

```sh
npm install @celsian/vura-vite-plugin
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

_vura.dev docs site launches with v0.5 — until then, see the repo README and CHANGELOG._

- [Project structure — /reference/scaffold/](https://vura.dev/reference/scaffold/)
- [Dev server — /ladder/0-create/](https://vura.dev/ladder/0-create/)

## License

MIT — and [it will stay MIT](https://github.com/CelsianJs/vura/blob/main/GOVERNANCE.md).
