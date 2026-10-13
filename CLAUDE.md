# Working on Vura

Vura is a meta-framework: file routing, a build, and a server runtime, fusing
[What Framework](https://whatfw.com) on the client with
[CelsianJS](https://github.com/CelsianJs/celsian) on the server.

This file is for whoever is editing the framework itself. If you are *using*
Vura, the docs are at [vura.io](https://vura.io).

## Layout

| Package | What it is |
|---|---|
| `packages/contract` | Pure legacy/v1 manifest data contract and capability evaluation, with no runtime dependencies. Reader-first rollout; producers are not switched yet. |
| `packages/core` | Route manifest, build, server runtime, page rendering. Runtime/build consumers depend on it; the contract and compiler packages stay independent. |
| `packages/cli` | `vura dev` / `build` / `deploy` / `admin`. Owns the esbuild wiring. |
| `packages/compiler` | Restricted static-literal parsers for route/page config. Never evaluates project code. |
| `packages/create-vura` | The scaffold. |
| `packages/adapter-*` | Cloudflare, Lambda, and the managed platform. |
| `packages/vite-plugin` | Optional Vite integration. |
| `docs-site` | vura.io. Built by `docs-site/build.mjs`, deployed from `dist/`. |

Commands: `pnpm build` (tsc project references), `pnpm test`,
`pnpm test:selfhost-audit`, `pnpm lint`, `pnpm docs:build`,
`pnpm package:size`. Node 20 or 22, pnpm via `corepack`.

## The one thing to understand first

**A built Vura app is not one program.** `dist/server/entry.js` inlines its
dependencies. `dist/server/pages/*.js`, `api/*.js`, `actions/*.js` and
`middleware.js` are bundled separately and resolve `@celsian/vura-core` through
a shim that inlines its **own copy**. Each page and each layout is a separate
bundle.

Three consequences, each of which has already shipped as a bug:

1. **A module-level singleton is not a singleton.** Shared state must hang off
   `globalThis` under a `Symbol.for` key. See `runtime/loader.ts` and
   `runtime/actions.ts`.

2. **`instanceof` is false across the boundary.** An `HttpError` thrown by a
   route is a different class object from the one the caller compares against.
   Check structurally. `formatErrorResponse` gates on `instanceof` internally,
   so a cross-bundle `HttpError` routed through it becomes a generic 500.
   Call the instance's own `toJSON(isDev)` instead.

3. **An esbuild `onResolve` that returns a path beats `external`.** Setting
   both silently loses, and you get a second copy of whatever you were trying
   to keep external. This is what made `useSignal()` throw in every prerendered
   page until 0.7.0.

If something works from source and fails in a built app, or works in one page
mode and not another, suspect two copies before suspecting logic.
`packages/core/src/runtime-shim.ts` has the export allowlist; a public runtime
export missing from it is unusable in a built app.

## Where the real tests are

`packages/core/test/` is unit-level and fast. It cannot see any of the above.

`tests/self-host-audit/` is the suite that matters: it scaffolds a project,
installs the **packed tarballs**, runs `vura build`, boots
`node dist/server/entry.js`, and drives it over HTTP. Everything the bundling
model can break is only visible here.

Two lessons paid for in defects:

- **A fixture that avoids the mechanism proves nothing.** Every hybrid fixture
  held state in a module-level `signal()`, which needs no component context, so
  the suite proved hybrid pages render and hydrate for months while
  `useSignal()` could not be used in one at all.
- **Verify a fix by re-inserting the bug.** Put the old code back and watch the
  new test fail. A test written from the same misunderstanding as the fix
  passes against both.

## Conventions a project uses

```
src/pages/**       pages; `export const page = { mode }`: static | server | client | hybrid
src/pages/**/_layout.tsx   layout, wraps everything below it
src/api/**         API routes; `export const route = { kind }`: serverless | hot | task
src/api/_hooks.ts  lifecycle hooks (API routes only)
src/middleware.ts  runs before static, API and pages alike
src/actions/**     server actions; every named export is callable from the browser
```

Route and page config is read by `@celsian/vura-compiler`'s restricted parser.
It does not import or evaluate project modules, and it must stay that way:
scanning runs before anything is built.

## House rules

- **Claims need a command.** `CLAIMS.md` holds every public claim with a
  reproducible verification. A claim without a row does not ship.
- **Budgets are ledgers, not walls.** `packages/core/test/loc-budget.test.ts`
  and `scripts/package-size-limits.json` fail when exceeded. Raise them *with a
  written entry* saying what was added and why.
- **Prove absence by execution, not by grep.** A missing symbol is not a
  missing feature. Run it.
- **Release evidence.** Follow `RELEASING.md`: agents verify and check CI,
  builds, tests, links, factual claims, and publication evidence. Reserve human
  acceptance for explicit visual/product judgments or inaccessible real-world
  scenarios; missing automated evidence remains agent-owned. Never attest to
  human acceptance on someone's behalf. `pnpm release:check` needs a clean tree,
  so commit first, and identify the verified commit in the release PR.
