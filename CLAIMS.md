# Marketing Claims Register

Every public claim about Vura, with how it is verified. Rule: a claim ships
only with a row here; a row needs a command someone else can run, or it's cut.
"Faster than X" without a reproducible benchmark is banned outright.

| # | Claim | Where it appears | Verification | Status |
|---|---|---|---|---|
| 1 | "MIT, forever — no relicensing" | README.md, GOVERNANCE.md | `cat LICENSE` — MIT header; `grep -L '"license": "MIT"' packages/*/package.json` must return empty | verified |
| 2 | "Every self-host guide is executed in CI on every commit" | (future landing, /self-host) | `.github/workflows/selfhost.yml` — **DO NOT USE this claim until the workflow exists** | planned (Task 7/8 this cycle) |
| 3 | "Nothing is platform-gated — websockets, cache revalidation, tasks, cron all work fully self-hosted" | GOVERNANCE.md (future-tense wording: "will be enforced") | `tests/self-host-audit/` suite A0–A9 — **GOVERNANCE already uses future-tense wording; do not flatten to present tense until suite exists** | planned (suite lands this cycle) |
| 4 | "Static pages ship zero framework JavaScript" | README.md (`static` pages section), docs-site scaffold copy | CI assert: no `_then/` script tag in static page output — `grep -r "_then/" dist/static/` must return empty after `vura build` on a static-only project | planned (CI assertion not yet wired; code behaviour verified locally) |
| 5 | "`revalidateTag` / cache invalidation works self-hosted" | GOVERNANCE.md | Scope to projects where a CDN adapter is configured; "global/CDN purge" wording only appears where CDN adapter docs exist | qualified — "global/CDN purge" wording only where a CDN adapter is configured |
| 6 | "Hot routes: no timeout, in-memory state, websockets" | (future /ladder/4-hot) | `packages/core/test/hot-routes.test.ts` (12 tests, committed on this branch); "no timeout" = no framework-imposed limit; host/platform limits still apply | verified at code level |
| 7 | "One-line change to promote a route to hot" (kind='hot') | (future landing) | Literally one export-field change; rung-4 docs page will show the actual diff | verified |
| 8 | "Built on What Framework + CelsianJS" | README.md | `packages/core/package.json` deps: `what-framework ^0.11.1`, `@celsian/core ^0.5.2`, `what-isr ^0.11.1`; runtime composition in `packages/core/src/` | verified on this branch (gate: published to npm — v0.4.0 not yet published as of 2026-06-11) |
| 9 | "12 KB runtime" (What Framework) | `sites/landing/index.html` (now redirected) | This number belongs to the What Framework project, not Vura. **Not verified within this repo.** Must not appear in Vura-owned pages until confirmed by a reproducible measurement in the what-framework repo. | removed from sites/landing (redirect); **banned from Vura-owned copy until externally sourced** |
| 10 | "Static pages ship zero JavaScript" (in landing code example comment) | `sites/landing/index.html` (now redirected) | Same as row 4 — code comment in a demo snippet, inherently illustrative. Landing page replaced with redirect; if reused in future docs, must link to the CI assertion. | removed from sites/landing (redirect) |
| 11 | "Fast by default" (signal reactivity) | `sites/landing/index.html` (now redirected) | Vague superlative with no benchmark. **Banned outright** from Vura-controlled copy unless replaced with a reproducible benchmark number. | removed from sites/landing (redirect) |
| 12 | "Up and running in minutes" | `sites/landing/index.html` (now redirected) | Qualitative. Acceptable as marketing copy only if the quick-start scaffold actually completes without error — gated on v0.4.0 publish + smoke test. | removed from sites/landing (redirect) |
| 13 | Version numbers (What Framework v0.8, CelsianJS v0.3, Vura v0.1) in ecosystem cards | `sites/landing/index.html` (now redirected) | Were stale at time of redirect (What FW is 0.11.1, Celsian 0.5.2, Vura 0.4.0 on this branch). All removed with the redirect. Future landing must pull version from package.json at build time. | removed from sites/landing (redirect) |
| 14 | Canonical domain | `sites/landing/index.html`, all docs links | Canonical framework domain is **vura.io** (decided 2026-06-11; vura.app is parked and reserved). `vura.dev` is an unrelated third-party product (Postgres proxy) — never link to it. Old landing replaced with a redirect to `https://github.com/CelsianJs/vura` until the docs site takes over the vura.io deploy (A3 Task 11). | decided — vura.io |
| 15 | "Full-Stack TypeScript Framework" (title/og:title) | `sites/landing/index.html` (now redirected) | Pre-wedge positioning; Vura's current wedge is "outgrew serverless / hot routes". Removed with the redirect. | removed from sites/landing (redirect) |
| 16 | Package tarball sizes | `scripts/package-size-limits.json` | `pnpm run package:size` — tracked limits: vura-core 115 KB, vura-cli 45 KB, vura-compiler 10 KB, create-vura 10 KB, adapter-cloudflare 15 KB, adapter-lambda 18 KB, vite-plugin 12 KB. These are **ceiling limits**, not marketing numbers; do not quote them as "tiny" or "lightweight" without a real comparative baseline. | verified as limits (not marketing claims — do not quote in prose) |
| 17 | "Native Rust compiler" / "native-speed alternative" | `packages/compiler-native/README.md` | Prototype only; package is private and unpublished. README correctly says "unpublished prototype — source-only until platform binaries are released." | qualified — do not surface externally until binaries ship |
| 18 | `vura deploy` for managed platform | README.md, `sites/landing/index.html` (now redirected) | README correctly states "intentionally fails closed in the open-source CLI." Landing card said "Currently in private beta." No commit gate on this claim, but it is forward-looking. | qualified — present-tense "private beta" claim must not appear until beta access is open; README wording is correct |
| 19 | "453 tests" | (used in internal planning docs) | `pnpm test --reporter=verbose 2>&1 \| tail -5` — recount at each release; do not embed a static count in public copy | not a public claim; record here to prevent future quoting without recount |
| 20 | AI-native / MCP DevTools | `sites/landing/index.html` (now redirected) | Belongs to What Framework, not Vura core. Removed with redirect. Acceptable in future Vura copy only as "What Framework's MCP DevTools are accessible from Vura projects" with a link to what-framework docs. | removed from sites/landing (redirect) |

---

## Packages/\*/README.md inventory (Task 10)

The following hits from `packages/*/README.md` are catalogued here for Task 10
to resolve. They are not currently public marketing claims (packages not yet
published at v0.4.0) but must be cleaned before publish.

| Ref | File | Hit | Assessment |
|---|---|---|---|
| P1 | `packages/compiler-native/README.md` | "optional native-speed alternative" | Resolved (Task 10): wording replaced with "AST-based route scanner and JSX transformer written in Rust" — describes mechanism, not a speed claim |
| P2 | `packages/compiler/README.md` | "transforms routes, pages, and API endpoints into optimized build output" | Resolved (Task 10): "optimized" removed; new wording is "regex-based route scanning and JSX transforms" — descriptive, no unmeasured superlatives |

---

## Sign-off

Sign-off pending: requires review of built docs-site against this register at
the v0.5 gate (see RELEASING.md, landing this release cycle). Reviewer should run `pnpm release:check` and
confirm each "verified" row's command returns clean output against the
published tarball before any landing-page or docs copy quotes a claim.
