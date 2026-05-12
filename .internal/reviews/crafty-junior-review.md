# Crafty's Review -- Junior Developer Perspective

I was handed the ThenJS codebase and told "try building something with it." Here is what I found.

## First Impressions

Opening the project, the first thing I notice is: **there is no README.md**. The only documentation is `PLAN.md`, which is more of an internal roadmap than a getting-started guide. As a junior dev, this is a rough start. I have to piece together what this thing does from the plan doc, the code comments, and the examples.

That said, the `PLAN.md` is genuinely well-written. The tables explaining route kinds (serverless/hot/task) and page modes (static/server/client/hybrid) gave me a mental model in about 30 seconds. The handler code examples in the plan are clear and concise. If this were a README instead of a plan doc, it would be a strong start.

The monorepo structure is clean: 8 packages, 4 examples. I can navigate it. No complaints there.

## Getting Started Experience

### The Good

The `create-then` scaffolder (`packages/create-then/src/index.ts`) exists and looks solid. It generates a complete project with API routes, pages, tsconfig, and gitignore. The output includes nice colored terminal output and next-steps instructions. That is the right pattern.

The CLI help (`then --help`) is minimal but clear:

```
  Commands:
    dev         Start local development server
    build       Build the project for deployment
    deploy      Deploy to configured provider
    manifest    Print the route manifest (debug)
```

### The Bad

I cannot actually run `create-then` because it is not published to npm. The `package.json` in the scaffolder references `'@then/core': 'latest'` and `'@then/cli': 'latest'` -- packages that do not exist on the registry yet. So the scaffolder would fail on `pnpm install` even if I could run it.

The root `package.json` has local file references for `what-framework`:

```json
"what-framework": "file:/Users/macbookpro-kirby/Desktop/Coding/ZVN/what-fw/packages/what"
```

This is a hardcoded absolute path to someone else's machine. If I cloned this repo, it would immediately fail to install. This is a blocker for any external contributor.

### The Confusing

The relationship between ThenJS, What Framework, and CelsianJS is mentioned everywhere but never clearly explained in one place. From `PLAN.md` line 16-19, I gather:
- What Framework = frontend (signals + JSX)
- CelsianJS = backend (req/reply, plugins)
- ThenJS = glue layer

But CelsianJS is referenced as both a backend framework AND a deployment platform ("Celsian" vs "CelsianJS"). The deploy command (`packages/cli/src/commands/deploy.ts`) just prints a message telling me to sign up at `https://celsian.dev`. That URL probably does not exist yet. The whole deploy story feels like vaporware at this stage.

## What Worked Well

### 1. The API Route Pattern is Intuitive

Looking at `examples/full-stack/src/api/hello.ts`:

```typescript
export const route = { kind: 'serverless' as const };

export function GET(req: ThenRequest, reply: ThenReply) {
  return reply.json({ message: 'Hello from ThenJS!' });
}
```

This clicked immediately. Export named HTTP methods, declare the route kind. Dead simple. The `ThenRequest`/`ThenReply` types in `packages/core/src/handler.ts` are clean and well-documented. Chainable `reply.status(201).json(data)` is familiar from Express/Fastify.

### 2. Page Modes are Well-Designed

The four page modes (static, server, client, hybrid) cover real use cases. The `export const page = { mode: 'server' }` convention is easy to remember. The `getServerData()` pattern in `examples/full-stack/src/pages/stats.tsx` is a clean data-loading solution -- it is basically Next.js `getServerSideProps` but simpler.

### 3. The Task System is Thoughtful

`packages/core/src/tasks.ts` implements a complete in-memory job queue with retries, exponential backoff, timeouts, and cron scheduling -- all in ~320 lines with zero dependencies. The cron parser handles real expressions (ranges, steps, comma-separated values). The tests for it all pass (132/132 across the repo).

### 4. File-Based Routing Works

The manifest scanner (`packages/core/src/manifest.ts`) correctly converts:
- `src/api/users/[id].ts` to `/api/users/:id`
- `src/pages/blog/[slug].tsx` to `/blog/:slug`
- Route groups `(auth)/` are stripped

### 5. Strong Test Coverage

132 tests, all passing in 3.68 seconds. Tests cover the manifest scanner, build pipeline, route matching, adapters, task system, and server pages. For an early-stage project, this is impressive.

## Pain Points

### 1. Task Route API Signature is Inconsistent

This is genuinely confusing. The task system documentation in `packages/core/src/tasks.ts` (line 15-16) says tasks should export:

```typescript
export async function POST(job) { return { success: true }; }
// where job = { taskId, input, attempt }
```

But the task example in `examples/backend-only/src/api/tasks/process.ts` exports a regular API handler:

```typescript
export async function POST(req: any, reply: any) {
  const body = req.parsedBody as { type?: string; payload?: any };
  // ...
  return reply.status(202).json({ ... });
}
```

So which is it? Does a task handler receive `(job)` or `(req, reply)`? Looking at the generated server entry code in `packages/core/src/build.ts` line 216-217, task handlers are called as:

```javascript
handlerFn({ taskId: job.id, input: job.input, attempt: job.attempt })
```

But the dev server in `packages/cli/src/commands/dev.ts` line 168-173 calls them as:

```javascript
mod.POST({ taskId: String(Date.now()), input: body?.input, attempt: 1 })
```

Meanwhile the actual example uses `(req, reply)` style. This is a real bug -- the example task handler will break when invoked via the task runner because it expects two arguments, not one.

### 2. SSR Renderer is Copy-Pasted Four Times

The `renderToString` / `builtinRenderToString` function appears in:
1. `packages/core/src/static-render.ts` (line 153)
2. `packages/core/src/build.ts` (line 108, as string template)
3. `packages/vite-plugin/src/index.ts` (line 342)
4. `packages/cli/src/commands/dev.ts` (line 358)

Each copy is slightly different. The one in `build.ts` is emitted as strings of JavaScript (line-by-line array of strings joined with newlines), which is extremely hard to read and maintain. If a bug is found in the renderer, someone has to fix it in four places. This is a maintenance nightmare waiting to happen.

### 3. `then.config.ts` is Nearly Useless

The example config file is:

```typescript
import { defineConfig } from '@celsian/then-core';
export default defineConfig({});
```

Empty config. The `defineConfig` function (`packages/core/src/config.ts` line 70) literally just returns the object you pass it. No defaults, no validation, no merging. The `ThenConfig` interface has interesting options (pages.dir, api.dir, api.defaultKind) but nothing in the build pipeline actually reads most of them -- the directories are hardcoded to `src/api` and `src/pages` in `packages/core/src/manifest.ts` lines 218-219.

### 4. No README, No API Docs, No Website

The `https://thenjs.dev/docs/deploy` URL referenced in the deploy command does not exist. There is no README in any package. There are no JSDoc examples on the exported types. The only way to learn this framework is to read the source code and examples.

### 5. `then deploy` Does Nothing

`packages/cli/src/commands/deploy.ts` is a 29-line file that just prints a message. It does not deploy anything. It tells you to sign up for Celsian (which does not exist) or use wrangler/SAM directly. This command should either work or not exist.

### 6. The Rust Compiler is Not Built

`packages/compiler-native/index.js` tries to load a platform-specific `.node` binary that does not exist. The JS fallback (`packages/compiler/src/index.ts`) works fine, but the native compiler is listed as a feature. If I tried to use `@celsian/then-compiler-native`, I would get:

```
Error: @celsian/then-compiler-native: No native addon found for darwin-arm64.
```

No binaries are included in the repo, and there is no `Cargo.toml` or build script to compile it from source.

### 7. `class` vs `className` in JSX

The example pages use `class` attribute directly (e.g., `<div class="home">` in `examples/full-stack/src/pages/index.tsx` line 18). This works because What Framework supports `class` natively (not React), but the scaffolder's tsconfig sets `jsxImportSource: "what-framework"` without mentioning this difference. A junior dev coming from React will be confused about whether to use `class` or `className`. The built-in renderer in `static-render.ts` maps `className` to `class` (line 221), so both work -- but this is never documented.

## Bugs & Issues Found

### Bug 1: Task Example Uses Wrong Handler Signature
**File:** `examples/backend-only/src/api/tasks/process.ts` (line 11)
**Issue:** Handler expects `(req, reply)` but the task runner calls it with `(job)` -- a single-argument object with `{ taskId, input, attempt }`.
**Impact:** The task example would crash at runtime when invoked through `/__tasks/`.

### Bug 2: Concurrency Setting is Declared But Ignored
**File:** `packages/core/src/tasks.ts` (line 156-158)
**Issue:** The `concurrency` config option is read (`const concurrency = def.config.concurrency ?? 1`) but never actually enforced. The comment even admits it: "For simplicity, we count all in-flight -- a proper impl would track per-task."
**Impact:** Setting `concurrency: 5` does nothing.

### Bug 3: Server Entry Import Paths May Break
**File:** `packages/core/src/build.ts` (lines 505-506)
**Issue:** The import path generation uses `relative('dist/server', join(projectRoot, route.filePath))` which produces paths like `../../src/api/hello.ts` then replaces `.ts` with `.js`. But the source `.ts` files are not compiled to `.js` at those locations -- esbuild only bundles server-mode pages. API route source files remain as `.ts`. The generated server entry imports from paths that do not exist.
**Impact:** The generated `dist/server/entry.js` will fail to start unless there is a separate compilation step that is not shown.

### Bug 4: ISR Cache Has No Size Limit
**File:** `packages/core/src/build.ts` (lines 170-184)
**Issue:** The ISR (Incremental Static Regeneration) cache is a plain `Map()` with no eviction policy. On a long-running server with many unique URLs, this will leak memory indefinitely.
**Impact:** Memory leak in production for server-mode pages with `revalidate` set.

### Bug 5: Cron Timer Starts Unconditionally
**File:** `packages/core/src/build.ts` (line 276)
**Issue:** The generated server code has `if (_cronJobs.length > 0) setInterval(checkCron, 60000);` but this runs at module evaluation time, before any cron jobs are registered. The `registerCron()` calls come after this line in the generated code (lines 575-581), so `_cronJobs` is always empty when the `if` check runs.
**Impact:** Cron jobs will never fire in the generated server entry.

## Suggestions

1. **Write a README.** Convert the good parts of `PLAN.md` into a proper README with install instructions, a quick start guide, and links to examples.

2. **Fix the task handler API.** Pick one: either tasks use `(req, reply)` like regular routes, or they use `(job)` like the task runner expects. Update the example and docs to match.

3. **Extract the SSR renderer into a shared module.** One implementation, imported everywhere. Stop copy-pasting.

4. **Make `defineConfig` actually do something.** Merge with defaults, validate the config, use `pages.dir` and `api.dir` in the manifest scanner instead of hardcoding paths.

5. **Remove or stub `then deploy` properly.** Either implement it or make the command print "not yet implemented" instead of pretending Celsian exists.

6. **Remove the hardcoded file path** in `package.json`. Use a workspace protocol or published package instead of `file:/Users/macbookpro-kirby/...`.

7. **Add a "page modes" guide** to help devs pick between static/server/client/hybrid. The PLAN.md table is good but it needs real-world guidance (e.g., "use server mode when you need auth-gated content").

8. **Fix the cron registration order** in the generated server entry so `setInterval` runs after `registerCron()` calls.

## Score: 4/10

The architecture is sound and the conventions are well-chosen. The API route pattern, page modes, and task system show real design thought. 132 passing tests is solid for an early project.

But I cannot ship with this today. The lack of documentation means I would spend hours reading source code to figure out basic patterns. The task API inconsistency is a real bug. The deploy story is nonexistent. The hardcoded local paths mean I cannot even clone and install the repo. The SSR renderer duplication signals that refactoring has not kept up with feature development.

This is a promising foundation that needs polish before it is usable by anyone who did not write it. I would revisit after a README exists, the task API is unified, and `create-then` actually works end-to-end.
