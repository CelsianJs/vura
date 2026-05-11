# Vura

Vura is the OSS distribution of the ThenJS full-stack framework: file-based API routes, static/server pages, and deployment adapters for Node, AWS Lambda, and Cloudflare Workers.

## Install

> **Namespace status:** the code and package tarballs are locally verified, but the public `@then/*` npm scope is not releasable until scope authority is granted or the packages are intentionally renamed. Treat the install and create commands below as the intended public UX after that release blocker is resolved.

```sh
pnpm add @then/core @then/cli
```

The CLI exposes `vura` and `thenjs` as safe command names. The legacy `then` bin is still shipped for compatibility, but new npm scripts should use `vura` or `thenjs` because `then` is a shell reserved word.

## Requirements

- Node.js 20 or 22 (`engines.node` is constrained to `>=20 <23`)
- pnpm 10.11.0 (the version pinned by `packageManager`)

Recommended activation on fresh machines:

```sh
corepack enable
corepack prepare pnpm@10.11.0 --activate
pnpm install --frozen-lockfile
```

## Quick start

```sh
pnpm create then@latest my-app
cd my-app
pnpm dev
pnpm build
```

Example scripts:

```json
{
  "scripts": {
    "dev": "vura dev",
    "build": "vura build"
  }
}
```

`vura deploy` is reserved for the managed Vura Platform and intentionally
fails closed in the open-source CLI. Use `vura build` plus the adapter output
for self-hosted deployments until managed deployment access is available.


## Page modes and build output

`vura build` now emits deployable build-time output for every non-server page mode:

- `static` pages prerender to `dist/static/<route>/index.html` with no framework JavaScript added.
- `client` pages prerender a loading shell and emit a browser module under `dist/static/_then/pages/*.js`; the HTML references that module.
- `hybrid` pages prerender HTML and emit a matching browser module under `dist/static/_then/pages/*.js` for hydration/island code.
- `server` pages remain runtime-rendered by `dist/server/entry.js`.

The generated hot server serves API routes first, server/hybrid runtime pages next, and `dist/static` as the final fallback so static/client assets remain deployable without shadowing APIs.

## Packages

- `@then/core` — manifest scanning, build pipeline, generated production server, and runtime helpers.
- `@then/cli` — `vura`, `thenjs`, and legacy `then` command-line interface.
- `@then/adapter-lambda` — AWS Lambda/API Gateway deployment artifacts.
- `@then/adapter-cloudflare` — Cloudflare Workers deployment artifacts.
- `@then/vite-plugin` — Vite integration.
- `@then/compiler` — pure JavaScript compiler fallback.

## Release checks

Before publishing, run:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm assert:release-private
pnpm lint
pnpm build
pnpm test
pnpm audit
pnpm verify:publish
VURA_PUBLISH_DRY_RUN=1 node scripts/publish-packages.mjs
git diff --check
```

Do not publish from an unverified or dirty release tree. If npm returns `E404`/permission errors for `@then/*`, stop: either obtain/admin the `@then` scope or intentionally rename the packages, then rerun the full verification and dry-run before any real publish.
