# Changelog

## 0.3.0 - 2026-06-11

Rebased on what-framework 0.11 + what-isr ISR engine + Celsian API layer.

### What-Framework 0.11 rebase

- Removed the built-in SSR renderer; Vura now delegates directly to what-framework's `renderToString` and `createRequestHandler` exports.
- Server entry is generated as a thin wiring file and bundled self-contained by esbuild — no framework internals leak into userland.

### ISR engine via what-isr

- `revalidateTag` and `revalidatePath` are now first-class exports from `@celsian/vura-core`.
- Page config supports `revalidate` (TTL in seconds) and `tags` (string array) fields.
- `/__vura/revalidate` webhook endpoint activates on-demand ISR via tag/path.
- Cloudflare and Fastly CDN purge config supported via the adapter layer.

### API layer on @celsian/core

- API routes now run on a `CelsianApp` instance (from `@celsian/core ^0.5.2`).
- Route handlers support both schema-first (Celsian options object) and plain function form.
- Global hooks (`onRequest`, `onResponse`, `onError`) are mapped to Celsian lifecycle hooks.
- Dev mode, standalone dev server, and production all use the same CelsianApp — dev/prod parity.

### Breaking changes / deprecations

- **`ThenRequest` / `ThenReply` deprecated** — use `CelsianRequest` / `CelsianReply`. A compat alias keeps existing code working during migration:
  - `req.body` still works via compat alias of `parsedBody`.
  - `req.headers['x']` → `req.headers.get('x')` (Headers object, not plain record).
  - `req.url` is now a full URL string — use `new URL(req.url).pathname` to get the path.
- `onResponse` hooks receive a synthesized `responseInfo` object; `hadError` is always `false` on the success path.
- Intentional API 404s are now honoured in dev mode (previously swallowed by the dev middleware).

### Migration snippet

```ts
// Before (0.2.x)
import type { ThenRequest, ThenReply } from '@celsian/vura-core';
export function GET(req: ThenRequest, reply: ThenReply) {
  const path = req.url;               // was already a path string
  const ct   = req.headers['content-type'];
  return reply.json({ ok: true });
}

// After (0.3.0)
import type { CelsianRequest, CelsianReply } from '@celsian/vura-core';
export function GET(req: CelsianRequest, reply: CelsianReply) {
  const path = new URL(req.url).pathname;   // req.url is now a full URL
  const ct   = req.headers.get('content-type');
  return reply.json({ ok: true });
}
```

## 0.1.0 - 2026-05-10

Initial Vura/ThenJS public package release candidate.

- Ships the core runtime, compiler, CLI, Vite plugin, create app scaffold, and deployment adapters.
- Includes production static serving, API/task hardening, CLI `vura`/`thenjs` aliases, and clean tarball smoke coverage.
- Excludes the native compiler prototype from npm publishing until platform-specific native artifacts are released.
