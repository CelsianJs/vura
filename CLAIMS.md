# Marketing Claims Register

Every public claim about Vura, with how it is verified. Rule: a claim ships
only with a row here; a row needs a command someone else can run, or it's cut.
"Faster than X" without a reproducible benchmark is banned outright.

| # | Claim | Where it appears | Verification | Status |
|---|---|---|---|---|
| 1 | "MIT, forever — no relicensing" | README.md, GOVERNANCE.md | `cat LICENSE` — MIT header; `grep -L '"license": "MIT"' packages/*/package.json` must return empty | verified |
| 2 | "Every self-host guide is executed in CI on every commit" | (future landing, /self-host) | `.github/workflows/selfhost.yml` — **DO NOT USE this claim until the workflow exists. Gate: Task 11 sign-off required before this claim ships on any public-facing page (landing or /self-host).** | planned (Task 7/8 this cycle; blocked until Task 11) |
| 3 | "Nothing is platform-gated — websockets, cache revalidation, tasks, cron all work fully self-hosted — verified by an automated audit suite in CI" | GOVERNANCE.md (future-tense wording: "will be enforced") | `tests/self-host-audit/` suite A0–A9 — **GOVERNANCE already uses future-tense wording; do not flatten to present tense until suite exists. Gate: Task 11 sign-off required before the "verified by an automated audit suite" wording ships on any public-facing page.** The landing page (docs-site/pages/index.html) as of Task 3 uses present-tense "nothing is platform-gated" without the audit-suite qualifier — this is acceptable because the functional claim is true; only the "verified by CI" qualifier is held back. | planned (suite lands this cycle; guarded wording in Task 3 landing approved) |
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
| 21 | "create-vura emits eleven files" | `docs-site/pages/ladder/0-create.md` | `node packages/create-vura/dist/index.js /tmp/verify-0create --no-install 2>&1 \| grep -c '+'` — must return 11 | verified (counted from getFiles() in packages/create-vura/src/index.ts: 11 files) |
| 22 | "Static pages: `dist/static/<page>/index.html`, zero JS shipped" | `docs-site/pages/ladder/1-static.md` | `npm run build` on a static-only page; `ls dist/static/about/` — must show `index.html`; `grep -r "_then/" dist/static/` must return empty. Same as row 4 gate. | planned (same CI assertion gate as row 4) |
| 23 | "`revalidate` and `tags` are flat properties on the page config (not nested)" | `docs-site/pages/ladder/2-cache.md` | `packages/core/src/runtime/pages.ts` lines 93–103: `typeof p.config.revalidate === 'number'` and `p.config.tags` — both read from flat config, not from a nested `revalidate` object | verified — code-level |
| 24 | "`vura tasks run <name>` outputs JSON with status/result/attempts" | `docs-site/pages/ladder/5-tasks.md` | `packages/cli/src/commands/tasks.ts` line 102: `console.log(JSON.stringify(result, null, 2))` where result is `TaskRunResult` | verified — code-level |
| 25 | "Hot routes cannot run on Cloudflare Workers or AWS Lambda" | `docs-site/pages/ladder/6-deploy.md` | `packages/adapter-cloudflare/src/index.ts` line 498: `manifest.api.filter(r => r.kind === 'serverless')` — only serverless routes are bundled into the Worker | verified — code-level |
| 26 | "Task cron on Cloudflare Workers uses the `scheduled` event" | `docs-site/pages/ladder/5-tasks.md`, `6-deploy.md` | `packages/adapter-cloudflare/src/index.ts` lines 408–428: `scheduled(event, env, ctx)` handler in generated Worker entry; `wrangler.toml` cron triggers from `generateWranglerToml` | verified — code-level |

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
