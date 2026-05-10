# Vura (ThenJS Meta-Framework) — Next Session Pickup

## Current State
- **Branch**: `audit-hardening`
- **Tests**: 364 passing (`pnpm test`, 24 files)
- **Build**: `pnpm build` passing
- **Pack check**: `@then/vite-plugin` must contain `dist/index.js` + `dist/index.d.ts` before publish (`npx pnpm@10.23.0 --filter @then/vite-plugin pack --pack-destination /tmp/vura-pack-check`)
- **Gold-standard score**: 45/50 after OSS release-blocker fixes; package tarballs are locally publish-ready but npm scope authorization blocks actual publish

## What Was Done
- Fixed production hooks: _executeWithHooks had dead code path (error always swallowed)
- Enforced ESM purity: replaced all require() with top-level ESM imports in generated server
- Added realpathSync traversal guard for static file serving
- Added one-time CORS dev warning when defaulting to "*"
- Made ISR_MAX_ENTRIES configurable via env var
- Added global hooks via `_hooks.ts` convention
- Made `@then/vite-plugin` publishable with `dist` files, `main`/`types`/conditional exports, build/prepack scripts, and public publish config
- Declared runtime `esbuild` dependencies for core/CLI/Lambda/Cloudflare packages and updated lockfile importers
- Bundled route artifacts as self-contained JS when routes import `@then/core`; added Lambda/Cloudflare/core smoke coverage
- Missing route sources now fail builds with route path + absolute source context instead of being skipped
- Hardened task admin auth so production requires `THEN_TASK_SECRET`; localhost no-secret bypass is limited to explicit dev/test

## Release Checklist / Current Blocker
- [x] `pnpm build` passes
- [x] `pnpm test` passes (current baseline: 364 tests)
- [x] `pnpm verify:publish` passes: 8 tarballs, no `workspace:` refs, clean npm install/import smoke, `@then/compiler-native` private
- [x] `pnpm -r publish --dry-run --no-git-checks --access public` passes for 8 public JS packages and excludes `@then/compiler-native`
- [x] `CHANGELOG.md` and `.github/workflows/release.yml` added
- [ ] **Actual publish blocked:** `pnpm -r publish --no-git-checks --access public` failed on `@then/compiler@0.1.0` with npm `E404` / no permission for the `@then` scope. No Vura packages were published.
- [ ] Resolve package namespace before retry: obtain/admin the `@then` npm org, or intentionally rename packages to an owned scope (for example `@vura/*`) and rerun full `pnpm verify:publish` + dry-run.

## What Remains

### Should Fix (from PM reviews)
1. Resolve npm namespace authorization for `@then/*` or rename packages to an owned scope.
2. After namespace resolution, rerun `pnpm build && pnpm test && pnpm verify:publish && pnpm -r publish --dry-run --no-git-checks --access public`.
3. Decide whether Cloudflare route support should expose more runtime APIs or keep the current safe route-runtime shim surface.

### Strategic Decisions (for Kirby)
- **Should Vura integrate CelsianJS as its server layer?** Currently generates its own HTTP server. Using CelsianJS would get security headers, compression, CORS, JWT, etc. for free.
- **Pick one name: ThenJS or Vura?** Code uses both names in different places.

### Nice to Have
- Hot module replacement (HMR) for dev server
- ISR (Incremental Static Regeneration) integration test with real cache behavior
- CLI `create` scaffolding command
- Documentation site

## How to Resume
```bash
cd vura
pnpm build
pnpm test    # 360 tests, all should pass
```
