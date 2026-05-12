# Vura (ThenJS Meta-Framework) — Next Session Pickup

## Current State
- **Branch**: `audit-hardening`
- **Tests**: latest `pnpm release:check` passed with 31 Vitest files / 392 tests
- **Build**: `pnpm build` passing
- **Pack check**: `pnpm verify:publish` currently verifies 7 public tarballs, no `workspace:` refs, installed CLI bins, imports, and create-then scaffold build/run smoke
- **Gold-standard score**: 45/50 after OSS release-blocker fixes; package tarballs are locally publish-ready, but npm `@celsian/*` scope authorization still blocks actual publish

## What Was Done
- Fixed production hooks: _executeWithHooks had dead code path (error always swallowed)
- Enforced ESM purity: replaced all require() with top-level ESM imports in generated server
- Added realpathSync traversal guard for static file serving
- Added one-time CORS dev warning when defaulting to "*"
- Made ISR_MAX_ENTRIES configurable via env var
- Added global hooks via `_hooks.ts` convention
- Made `@celsian/then-vite-plugin` publishable with `dist` files, `main`/`types`/conditional exports, build/prepack scripts, and public publish config
- Declared runtime `esbuild` dependencies for core/CLI/Lambda/Cloudflare packages and updated lockfile importers
- Bundled route artifacts as self-contained JS when routes import `@celsian/then-core`; added Lambda/Cloudflare/core smoke coverage
- Missing route sources now fail builds with route path + absolute source context instead of being skipped
- Hardened task admin auth so production requires `THEN_TASK_SECRET`; localhost no-secret bypass is limited to explicit dev/test

## Release Checklist / Current Blocker
- [x] `pnpm build` passes
- [x] `pnpm test` passes (current baseline from latest release check: 31 Vitest files / 392 tests)
- [x] `pnpm verify:publish` passes: 7 public tarballs, no `workspace:` refs, clean npm install/import smoke, create-then scaffold build/run smoke, private package guards
- [x] `VURA_PUBLISH_DRY_RUN=1 node scripts/publish-packages.mjs --dry-run` passes for 7 public JS packages and excludes private packages
- [x] `CHANGELOG.md` and `.github/workflows/release.yml` added
- [x] **Namespace resolved:** packages renamed from `@then/*` to `@celsian/then-*` under the owned `@celsian` npm scope.
- [ ] Rerun `pnpm release:check` after rename and publish.

## What Remains

### Should Fix (from PM reviews)
1. Resolve npm namespace authorization for `@celsian/*` or rename packages to an owned scope.
2. After namespace resolution, rerun `pnpm release:check`.

### Strategic Decisions (for Kirby)
- **Should Vura integrate CelsianJS as its server layer?** Currently generates its own HTTP server. Using CelsianJS would get security headers, compression, CORS, JWT, etc. for free.
- **Pick one name: ThenJS or Vura?** Code uses both names in different places.

### Nice to Have
- Hot module replacement (HMR) for dev server
- ISR (Incremental Static Regeneration) integration test with real cache behavior
- CLI `create` scaffolding command
- Documentation site





## 2026-05-10 — Clean release tree gate

Release safety follow-up: `pnpm release:check` now ends with `scripts/assert-clean-release-tree.mjs`, which runs whitespace checks and fails if `git status --porcelain` reports modified or untracked files. This closes the gap where `git diff --check` could pass while untracked files were present.

Verification:
- `npx -y pnpm@10.11.0 exec vitest run scripts/assert-clean-release-tree.test.mjs` passed.
- `npx -y pnpm@10.11.0 release:check` passed from a clean tree: private assertions, hygiene, build, 31 Vitest files / 392 tests, production audit, packed publish verification, package size gate, npm publish dry-run for 7 tarballs, and clean release tree assertion.

## 2026-05-10 — Cloudflare route-runtime decision

Resolved the local Cloudflare runtime-surface decision: keep the adapter on the conservative generated `req`/`reply` shim and expose Cloudflare-specific capabilities only through `req.__cf_env` / `req.__cf_ctx` escape hatches until a concrete use case justifies a first-class public API. README now documents this as the intended compatibility policy.

Verification:
- `git diff --check`

## 2026-05-10 — npm namespace preflight refresh

Real publish remains safely blocked before any upload:

- `npm whoami` resolved to `kirby_zvndev`.
- `npm view @celsian/*@0.1.0` and `npm view create-then@0.1.0` returned E404, so the intended versions are not already published.
- `node scripts/publish-packages.mjs` now uses the current npm command `npm access list packages @celsian --json` for scope authority.
- `VURA_PUBLISH_DRY_RUN=1 node scripts/publish-packages.mjs --dry-run` still passes for the 7 public tarballs. The npm scope guard is now covered by `scripts/publish-packages.test.mjs`.

Conclusion: release artifacts are ready under the `@celsian` npm scope.

## 2026-05-10 — Release-check refresh after smoke audit

Latest local release-readiness evidence remains green, but real npm publish is still blocked by the `@celsian/*` namespace authority / rename decision.

Verification:
- `npx -y pnpm@10.11.0 release:check` passed: private assertions, hygiene, build, 31 Vitest files / 392 tests, production audit, packed publish verification with real `create-then` scaffold build/run smoke, package size gate, npm publish dry-run for 7 public tarballs, clean release tree assertion, and `git diff --check`.

Not run:
- Real `pnpm verify:registry` / publish, because npm scope authority is unresolved.

## How to Resume
```bash
cd vura
npx -y pnpm@10.11.0 release:check
node scripts/publish-packages.mjs
```

## 2026-05-10 — Scaffold publish-smoke and namespace honesty

Product-review refresh found that the intended public quickstart depends on the blocked `@celsian/*` npm namespace and that package verification did not exercise the scaffold path. Addressed locally:

- README now clearly marks `@celsian/*` install/create commands as intended public UX pending npm scope authority or an intentional rename.
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
- Packages now use the `@celsian` npm scope. Rerun release checks after rename verification.

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
- `pnpm verify:registry` is intentionally post-publish only and remains blocked locally until npm `@celsian/*` namespace publishing authority or package naming is resolved.

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
- Real `pnpm verify:registry` / publish remains blocked by npm `@celsian/*` namespace authority or an intentional rename decision.

## 2026-05-10 — Compiler-native release guard follow-up

Gold-standard re-review found the dormant compiler-native workflow could become a future publish footgun. Addressed locally:

- Added `scripts/assert-release-private.mjs` and `pnpm assert:release-private` to verify `@celsian/then-compiler-native` remains `private: true` and excluded from `scripts/package-list.mjs`.
- CI and release workflows now run the assertion before lint/build/publish verification.

Verification:
- `node --check scripts/assert-release-private.mjs` passed
- `pnpm assert:release-private` passed
- `pnpm lint` passed
- `pnpm verify:publish` passed
- `git diff --check` passed

## 2026-05-10 — Adapter-vura publish guard follow-up

Product review and verifier follow-up found `@celsian/then-adapter-vura` was still in the public package publish set while Vura Platform live smoke remains blocked. Addressed locally:

- Marked `packages/adapter-vura` private and removed it from `scripts/package-list.mjs` until Vura Platform live smoke passes.
- Extended `pnpm assert:release-private` to fail if adapter-vura becomes public or re-enters the publish list prematurely.
- Updated local release checks to run `pnpm assert:release-private` before publish verification.

Verification:
- `pnpm assert:release-private` passed
- `pnpm lint` passed
- `pnpm build` passed
- `pnpm test` passed: 27 files / 381 tests
- `pnpm verify:publish` passed: 7 tarballs, no workspace refs, clean install/import + create-then scaffold smoke
- `git diff --check` passed


## 2026-05-10 — Product-review locally fixable release hardening

Vura product-review follow-up found local release gates and scaffold metadata could still drift. Addressed locally:

- Added `pnpm release:check` as the single local release gate covering private assertions, lint, build, tests, production audit, packed publish verification, npm dry-run publish, and `git diff --check`.
- Removed the non-dry-run npm scope preflight bypass; real publish must prove npm identity and scoped package authority before upload.
- Moved `create-then` scaffold dependency versions out of source constants: `what-framework` comes from `create-then` package metadata, and `@celsian/then-core` / `@celsian/then-cli` use workspace package versions locally or the `create-then` package version after publish.
- Strengthened `pnpm verify:publish` to compare scaffold dependencies against package/root metadata instead of fixed literals.
- Clarified manual release behavior in README/CONTRIBUTING: dry-runs are local verification only; real publish remains blocked until npm scope authority or an intentional rename.
- Documented `dangerouslySetInnerHTML` rendering as trusted, unsanitized caller-provided HTML.

Verification:
- `pnpm lint` passed
- `pnpm build` passed
- `pnpm test` passed: 29 files / 389 tests
- `npx pnpm@10.11.0 audit --prod` passed: no known vulnerabilities
- `npx pnpm@10.11.0 verify:publish` passed: 7 tarballs, no workspace refs, installed CLI bins/direct help, clean install/import, create-then scaffold build/run smoke
- `VURA_PUBLISH_DRY_RUN=1 node scripts/publish-packages.mjs --dry-run` passed for 7 publish candidates
- `git diff --check` passed
- `npx pnpm@10.11.0 release:check` passed end-to-end

Still blocked:
- Real publish remains blocked until npm `@celsian/*` namespace authority exists or package names are intentionally changed by an owner and all gates are rerun.

## 2026-05-10 — WhatStack runbook smoke refresh

Ran the Vura build/run smoke from `../SMOKE-TEST-RUNBOOK.md` against the local CLI and a fresh `/tmp/vura-smoke-test` app:

- `node packages/cli/dist/bin.js build` found 2 API routes and 2 pages, rendered static pages, copied public assets, and produced `dist/server/entry.js`.
- The generated server entry contained no `require(` calls.
- The built server returned JSON from `/api/hello`, echoed POST JSON from `/api/echo`, served `/test.txt`, and returned `200` for `/` and `/about`.

## 2026-05-10 — GitHub CI tar portability follow-up

After pushing `audit-hardening`, GitHub CI exposed a Linux-only failure in `packages/adapter-vura/test/tarball.test.ts`: GNU tar exits nonzero when the destination tarball is created inside the directory being archived. Addressed locally:

- `createTarball()` now writes the archive to an external temporary directory first, then renames it to the requested output path.
- This preserves shell-injection safety while avoiding GNU tar's "file changed as we read it" failure.

Verification:
- `pnpm --filter @celsian/then-adapter-vura test` passed.
- `pnpm --filter @celsian/then-adapter-vura build` passed.
- `git diff --check` passed.

## 2026-05-10 — PR auxiliary workflow follow-up

Opening the audit-hardening PR exposed auxiliary workflow failures outside the main JS release gate. Addressed locally:

- `@celsian/then-compiler-native` napi config now disables default triples so the matrix target list does not duplicate built-in targets and fail every native build with `Duplicate targets are not allowed`.
- Security workflow grants `actions: read` for CodeQL PR overlay database access.
- Secret scanning now runs the open-source gitleaks Docker CLI directly instead of `gitleaks/gitleaks-action@v2`, which requires a paid org license secret.

Verification:
- `node -e "JSON.parse(...)"` package metadata check passed.
- `git diff --check` passed.
- Full evidence is expected from the GitHub PR workflow rerun.

## 2026-05-10 — CodeQL availability follow-up

The PR security workflow reached CodeQL analysis successfully, but upload failed because GitHub Advanced Security/code scanning is not enabled for this repository. Addressed locally:

- CodeQL analyze is now non-blocking until GHAS/code scanning is enabled.
- The gitleaks CLI secret scan remains the blocking security gate.

Verification:
- `git diff --check` passed.
- Full evidence is expected from the GitHub PR workflow rerun.

## 2026-05-11 — Final native CI wrap evidence

After merging the low-risk `serde_json` Dependabot patch, GitHub native CI exposed a real wrap blocker: all seven `@celsian/then-compiler-native` platform builds passed, but the follow-on artifact aggregation job failed because `napi artifacts` expected future per-platform package `dist` directories that this source-only private native prototype does not publish yet.

Addressed on `main`:

- `5f31dc5` — replaced `napi artifacts` with direct verification/copying of exactly seven downloaded `.node` artifacts.
- `3561db5` — added `workflow_dispatch` plus workflow-file path triggers so native workflow fixes self-verify.

Verification on `main@3561db5`:

- GitHub CI `25653817903` passed.
- GitHub Security scanning `25653817910` passed.
- GitHub Build `@celsian/then-compiler-native` `25653817912` passed: all seven platform build jobs and artifact aggregation green.

Still blocked:

- Real Vura publish remains blocked until npm `@celsian/*` scope authority exists or package names are intentionally changed by an owner and all gates are rerun.

## 2026-05-11 — Current handoff-doc head

- Use `git rev-parse --short HEAD` on `main`; this handoff file may be committed after earlier evidence sections, so avoid copying a stale self-referential hash.
