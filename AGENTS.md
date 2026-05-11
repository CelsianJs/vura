# Vura agent guide

## Package map

- `packages/core` — `@then/core`: manifest scanning, build pipeline, runtime/server helpers.
- `packages/cli` — `@then/cli`: `vura`, `thenjs`, and legacy `then` command bins.
- `packages/create-then` — `create-then`: project scaffolder.
- `packages/compiler` — `@then/compiler`: JavaScript compiler package.
- `packages/vite-plugin` — `@then/vite-plugin`: Vite integration.
- `packages/adapter-cloudflare` — `@then/adapter-cloudflare`: Cloudflare Worker build adapter.
- `packages/adapter-lambda` — `@then/adapter-lambda`: AWS Lambda/API Gateway build adapter.
- `packages/compiler-native` — `@then/compiler-native`: private native compiler placeholder until artifacts/policy are ready.
- `packages/adapter-vura` — `@then/adapter-vura`: private managed Vura Platform adapter until live smoke/policy are ready.
- `examples/*` — private example/smoke apps only; never publish them.

## Commands

Use pnpm 10.11.0 through Corepack:

```sh
corepack enable
corepack prepare pnpm@10.11.0 --activate
pnpm install --frozen-lockfile
pnpm assert:release-private
pnpm lint
pnpm build
pnpm test
pnpm verify:publish
pnpm audit
git diff --check
```

## Release safety rules

- Do not publish from a dirty tree or without rerunning the full release checks above.
- `scripts/publish-packages.mjs` is the JS publish allowlist; do not add packages casually.
- Keep `packages/compiler-native` and `packages/adapter-vura` private and out of the JS publish list until their release blockers are explicitly cleared.
- Keep all `examples/**/package.json` files private.
- Use `VURA_PUBLISH_DRY_RUN=1 node scripts/publish-packages.mjs` for dry-run validation before any real publish.
- Real npm publish must have token/auth plus namespace authority preflight; stop on any `E403`, `E404`, or scope-access uncertainty.

## Private package constraints

- Private packages may be built and tested locally but must not be packed into the public JS release set.
- If a private package becomes publishable later, add a release policy, smoke coverage, and explicit allowlist change in the same reviewed change.

## Namespace/name blocker

The public `@then/*` package names are blocked until npm scope authority is granted or a separate intentional rename decision is made. Do not make naming decisions opportunistically in unrelated fixes. Keep current names stable in code, docs, and tests unless the task explicitly approves a rename.
