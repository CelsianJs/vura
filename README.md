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

`create-then` treats dependency installation as part of a successful scaffold. If install fails, the command exits non-zero after writing the files so registry or namespace-access problems cannot be missed. Until the public `@then/*` scope is resolved, pass `--no-install` explicitly to inspect or test the starter shape without installing:

```sh
npx create-then my-app --no-install
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

## Deploy today

### Node / VPS / Fly / Railway

The default build emits a standalone Node server at `dist/server/entry.js` and static assets under `dist/static`.

```sh
pnpm install --frozen-lockfile
pnpm build
PORT=3000 NODE_ENV=production node dist/server/entry.js
```

Set runtime environment variables in your host dashboard, then health-check your deployed URL. The generated server serves API routes, server/hybrid pages, and static/client pages from one process.

### Cloudflare Workers

Use the Cloudflare adapter when you want Worker artifacts instead of the Node server:

```sh
pnpm add @then/adapter-cloudflare
# configure then.config.js with the adapter
pnpm build
wrangler deploy
```

Cloudflare route handlers intentionally receive the same conservative `req`/`reply` shim as other generated targets, plus Cloudflare-only escape hatches on `req.__cf_env` and `req.__cf_ctx`. Keep this runtime surface narrow until a concrete adapter use case needs a first-class API; widening the shim would become public API surface that must work across Worker, Node, and managed Vura Platform deployments.

### AWS Lambda / SAM

Use the Lambda adapter for API Gateway/Lambda packaging:

```sh
pnpm add @then/adapter-lambda
# configure then.config.js with the adapter
pnpm build
sam deploy --guided
```


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
corepack prepare pnpm@10.11.0 --activate
pnpm install --frozen-lockfile
pnpm release:check
```

To bypass a mismatched local Corepack/global pnpm toolchain, run the same gate with Node 22 and the pinned pnpm directly:

```sh
npx -p node@22 -p pnpm@10.11.0 pnpm install --frozen-lockfile
npx -p node@22 -p pnpm@10.11.0 pnpm release:check
```

`pnpm release:check` runs the full local gate: private-package assertions, hygiene lint, build, tests, production audit, packed publish smoke, tracked tarball-size limits, npm publish dry-run, and `git diff --check`.

Do not publish from an unverified or dirty release tree. Manual release means running `pnpm release:check` locally first, then using the tag/manual GitHub release workflow or `node scripts/publish-packages.mjs` only after npm namespace authority is resolved. If npm returns `E403`, `E404`, or any permission/scope uncertainty for `@then/*`, stop: either obtain/admin the `@then` scope or intentionally rename the packages, then rerun the full release check before any real publish. Real publishing always runs a namespace-authority preflight for scoped packages before uploading tarballs; it cannot be bypassed with `VURA_SKIP_NPM_SCOPE_PREFLIGHT`.
