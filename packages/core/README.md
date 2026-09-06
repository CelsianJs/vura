# @celsian/vura-core

Core runtime and build pipeline for [Vura](https://vura.io) — the MIT full-stack meta-framework for apps that outgrow serverless.

[![npm version](https://img.shields.io/npm/v/@celsian/vura-core)](https://www.npmjs.com/package/@celsian/vura-core)

## What it does

`@celsian/vura-core` scans `src/pages` and `src/api` into a route manifest, drives the build pipeline, and provides the runtime helpers your route handlers import: `revalidateTag` / `revalidatePath` (backed by what-isr), signed cookie sessions and JWT auth, typed error helpers, and `defineConfig`. Pages render through What Framework; API routes run on CelsianJS. You normally get this package via `npm create vura@latest` — install it directly only when building custom adapters or tooling.

## Install

```sh
npm install @celsian/vura-core
```

## Minimal example

**src/api/posts.ts** — revalidate a tag on write:

```ts
import type { CelsianRequest, CelsianReply } from '@celsian/vura-core';
import { revalidateTag } from '@celsian/vura-core';

export const route = { compute: { class: 'function', memory: '1gb' } };

export async function POST(req: CelsianRequest, reply: CelsianReply) {
  const body = req.parsedBody as { title: string };
  // ... persist the post
  await revalidateTag('posts');
  return reply.json({ ok: true });
}

```

**vura.config.ts** — typed project config:

```ts
import { defineConfig } from '@celsian/vura-core';

export default defineConfig({
  api: { defaultKind: 'serverless' },
  pages: { defaultMode: 'static' },
});
```

## Documentation

- [Quick start — /ladder/0-create/](https://vura.io/ladder/0-create/)
- [Config reference — /reference/config/](https://vura.io/reference/config/)
- [API routes — /ladder/3-api/](https://vura.io/ladder/3-api/)
- [Server pages and caching — /ladder/2-cache/](https://vura.io/ladder/2-cache/)
- [Route kinds — /reference/route-kinds/](https://vura.io/reference/route-kinds/)

## License

MIT — and [it will stay MIT](https://github.com/CelsianJs/vura/blob/main/GOVERNANCE.md).
