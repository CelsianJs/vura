# Terd's Review -- Mid-Level Developer Perspective

I spent a few hours reading through the ThenJS codebase trying to figure out if I could actually build and ship a real app with it. I've done a fair amount of Next.js and Express, and I've used BullMQ for background jobs before, so I have opinions about what production-ready looks like. Here's what I found.

## Architecture Assessment

The layered architecture makes sense on paper: What Framework (frontend) + CelsianJS (backend) + ThenJS (meta-framework). The file-based routing with explicit `kind` and `mode` declarations is actually cleaner than Next.js's magic. You know exactly what each route does just by reading the export.

The problem is that the layers are very loosely connected right now. The server entry is generated as a giant string of JavaScript (see `packages/core/src/build.ts`). There's no shared library -- the runtime code (route matching, body parsing, SSR rendering, ISR cache, task runner, cron scheduler) is all duplicated as string literals inlined into the generated output. This means:

1. The runtime code in the generated entry can silently drift from the actual `TaskRunner` class in `packages/core/src/tasks.ts`
2. The renderer in `build.ts` (RENDER_TO_STRING_CODE, line 108) is a different copy than the one in `vite-plugin/src/index.ts` (builtinRenderToString, line 342), which is different from the one in `static-render.ts` (builtinRenderToString, line 153), which is different from the one in `cli/src/commands/dev.ts` (devRenderToString, line 358). That's **four copies** of essentially the same renderer.

It works for a prototype, but it's the kind of thing that turns into nightmare debugging when one copy gets a fix and the others don't.

## Feature-by-Feature Analysis

### Server-Mode Pages

**Tracing a request for `/stats`:**

1. Request hits the generated server entry (`dist/server/entry.js`)
2. `matchRoute()` checks API routes first -- no match for `/stats`
3. Falls into the `method === 'GET'` block (line 254 of entry.js)
4. `matchPageRoute()` finds `/stats` in the `pageRoutes` array
5. Checks ISR cache via `isrGet()` -- miss on first request
6. Calls `renderPage()` which:
   - Loads `page.module` (the pre-bundled `page_stats` import)
   - Calls `mod.getServerData()` with `{ params, url, query }`
   - Calls `Component({ ...serverData, params })` to get a vnode
   - Calls `renderToString(vnode)` to get HTML
   - Wraps in `wrapDocument()` with title/meta/scripts
7. Stores in ISR cache with `revalidateMs = 60000`
8. Sends response

**What works:** The basic happy path works. I can see the built output at `dist/server/pages/stats.js` uses What Framework's `jsx()` function, and the inline `renderToString` in the entry handles vnodes with `{ type, props, children }` format. The bundled stats page actually exports vnodes with `{ tag, props, children }` format (What Framework style), and the inline renderer in the entry file only checks for `type`, not `tag`. But wait...

**Bug #1 -- renderToString mismatch with What Framework vnodes in production entry:**

In `packages/core/src/build.ts`, line 113, the inline RENDER_TO_STRING_CODE checks:
```
if (typeof vnode === 'function' && !vnode.type && !vnode.tag) return renderToString(vnode());
```
OK, that handles the function case with both `type` and `tag` checks. But then at line 103:
```
const { type, props = {}, children } = vnode;
```
It destructures `type` but not `tag`. Then line 117:
```
if (typeof type === 'function') ...
```
And line 118:
```
if (typeof type === 'string') ...
```

But the bundled What Framework pages produce vnodes with `tag` not `type`. Looking at `dist/server/pages/stats.js` line 11:
```
return { tag, props, children: flat, key, _vnode: true };
```

The generated entry.js at line 103 does `const { type, props = {}, children } = vnode;` -- `type` will be `undefined` because What Framework uses `tag`.

Wait, actually looking more carefully at the RENDER_TO_STRING_CODE at line 115:
```
const type = vnode.type || vnode.tag;
```

No. Looking at line 103 in the entry:
```
const { type, props = {}, children } = vnode;
```

This is a destructuring. It pulls `type` from the vnode object. What Framework vnodes have `tag`, not `type`. So `type` will be `undefined`.

BUT -- wait, looking at the actual generated entry.js at line 103:
```
const type = vnode.type || vnode.tag;
```

Hmm, let me re-read. The actual generated output at `dist/server/entry.js` line 103 says:
```
const { type, props = {}, children } = vnode;
```

No. Looking at the actual file I read: `dist/server/entry.js` line 97-121. I see:

```
function renderToString(vnode) {
  ...
  if (typeof vnode === 'function' && !vnode.type) return renderToString(vnode());
  ...
  const { type, props = {}, children } = vnode;
```

Line 101: `if (typeof vnode === 'function' && !vnode.type) return renderToString(vnode());`

This doesn't check `!vnode.tag` like the source code template does at line 113:
`if (typeof vnode === 'function' && !vnode.type && !vnode.tag) return renderToString(vnode());`

So the generated code at line 101 is DIFFERENT from the source template. The generated entry is from a previous build, before the `tag` support was added to RENDER_TO_STRING_CODE. This is exactly the "drift" problem I mentioned -- the generated entry is stale.

But let's focus on the actual source template going forward. In the RENDER_TO_STRING_CODE template in `build.ts`, line 115 says:
```
const type = vnode.type || vnode.tag;
```

Wait, no. Let me re-read carefully.

`build.ts` line 114-115:
```
'  if (Array.isArray(vnode)) return vnode.map(renderToString).join(\'\');',
'  const type = vnode.type || vnode.tag;',
```

OK! So the **source template** does do `vnode.type || vnode.tag`. Good. But the **generated** entry.js doesn't have this -- it was built from an older version of the template. This confirms the drift problem but means the current source is correct.

**Compared to Next.js:** The `getServerData()` API is very similar to `getServerSideProps`. The main difference is that Next.js returns `{ props }` and ThenJS returns the props directly. ThenJS is simpler. But Next.js handles errors (notFound, redirect) in the return value -- ThenJS has no equivalent.

### Task System

I traced the task system through three layers:

1. **The `TaskRunner` class** (`packages/core/src/tasks.ts`) -- a proper implementation with types
2. **The inline TASK_RUNNER_CODE** (`packages/core/src/build.ts`, line 188) -- a simplified copy as string literals
3. **The dev server task middleware** (`packages/vite-plugin/src/index.ts`, line 57) -- another implementation

**Bug #2 -- processQueue concurrency is broken in both implementations:**

In `tasks.ts` line 140-198, the `processQueue` method sets `this.processing = true` at the start and `false` at the end. If a task fails and gets retried via `setTimeout` (line 185-188), the callback calls `this.processQueue()`. But `processQueue` is `async` and the `while` loop is sequential. After the timeout fires and pushes the job back, `processQueue()` will be called but `this.processing` is still `true` because the original call hasn't finished yet. The retried job just sits in the queue until a NEW job is enqueued.

Actually wait -- if the original loop finishes its `while` (queue empty), it sets `processing = false`. Then the setTimeout fires, pushes the job, and calls processQueue. That should work. But there's a race condition: if the setTimeout fires WHILE the original loop is still running (processing another job), the retry gets pushed to the queue, and the loop will pick it up in the next iteration. That seems fine actually.

No -- the real issue is: the while loop at line 145 checks `this.queue.length > 0`. The `await` on line 167-171 pauses. During that await, the setTimeout from a previous retry fires and pushes a job. When the await resolves, the while loop continues and processes the retried job. OK, this actually works.

BUT: the INLINE version in TASK_RUNNER_CODE (build.ts, line 203) does NOT have the `processing` guard. If `processQueue()` is called while already processing, you get a second concurrent loop draining the queue. Two concurrent workers pulling from the same queue without coordination = double-processing.

**Bug #3 -- Task timeout creates a memory leak:**

In `tasks.ts` line 169-171:
```
new Promise<never>((_, reject) =>
  setTimeout(() => reject(new Error(`Task timeout after ${timeoutMs}ms`)), timeoutMs)
),
```

The `Promise.race` resolves when the task completes, but the setTimeout is never cleared. If tasks complete quickly but have a 30-second timeout configured, you accumulate 30-second timers. Under load, this wastes memory and keeps the event loop busy. The same issue exists in the inline version.

**Bug #4 -- Task system has no persistence:**

The `MemoryQueue` (tasks.ts line 54) and the inline `_taskQueue` array (build.ts line 189) are both in-memory. If the server crashes or restarts:
- All pending jobs are lost
- All in-flight jobs are lost (no recovery)
- Job results are lost
- Cron schedule state is lost (may double-fire or skip)

This is documented as "in-memory queue" but there's no path to add persistence. No interface for a durable queue, no WAL, no checkpoint mechanism. For a production task system, this is a non-starter. Even something simple like writing to SQLite would be better.

**Bug #5 -- Cron scheduler can double-fire:**

In `tasks.ts` line 227-255, the CronScheduler checks every 60 seconds. The `tick()` method checks if the current minute matches. But if the tick happens at :00.01 and again at :00.59 (both within the same minute), the cron job fires twice. The scheduler doesn't track "last fired" timestamps per job.

Similarly, in the inline version (build.ts line 261-276), the `checkCron` function has the same issue.

**Bug #6 -- Task handler interface mismatch:**

The task route in `examples/backend-only/src/api/tasks/process.ts` exports a `POST(req, reply)` function that uses the standard CelsianJS req/reply pattern. But when the task system calls it, it passes `{ taskId, input, attempt }` (see build.ts inline TASK_RUNNER_CODE line 216-217). The task handler receives a completely different object shape than what the route exports.

Looking at the example handler:
```typescript
export async function POST(req: any, reply: any) {
  const body = req.parsedBody as { type?: string; payload?: any };
  ...
  return reply.status(202).json({ ... });
}
```

When called via `/__tasks/tasks.process`, the vite plugin calls it with `{ taskId, input, attempt }` (vite-plugin line 104). The handler would get `req = { taskId, input, attempt }`, try to read `req.parsedBody` (undefined), try to call `reply` (which is `undefined` because the task call doesn't pass a second argument), and crash.

### ISR Cache

**Bug #7 -- ISR cache has no eviction:**

In build.ts line 170-184, the `_isrCache` is a `Map` that grows forever. Every unique pathname gets cached, and entries are never removed. A page like `/blog/:slug` with thousands of slugs would accumulate thousands of cached HTML strings. In a long-running hot server, this is a memory leak.

**Bug #8 -- ISR stale-while-revalidate has a thundering herd problem:**

In build.ts (generated code, lines 395-404 in the server code generator):
```
if (cached.stale) {
  // Background re-render
  renderPage(page, params, url).then(html => isrSet(url.pathname, html, revalidateMs)).catch(() => {});
}
```

Every request that hits a stale cache entry triggers a background re-render. If 100 requests hit a stale page simultaneously, you get 100 concurrent re-renders. There's no deduplication -- no check for "is someone already re-rendering this page?"

Next.js solves this with a single-flight revalidation lock. ThenJS needs the same.

**Bug #9 -- ISR cache uses pathname as key but ignores query params:**

The cache key is `url.pathname` (build.ts line 397, 402). But `getServerData` receives query params:
```
query: Object.fromEntries(url.searchParams.entries()),
```

If a page returns different data for `/stats?region=us` vs `/stats?region=eu`, both requests cache under `/stats` and serve the wrong data.

### Adapters

#### Cloudflare Adapter

The Cloudflare adapter (`packages/adapter-cloudflare/src/index.ts`) is solid for basic deployments:
- Generates correct `wrangler.toml` with KV/D1/R2 bindings
- Cron triggers map correctly from task routes
- Worker entry handles the req/reply pattern properly
- `__cf_env` and `__cf_ctx` are passed through so handlers can access bindings

**Issue:** The adapter only handles `serverless` routes (line 334: `manifest.api.filter(r => r.kind === 'serverless')`). If you have `hot` routes, they're silently ignored. There's no warning that your WebSocket endpoint won't work in Workers.

**Issue:** Server-mode pages are completely ignored by the Cloudflare adapter. The `manifest.pages` array is never read. If you have a page with `mode: 'server'` and deploy to Cloudflare, it just won't exist.

**Issue:** The cron trigger config at line 144 uses the schedule string directly:
```
crons = ["*/5 * * * *", "0 9 * * 1"]
```
Cloudflare uses the same 5-field cron format as standard, so this should work. But the handler entry generated for Workers doesn't include any task execution logic -- the cron trigger fires the worker's `scheduled` event handler, which isn't defined. The generated worker entry only has a `fetch` handler (line 220).

**Bug #10 -- Cloudflare cron triggers have no scheduled handler:**

The wrangler.toml gets `[triggers] crons = [...]` but the generated worker entry only exports `fetch`. Cloudflare Workers need a `scheduled(event, env, ctx)` export to handle cron triggers. Without it, the cron fires and nothing happens. This is a silent failure -- no error, no execution.

#### Lambda Adapter

The Lambda adapter is more thorough:
- Generates SAM template with correct HttpApi + Lambda function resources
- EventBridge schedules for task routes use proper AWS cron format
- The `cronToAWSCron()` function (line 620) correctly handles the `?` requirement (AWS needs `?` for either dayOfMonth or dayOfWeek when the other is specified)
- Lambda handler files include proper event-to-request conversion

**Bug #11 -- Lambda handler imports from `'./route.js'` but no route.js is generated:**

In `adapter-lambda/src/index.ts` line 367:
```
import { ${imports} } from './route.js';
```

The `generateHandlerFile` function imports methods from `./route.js`, but the `buildEnd` method only writes `index.js` to the function directory (line 552). There's no step that copies or bundles the actual route source file as `route.js`. The Lambda function would fail at import time.

**Bug #12 -- Lambda task functions get EventBridge event but handler expects HTTP event:**

When EventBridge triggers a Lambda from a cron schedule, the event format is completely different from APIGatewayProxyEventV2. It looks like:
```json
{
  "version": "0",
  "source": "aws.events",
  "detail-type": "Scheduled Event",
  ...
}
```

But the generated handler file (line 456) calls `eventToRequest(event)` which expects `event.rawPath`, `event.requestContext.http.method`, etc. This would crash with a TypeError on every cron invocation.

## Bugs Found

| # | File | Line | Issue |
|---|------|------|-------|
| 1 | `packages/core/src/build.ts` | 108-134 | Generated renderToString may drift from source template (confirmed by comparing entry.js output to current template) |
| 2 | `packages/core/src/build.ts` | 188-232 | Inline processQueue lacks `processing` guard, allowing concurrent drain loops |
| 3 | `packages/core/src/tasks.ts` | 169-171 | setTimeout never cleared after Promise.race resolves, leaking timers |
| 4 | `packages/core/src/tasks.ts` | 54-91 | MemoryQueue has no persistence -- all state lost on crash |
| 5 | `packages/core/src/tasks.ts` | 227-255 | CronScheduler can double-fire within the same minute |
| 6 | `packages/core/src/build.ts` | 216-217 | Task handler called with `{taskId, input, attempt}` but route exports `POST(req, reply)` |
| 7 | `packages/core/src/build.ts` | 170-184 | ISR cache grows unbounded, no eviction strategy |
| 8 | `packages/core/src/build.ts` | 395-404 | ISR stale revalidation has thundering herd problem (no dedup) |
| 9 | `packages/core/src/build.ts` | 397 | ISR cache key ignores query parameters |
| 10 | `packages/adapter-cloudflare/src/index.ts` | 140-146, 220 | Cron triggers configured but no `scheduled` handler exported |
| 11 | `packages/adapter-lambda/src/index.ts` | 367 | Handler imports from `./route.js` which is never generated |
| 12 | `packages/adapter-lambda/src/index.ts` | 456 | Task Lambda receives EventBridge event, handler expects API Gateway event format |

### Additional Issues

- **Four copies of renderToString** across `build.ts` (inline), `static-render.ts`, `vite-plugin/src/index.ts`, and `cli/src/commands/dev.ts`. Each slightly different.
- **Four copies of matchPageRoute** across `build.ts` (inline), `vite-plugin/src/index.ts`, and `cli/src/commands/dev.ts`, plus the inline version in entry.js.
- **Config regex parser can't handle nested objects or arrays** (`packages/core/src/manifest.ts` line 84-104). `export const route = { kind: 'task', config: { retries: 3 } }` would fail because the regex stops at the first `}`.
- **Meta tag parsing is broken** for the index page. The manifest.json for the full-stack example shows the `meta` array's first entry's properties (`name`, `content`) merged directly into the page config instead of staying in the meta array. See `dist/manifest.json` lines 76-79.
- **TypeScript config loading silently fails** (`packages/cli/src/config-loader.ts` line 29-38). If you have `then.config.ts` (which the example does), it tries a bare `import()` which will fail without tsx or ts-node registered. It prints a warning and falls back to defaults. Your adapter config is silently ignored.

## Production Concerns

1. **No error boundaries.** If `getServerData()` throws, the entire request gets a generic 500 with no useful information in production. No retry logic, no fallback rendering, no partial failure handling.

2. **No request body size limits.** The `parseBody` functions (in build.ts inline, vite-plugin, dev.ts) accumulate the entire request body in memory as a string with `data += chunk.toString()`. A malicious 10GB POST body would exhaust server memory. Every copy of parseBody has this issue.

3. **No graceful shutdown.** The generated server entry starts an HTTP server but has no SIGTERM/SIGINT handler. In container environments (Docker, Fly.io, K8s), the process gets SIGTERM on deploy and immediately dies, dropping in-flight requests and losing all queued tasks.

4. **Streaming SSR is fake.** The "streaming" implementation (build.ts, line 408-420) awaits the full renderPage, then splits the completed HTML at `</head>` and sends it in two chunks. Real streaming SSR (like React's renderToPipeableStream) sends the shell immediately and streams in content as it resolves. This gives you zero TTFB benefit.

5. **No CORS handling in the server entry.** The generated entry.js has no CORS headers. The Lambda adapter's SAM template configures CORS at the API Gateway level, but the hot server has nothing. Cross-origin requests to API routes will fail in production.

6. **Dev server re-bundles every request.** In `cli/src/commands/dev.ts`, the standalone `loadHandler` function calls esbuild on every request (line 118-131). It writes a new file with a timestamp hash each time. No caching. For the Vite version this is handled by Vite's module graph, but for the standalone dev server, every API call triggers a full re-bundle.

7. **The `results` Map in TaskRunner grows forever.** Every job result is stored in `this.results` (tasks.ts line 98, 122) and never cleaned up. In a long-running server processing thousands of tasks, this is a memory leak.

## What I'd Build With This

**Today, honestly?** I'd use ThenJS for a simple app with:
- Static marketing pages (works well, clean output)
- A handful of serverless API routes for CRUD (works well)
- Hot server mode for a simple persistent API (works)

I would NOT use:
- Server-mode pages in production (ISR bugs, no error handling)
- The task system for anything important (no persistence, interface mismatch, crash = data loss)
- The Cloudflare adapter with cron (broken -- no scheduled handler)
- The Lambda adapter at all (broken imports, broken task events)
- Streaming SSR (it's not actually streaming)
- Hybrid/island pages (no island hydration runtime exists -- the `/@what/islands.js` script referenced in static-render.ts line 77 doesn't exist)

The core abstraction -- file-based routing with explicit `kind` and `mode` -- is genuinely good. The separation of serverless vs hot vs task is clearer than Next.js's "everything is a serverless function" approach. The generated server entry is a self-contained Node.js HTTP server with zero dependencies, which is great for deployment. The What Framework JSX integration with the fallback JSX runtime is clever.

The framework needs about 2-3 more months of work before I'd trust it for a real production app. The main gaps are:
1. Fix the adapter bugs (these are deployment-breaking)
2. Add a persistence layer for the task system (even SQLite)
3. Consolidate the duplicated runtime code into importable modules
4. Add ISR cache eviction and revalidation dedup
5. Add request body limits and graceful shutdown
6. Build the actual island hydration runtime

## Score: 4/10

The architecture and API design are a solid 7/10. The actual implementation that you'd ship to production is a 3/10. The average lands at 4. There are real, shipping-blocking bugs in both adapters, the task system interface is broken, and the ISR cache will cause memory issues in any long-running deployment. The core file-based routing, static page generation, and dev server work well though -- those parts are genuinely usable today.
