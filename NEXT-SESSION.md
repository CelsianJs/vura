# Vura (ThenJS Meta-Framework) — Next Session Pickup

## Current State
- **Branch**: `audit-hardening`
- **Tests**: 360 passing (`pnpm test`, 20 files)
- **Build**: `pnpm build` passing
- **Pack check**: `@then/vite-plugin` must contain `dist/index.js` + `dist/index.d.ts` before publish (`npx pnpm@10.23.0 --filter @then/vite-plugin pack --pack-destination /tmp/vura-pack-check`)
- **PM Score**: 8.5/10 after OSS release-blocker fixes

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

## Release Checklist (Do Not Publish From Agent Lane)
- [ ] Confirm `pnpm build` passes
- [ ] Confirm `pnpm test` passes (current baseline: 360 tests)
- [ ] Confirm `git diff --check` passes
- [ ] Run `npx pnpm@10.23.0 --filter @then/vite-plugin pack --pack-destination /tmp/vura-pack-check` and inspect tarball contents
- [ ] Review generated package metadata for all publishable packages
- [ ] Publish only after human approval and release tag/changelog are ready

## What Remains

### Should Fix (from PM reviews)
1. Broaden package pack checks to every publishable `@then/*` package.
2. Add release CI that runs pack checks and generated-artifact runtime smoke tests.
3. Decide whether Cloudflare route support should expose more `@then/core` runtime APIs or keep the current safe route-runtime shim surface.

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
