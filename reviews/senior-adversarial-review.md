# Senior Engineer Review -- Adversarial Analysis

**Reviewer:** Senior Engineer (Adversarial Review #2)
**Date:** 2026-03-12
**Scope:** `@then/core`, `@then/cli`, `@then/vite-plugin`, `@then/adapter-cloudflare`, `@then/adapter-lambda`
**Method:** Line-by-line analysis of all key source files, focused on what breaks under pressure

---

## Security Audit

### SEC-1. Unbounded Body Parsing -- Denial of Service (Critical)

Every body parser in the codebase accumulates request data into a string with zero size limits. An attacker can send a multi-gigabyte POST body and OOM the server.

**Files affected:**
- `packages/core/src/build.ts` lines 86-104 (generated `PARSE_BODY_CODE`)
- `packages/cli/src/commands/dev.ts` lines 417-431 (`parseNodeBody`)
- `packages/vite-plugin/src/index.ts` lines 415-437 (`readBody`)

All follow the same pattern:
```js
let data = '';
req.on('data', (chunk) => { data += chunk.toString(); });
```

No `Content-Length` check, no maximum buffer size, no streaming limit. A single request with `Content-Type: application/json` and an infinite body will crash the process.

### SEC-2. Prototype Pollution Surface via Form Body Parsing (High)

`packages/core/src/build.ts` line 97 (generated PARSE_BODY_CODE), and equivalent in `vite-plugin/src/index.ts` line 429:

```js
resolve(Object.fromEntries(new URLSearchParams(data)));
```

The resulting object is passed directly to user handlers as `req.parsedBody`. If a handler does `Object.assign(config, req.parsedBody)` or `{ ...defaults, ...req.parsedBody }`, keys like `__proto__`, `constructor`, or `toString` can cause prototype pollution or surprising behavior. The framework provides no sanitization layer.

### SEC-3. XSS in Dev Error Pages (Medium)

`packages/cli/src/commands/dev.ts` line 284:
```ts
res.end(`<h1>500 -- Server Error</h1><pre>${err.message}</pre>`);
```

`packages/vite-plugin/src/index.ts` line 283:
```ts
res.end(`<h1>500 -- Server Error</h1><pre>${err.stack}</pre>`);
```

Error messages can be user-controlled. A malformed JSON body triggers a parse error whose message may contain the original input. A route parameter value can appear in error messages. Neither `err.message` nor `err.stack` is escaped before HTML injection.

### SEC-4. Stack Trace Leakage to Clients (Medium)

`packages/vite-plugin/src/index.ts` lines 216-220:
```ts
res.end(JSON.stringify({
  error: 'Internal Server Error',
  message: err.message,
  stack: err.stack,
}));
```

Full stack traces with internal file paths and dependency versions are sent to any client that triggers a 500 error. Even in a "dev" plugin, this runs on whatever server Vite is configured on, which could be network-accessible.

### SEC-5. Path Traversal via Decoded Route Parameters (Medium)

`packages/core/src/build.ts` line 46 and `packages/core/src/match.ts` line 96:
```js
params[name] = decodeURIComponent(match[idx + 1]);
```

A request to `/api/files/..%2F..%2Fetc%2Fpasswd` with a `:filename` param decodes to `../../etc/passwd`. The framework hands decoded params directly to handlers with no validation. Any handler that uses a param in a file path is vulnerable.

### SEC-6. No Authentication on Task Management Endpoints (Medium)

`packages/core/src/build.ts` lines 297-330 (generated server code):

`GET /__tasks` exposes all registered tasks. `POST /__tasks/:name` allows anyone to enqueue arbitrary tasks with arbitrary input. `GET /__tasks/:id` exposes task results including potentially sensitive return data. No auth, no rate limiting, no IP restriction.

### SEC-7. TOML/YAML Injection in Generated Config Files (Low)

`packages/adapter-cloudflare/src/index.ts` line 82:
```ts
lines.push(`name = "${options.name}"`);
```

If `options.name` contains `"`, `\n`, or TOML special characters, the generated `wrangler.toml` is corrupted. Similarly, route URL patterns are interpolated into generated JavaScript (build.ts lines 521-523) without validation -- a malicious filename could inject code into the generated server entry.

### SEC-8. Raw HTML Injection via `opts.head` (Medium)

`packages/core/src/build.ts` line 164 and `packages/core/src/static-render.ts` line 142:

The `head` field from page config is inserted directly into `<head>` without escaping. If `head` comes from user-controlled data via `getServerData()`, it is a direct XSS vector.

### SEC-9. CORS Wide Open in Lambda SAM Template (Low)

`packages/adapter-lambda/src/index.ts` lines 262-268:
```yaml
CorsConfiguration:
  AllowOrigins: ["*"]
  AllowMethods: ["*"]
  AllowHeaders: ["*"]
```

Not configurable. Every deployed API gets full CORS open to all origins. Any API using cookies or auth tokens is vulnerable to cross-origin attacks.

---

## Race Conditions & Concurrency

### RACE-1. ISR Thundering Herd -- No Revalidation Deduplication (High)

`packages/core/src/build.ts` lines 400-403 (generated ISR code):

```js
if (cached.stale) {
  renderPage(page, params, url).then(html => isrSet(url.pathname, html, revalidateMs)).catch(() => {});
}
```

When a cached page goes stale, EVERY concurrent request triggers a separate background re-render. 1000 concurrent requests = 1000 calls to `getServerData()` = 1000 database queries. The `.catch(() => {})` silently swallows all errors, so you won't know your DB is being hammered until it falls over.

No deduplication flag, no in-flight tracking, no coalescing.

### RACE-2. Inline `processQueue` Has No Concurrency Guard (High)

`packages/core/src/build.ts` lines 203-232 (generated TASK_RUNNER_CODE):

```js
async function processQueue() {
  while (_taskQueue.length > 0) {
    const job = _taskQueue.shift();
    // ...await handler...
  }
}
```

Unlike the `TaskRunner` class in `tasks.ts` which has a `this.processing` guard, the inline generated version has **none**. Two rapid calls to `enqueueTask()` will call `processQueue()` twice. Both will enter the while loop and both will `.shift()` from the same queue. In the JS event loop, the first `processQueue` will `await` the handler, yielding control. The second `processQueue` will then `.shift()` the next job and start processing it concurrently. Two jobs run simultaneously with no concurrency control, defeating the purpose of a sequential queue.

### RACE-3. TaskRunner Retry Can Drop Jobs (Medium)

`packages/core/src/tasks.ts` lines 185-188:

```ts
setTimeout(() => {
  this.queue.push(job);
  this.processQueue();
}, backoff);
```

If the main `processQueue` loop finishes and sets `this.processing = false` before the `setTimeout` fires, the retry correctly re-enters `processQueue`. But if two retries fire in rapid succession, the second call to `processQueue` returns immediately because `this.processing` is already `true` from the first. The second retried job is pushed to the queue and will be picked up by the first call's while loop -- but ONLY if the first call's handler hasn't finished yet and the loop hasn't already checked `this.queue.length`. If timing is unlucky, the retried job sits in the queue with nobody processing it until the next `enqueue` call.

### RACE-4. Manifest Re-scan Race in Dev Server (Medium)

`packages/cli/src/commands/dev.ts` lines 302-307:

```ts
watch(dir, { recursive: true }, async (event, filename) => {
  manifest = await rescan(opts.projectRoot);
});
```

`manifest` is reassigned without locking. A request mid-flight can read a partially-consistent manifest if the watcher fires during request processing. Multiple rapid file saves stack up concurrent `buildManifest()` calls, each overwriting the result. The last write wins, but intermediate states may have been served.

---

## Code Generation Correctness

### GEN-1. Generated Import Paths Point to Source Files, Not Compiled Output (Critical)

`packages/core/src/build.ts` line 505:
```ts
const importPath = `./${relative('dist/server', join(projectRoot, route.filePath))}`.replace(/\.ts$/, '.js');
```

This computes a relative path FROM `dist/server` TO the source file (e.g., `../../src/api/users.js`). But at runtime, `src/api/users.js` does not exist -- only the `.ts` source file exists. The generated server entry imports from paths that do not resolve unless the user has an independent compilation step that mirrors the source tree.

The page imports (line 512) correctly point into `dist/server/pages/` because the build command compiles them there. But API route imports are broken.

### GEN-2. Cron `setInterval` Runs Before `registerCron` -- Cron Never Fires (High)

`packages/core/src/build.ts` line 276 (TASK_RUNNER_CODE):
```js
if (_cronJobs.length > 0) setInterval(checkCron, 60000);
```

This line is in the `TASK_RUNNER_CODE` constant, which is emitted into the generated file BEFORE the `registerCron()` calls (lines 575-581). At module evaluation time, `_cronJobs` is empty, so the `if` check fails and the interval never starts. Cron-scheduled tasks silently never execute in production.

### GEN-3. Route-to-Variable Name Collisions (Medium)

`packages/core/src/build.ts` lines 799-811:

```ts
function routeToVarName(route: ApiRoute): string {
  return 'route_' + route.urlPattern
    .replace(/^\//, '')
    .replace(/[/:*\-]/g, '_')
    .replace(/_+/g, '_');
}
```

Routes `/api/users-list` and `/api/users/list` both produce `route_api_users_list`. The generated code will have two `import * as route_api_users_list` statements -- a syntax error, or on some bundlers, silent shadowing where only the second import is used.

### GEN-4. Windows Path Separators in Generated Imports (Medium)

`packages/core/src/build.ts` line 505 and `packages/adapter-cloudflare/src/index.ts` line 168:

`path.relative()` on Windows produces backslash separators. The generated import `import * as x from '..\..\src\api\users.js'` is not valid ESM. No `.replace(/\\/g, '/')` is applied.

### GEN-5. `.replace(/\.ts$/, '.js')` Misses `.tsx`, `.mts`, `.cts` Extensions (Low)

`packages/core/src/build.ts` lines 505, 512, 597, 660:

Files with `.tsx` extensions (common for page components) will not have their extensions corrected, producing `import * as page_index from './pages/index.tsx'` which won't resolve at runtime.

### GEN-6. Inline Cron Matcher is Less Capable Than Library Version (Medium)

`packages/core/src/build.ts` lines 250-253 (inline TASK_RUNNER_CODE) vs `packages/core/src/tasks.ts` lines 285-299:

The inline version:
```js
if (field.includes('/')) {
  const [, step] = field.split('/');
  return value % parseInt(step, 10) === 0;
}
```

This ignores the range part of `1-30/5`, treating it as `*/5`. The library `cronFieldMatches` correctly handles `range/step` combinations. A cron expression like `1-30/5` would match values 0, 5, 10... in production but 1, 6, 11, 16, 21, 26 in the library version.

### GEN-7. Six Copies of the Route Matcher, Five of renderToString (Architectural)

The route matching regex builder is duplicated in:
1. `MATCH_ROUTE_CODE` (build.ts line 22)
2. `MATCH_PAGE_ROUTE_CODE` (build.ts line 54)
3. `generateWorkerEntry` (adapter-cloudflare/src/index.ts line 182)
4. `matchPageRoute` (vite-plugin/src/index.ts line 293)
5. `matchDevPageRoute` (cli/src/commands/dev.ts line 325)
6. `compilePattern` (core/src/match.ts line 26)

The SSR renderer is duplicated five times with subtle differences (e.g., `dev.ts` `devRenderAttrs` does NOT handle `style` objects, while `static-render.ts` `renderAttributes` does). Components with inline styles will render differently in dev vs production vs static build.

---

## Error Handling & Failure Modes

### ERR-1. No `req.on('error')` in Generated Body Parser (High)

`packages/core/src/build.ts` lines 86-104 (PARSE_BODY_CODE):

The generated body parser listens for `data` and `end` but NOT `error`. If the client disconnects mid-upload, the promise never resolves. The request handler hangs indefinitely, leaking the connection. The vite-plugin version correctly handles `error` (line 435), but the production generated code does not.

### ERR-2. `decodeURIComponent` Throws on Malformed URIs (High)

`packages/core/src/build.ts` line 46, `packages/core/src/match.ts` line 96:

```js
params[name] = decodeURIComponent(match[idx + 1]);
```

`decodeURIComponent('%E0%A4%A')` (truncated UTF-8) throws `URIError: URI malformed`. This uncaught exception in the route matcher will crash the request handler. In the generated server code, the outer try/catch at line 373 catches it and returns 500, but in `match.ts` (used by dev server and vite plugin), the exception propagates to the caller.

### ERR-3. Silent `getServerData` Failures (Medium)

`packages/core/src/build.ts` lines 465-471 (generated RENDER_PAGE_CODE):

If `getServerData()` throws, the error bubbles up to the page render try/catch which returns `<h1>500 -- Internal Server Error</h1>`. No structured error info, no error boundary, no fallback rendering. In production with no console access, debugging requires reproducing the exact request.

### ERR-4. Silent JSON Parse Failures (Medium)

`packages/core/src/build.ts` line 95:
```js
try { resolve(JSON.parse(data)); } catch { resolve(null); }
```

Malformed JSON silently resolves to `null`. The handler cannot distinguish between "no body" and "invalid JSON." A client sending garbage JSON gets no error -- the handler proceeds with `parsedBody: null`.

### ERR-5. ISR Re-render Errors Silently Swallowed (Medium)

`packages/core/src/build.ts` line 402:
```js
renderPage(page, params, url).then(html => isrSet(...)).catch(() => {});
```

`.catch(() => {})` swallows all errors. If `getServerData` starts failing (DB down, API key expired), stale content is served indefinitely with zero logging. The operator has no signal that revalidation is broken.

---

## Memory Safety & Resource Leaks

### MEM-1. ISR Cache Grows Without Bound (Critical)

`packages/core/src/build.ts` lines 170-184:

```js
const _isrCache = new Map();
```

No eviction policy, no maximum size, no LRU. With dynamic routes like `/blog/:slug`, an attacker requesting `/blog/a`, `/blog/b`, ... `/blog/zzzzz` fills memory with cached HTML strings. Each entry holds a full rendered HTML document.

### MEM-2. Task Results Map Grows Without Bound (Critical)

`packages/core/src/build.ts` line 192 and `packages/core/src/tasks.ts` line 98:

Every task result is stored forever. A cron task running every 5 minutes accumulates 105,120 entries per year, each holding the full job object including `result` payloads.

### MEM-3. Timeout Timer Leak Creates Unhandled Rejections (Medium)

`packages/core/src/tasks.ts` lines 167-172 and `packages/core/src/build.ts` lines 218-221:

```ts
const result = await Promise.race([
  def.handler({ taskId: job.id, input: job.input, attempt: job.attempt }),
  new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Task timeout')), timeoutMs)
  ),
]);
```

When the handler resolves before the timeout, `setTimeout` continues running. When it fires, it creates a rejected promise with no handler, triggering `unhandledRejection`. In Node.js with `--unhandled-rejections=throw` (default since v15), this crashes the process.

### MEM-4. Dev Server Temp Files Never Cleaned Up (Medium)

`packages/cli/src/commands/dev.ts` lines 128-131:

Every request writes a new `.mjs` file with a unique timestamp hash to `.then-dev-cache/`. These are never deleted. Same in `packages/cli/src/commands/build.ts` lines 139-161 (`.page-tmp` directory).

### MEM-5. `setInterval` for Cron Never Cleared on Shutdown (Low)

The generated server code has no `SIGTERM`/`SIGINT` handler. The `CronScheduler` class (tasks.ts line 236) has `stop()` but the generated inline version (build.ts line 276) stores no reference to the interval. On server shutdown, in-flight requests are dropped and pending tasks are lost.

---

## Architectural Concerns

### ARCH-1. "Streaming" SSR Is Not Streaming (High)

`packages/core/src/build.ts` lines 409-419:

```js
if (page.config.stream) {
  nodeRes.writeHead(200, { 'transfer-encoding': 'chunked' });
  const html = await renderPage(page, params, url);  // <-- fully renders first
  const headEnd = html.indexOf('</head>');
  nodeRes.write(html.slice(0, headEnd + 7));
  nodeRes.end(html.slice(headEnd + 7));
}
```

This fully renders the page into a string, then splits it at `</head>`. TTFB is identical to non-streaming. Real streaming SSR emits the head immediately and streams body chunks as components resolve. This is false advertising that will mislead users into thinking they have streaming SSR.

### ARCH-2. ISR is Process-Local (Medium)

The ISR cache is an in-memory `Map`. In any multi-process or multi-instance deployment (Fly.io, Railway, Kubernetes), each instance has its own cache. Cache invalidation is instance-local. There is no shared cache layer and no way to invalidate across instances. Users deploying with 2+ instances will see inconsistent content.

### ARCH-3. Task System Cannot Survive a Restart (Medium)

The task queue, in-flight jobs, and results are all in-memory. A deploy/restart loses everything. No persistence, no dead-letter queue, no at-least-once delivery guarantee. The cron scheduler also loses track of what has already fired in the current minute.

### ARCH-4. No Request Timeout on Generated Server (Medium)

The generated HTTP server has no `server.timeout` or `server.requestTimeout`. Combined with unbounded body parsing (SEC-1), a single slow client can hold connections open indefinitely and exhaust server resources.

### ARCH-5. Route Regex Recompiled Per Request in Generated Code (Low)

`packages/core/src/build.ts` lines 43 and 74:
```js
const match = pathname.match(new RegExp('^' + regexStr + '$'));
```

The generated `matchRoute` and `matchPageRoute` build a new `RegExp` object for every route on every request. The runtime `match.ts` correctly pre-compiles regexes once. The generated code should do the same at startup.

### ARCH-6. `extractApiExports` Regex Fails on Nested Objects (Medium)

`packages/core/src/manifest.ts` lines 84-85:
```ts
const routeMatch = source.match(/export\s+const\s+route\s*=\s*\{([^}]+)\}/);
```

`[^}]+` stops at the first `}`. A route config like:
```ts
export const route = { kind: 'task', retry: { attempts: 3 }, timeout: 30000 };
```
will match `kind: 'task', retry: { attempts: 3` and miss `timeout`.

### ARCH-7. Fragment Rendering Broken with Symbol Type (Medium)

`packages/core/src/static-render.ts` lines 203-209:
```ts
if (!type && children) {
  // Fragment handling
}
```

If the JSX runtime uses `Fragment = Symbol.for('Fragment')` (as defined in `jsx-runtime.ts`), then `!type` is `false` for Symbols. Fragments render as empty strings. The check should be `if ((!type || type === Symbol.for('Fragment')) && children)`.

### ARCH-8. `cronToAWSCron` Day-of-Week Values Not Converted (Medium)

`packages/adapter-lambda/src/index.ts` lines 620-630:

Standard cron uses 0-6 for day-of-week (Sun=0). AWS EventBridge uses 1-7 (Sun=1). The conversion function does not adjust values. `0 0 * * 0` (Sunday in standard) becomes `0 0 ? * 0 *` in AWS, which is invalid (AWS range is 1-7). Scheduled tasks targeting specific days will silently fail to deploy or fire on the wrong day.

---

## Bugs Found

| # | File | Line(s) | Severity | Issue |
|---|------|---------|----------|-------|
| 1 | `core/src/build.ts` | 86-104 | Critical | No body size limit -- OOM via large POST |
| 2 | `core/src/build.ts` | 170-184 | Critical | ISR cache grows without bound -- OOM via unique URLs |
| 3 | `core/src/build.ts` | 192 | Critical | Task results map grows without bound -- memory leak |
| 4 | `core/src/build.ts` | 505 | Critical | Generated import paths point to source, not compiled output |
| 5 | `core/src/build.ts` | 276 | High | Cron `setInterval` check runs before `registerCron` -- cron never fires |
| 6 | `core/src/build.ts` | 203-232 | High | Inline `processQueue` has no concurrency guard -- double processing |
| 7 | `core/src/build.ts` | 395-404 | High | ISR thundering herd -- no revalidation deduplication |
| 8 | `core/src/build.ts` | 86-104 | High | No `req.on('error')` -- promise hangs on client disconnect |
| 9 | `core/src/build.ts` | 46 | High | `decodeURIComponent` throws URIError on malformed input |
| 10 | `core/src/build.ts` | 250-253 | Medium | Inline cron field matcher ignores range in `range/step` |
| 11 | `core/src/build.ts` | 799-811 | Medium | Route-to-variable name collisions for similar URLs |
| 12 | `core/src/build.ts` | 218-221 | Medium | Timeout timer leak causes unhandled rejection |
| 13 | `core/src/build.ts` | 402 | Medium | ISR re-render errors silently swallowed by `.catch(() => {})` |
| 14 | `core/src/build.ts` | 409-419 | Medium | "Streaming" SSR fully renders before sending -- not streaming |
| 15 | `core/src/manifest.ts` | 84-85 | Medium | Route config regex fails on nested objects |
| 16 | `core/src/tasks.ts` | 167-172 | Medium | Timer leak on `Promise.race` creates unhandled rejections |
| 17 | `core/src/static-render.ts` | 203-209 | Medium | Fragment (Symbol) rendering broken -- renders empty |
| 18 | `cli/src/commands/dev.ts` | 284 | Medium | XSS -- `err.message` unescaped in HTML error page |
| 19 | `cli/src/commands/dev.ts` | 128-131 | Medium | Temp files never cleaned up from `.then-dev-cache` |
| 20 | `vite-plugin/src/index.ts` | 216-220 | Medium | Stack trace leaked to client in JSON error response |
| 21 | `vite-plugin/src/index.ts` | 283 | Medium | XSS -- `err.stack` unescaped in HTML error page |
| 22 | `adapter-lambda/src/index.ts` | 620-630 | Medium | `cronToAWSCron` does not convert day-of-week 0-6 to 1-7 |
| 23 | `adapter-lambda/src/index.ts` | 262-268 | Low | CORS wide open, not configurable |
| 24 | Multiple files | Various | Arch | 6 copies of route matcher, 5 copies of renderToString |

---

## Verdict

**Score: 4.5 / 10**

The architecture is sound in concept. File-based routing with multi-target deployment adapters is a good idea. The adapter pattern is clean. The Lambda event/response conversion is thorough. Self-contained generated functions with no runtime dependencies is the right call for cold starts.

But this codebase has bugs that will cause real production incidents:

**Will not run correctly:** The generated cron timer never starts (#5). The generated import paths likely do not resolve (#4). Fragment rendering is broken (#17). The inline cron matcher gives different results than the library version (#10).

**Will crash under load:** Unbounded ISR cache (#2), unbounded task results (#3), and unbounded body parsing (#1) are OOM vulnerabilities. The ISR thundering herd (#7) will amplify database load proportional to concurrent users. The timeout timer leak (#12, #16) will crash Node.js processes with `--unhandled-rejections=throw`.

**Will be impossible to debug:** Six copies of the route matcher guarantee dev/prod divergence (#24). The `.catch(() => {})` on ISR re-renders (#13) silently swallows revalidation failures. Silent JSON parse failures (#ERR-4) mean malformed requests produce no error signal. Error messages leak to clients in dev (#18, #20, #21) but provide zero diagnostic info in production (#ERR-3).

The core problem is that this is a rapid prototype being positioned as production infrastructure. The inline code generation approach (building JavaScript as string arrays) makes every bug 6x harder to fix because the same logic is duplicated across generated server, generated worker, generated function, vite plugin, dev server, and the library module. A single shared route matcher and a single shared renderer, imported by all code paths, would cut the bug surface by 80%.

To ship this: (a) deduplicate the route matcher and renderer into importable modules, (b) add body size limits and request timeouts, (c) implement bounded LRU caches for ISR and task results, (d) fix the cron timer ordering, (e) fix `Promise.race` timer leaks, and (f) verify that generated import paths actually resolve.
