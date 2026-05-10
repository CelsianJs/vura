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

## 2026-05-10 — Scaffold publish-smoke and namespace honesty

Product-review refresh found that the intended public quickstart depends on the blocked `@then/*` npm namespace and that package verification did not exercise the scaffold path. Addressed locally:

- README now clearly marks `@then/*` install/create commands as intended public UX pending npm scope authority or an intentional rename.
- README release checks now include lint, audit, `pnpm verify:publish`, dry-run publish, and explicit E404/permission stop guidance.
- `scripts/verify-publish.mjs` now runs a packed `create-then` dry-run scaffold smoke and checks generated dependencies stay aligned with the current release version.

Verification:
- `pnpm lint`
- `pnpm build`
- `pnpm test` → 27 files, 381 tests passed
- `pnpm audit` → 0 known vulnerabilities (Node emitted existing `url.parse()` deprecation warning)
- `pnpm verify:publish` → 8 tarballs, no workspace refs, clean install/import, create-then scaffold smoke passed
- `VURA_PUBLISH_DRY_RUN=1 node scripts/publish-packages.mjs` → 8 dry-run publish candidates passed
- `git diff --check`

Remaining external blocker:
- Real publish is still blocked until npm `@then` scope authority exists or package names are intentionally changed and all gates are rerun.

## 2026-05-10 — Post-publish registry smoke follow-up

Gold-standard re-review found that tag releases verified local tarballs but did not prove the packages just published to npm could be installed by a real consumer. Addressed locally:

- Added `scripts/verify-registry-install.mjs` and `pnpm verify:registry` to install the published package set into a fresh temp project, import the public runtime packages, run `create-then --dry-run`, and emit `artifacts/registry-smoke.json`.
- Release workflow now runs `pnpm verify:registry` immediately after `node scripts/publish-packages.mjs` and uploads the registry smoke artifact for release evidence.

Verification:
- `node --check scripts/verify-registry-install.mjs` passed
- `pnpm lint` passed
- `pnpm build` passed
- `pnpm test` passed: 27 files, 381 tests
- `pnpm verify:publish` passed: 8 tarballs, no workspace refs, clean install/import + create-then scaffold smoke
- `git diff --check` passed

Not run:
- `pnpm verify:registry` is intentionally post-publish only and remains blocked locally until npm `@then/*` namespace publishing authority or package naming is resolved.

## 2026-05-10 — Registry smoke artifact hardening follow-up

Product/gold-standard re-review confirmed the post-publish registry smoke direction and found one artifact-path hardening gap. Addressed locally:

- Root `packageManager` now pins `pnpm@10.11.0` to match CI/release setup.
- Release workflow upload now fails if `artifacts/registry-smoke.json` is missing.

Verification:
- `node --check scripts/verify-registry-install.mjs` passed
- `pnpm lint` passed
- `pnpm verify:publish` passed: 8 tarballs, no workspace refs, clean install/import + create-then scaffold smoke
- `git diff --check` passed

Still blocked:
- Real `pnpm verify:registry` / publish remains blocked by npm `@then/*` namespace authority or an intentional rename decision.

## 2026-05-10 — Compiler-native release guard follow-up

Gold-standard re-review found the dormant compiler-native workflow could become a future publish footgun. Addressed locally:

- Added `scripts/assert-release-private.mjs` and `pnpm assert:release-private` to verify `@then/compiler-native` remains `private: true` and excluded from `scripts/package-list.mjs`.
- CI and release workflows now run the assertion before lint/build/publish verification.

Verification:
- `node --check scripts/assert-release-private.mjs` passed
- `pnpm assert:release-private` passed
- `pnpm lint` passed
- `pnpm verify:publish` passed
- `git diff --check` passed
