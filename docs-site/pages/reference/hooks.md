# Lifecycle hooks

Hooks run code around every API request: before the handler, when it errors, and after the response is sent. Use them for logging, metrics, and cross-cutting concerns you don't want to repeat in every route.

> Hooks run for **API routes only**. To guard a page, or to run something before every request whatever it hits, use [middleware](/reference/middleware).

Define global hooks in a **conventional hooks file** at the root of your `src/`:

```ts
// src/api/_hooks.ts
import { getLogger } from '@celsian/vura-core';

const log = getLogger();

export const onRequest = [
  (req, reply) => {
    (req as any).startedAt = Date.now();
  },
];

export const onResponse = [
  (req, reply, info) => {
    log.info('request', { path: req.url, status: info.statusCode, ms: info.durationMs });
  },
];
```

Vura discovers this file automatically — no registration, no import into your routes.

---

## The hooks file

Vura looks for the first of these files (relative to the project root):

```
src/api/_hooks.ts    src/api/_hooks.js    src/api/_hooks.mjs
src/hooks.ts         src/hooks.js         src/hooks.mjs
```

From it, Vura reads three optional exports — `onRequest`, `onError`, `onResponse`. **Each may be a single function or an array of functions.** Arrays run in order.

```ts
export const onRequest = singleFn;           // one hook
export const onRequest = [firstFn, secondFn]; // several, in order
```

---

## The three hooks

### `onRequest(req, reply)`

Runs **before** the route handler, on every request. Modify the request, attach state, or authenticate. Answer on the reply (`reply.json`, `reply.send`, `reply.redirect`) to short-circuit: the handler never runs, and neither does schema validation. `throw` to jump to `onError`.

```ts
export const onRequest = [
  (req, reply) => {
    if (!req.headers.get('authorization')) {
      return reply.status(401).json({ error: 'Unauthorized' });
    }
  },
];
```

[`cookieSession()`](/reference/auth) and `createJWTGuard()` are `onRequest` hooks — drop them into this array to add auth app-wide.

### `onError(error, req, reply)`

Runs when the handler or a prior hook **throws**. Inspect or transform the error and shape the response. If the error is an [`HttpError`](/reference/errors), its status code is used; otherwise the response is `500`.

```ts
import { reportError, getLogger } from '@celsian/vura-core';

export const onError = [
  (error, req, reply) => {
    reportError(error, { path: req.url }, getLogger()); // e.g. forward to Sentry
  },
];
```

### `onResponse(req, reply, info)`

Runs **after** the response is sent — for logging, metrics, and cleanup. It cannot change the response. Errors thrown here are logged and swallowed; they never reach the client.

It runs **once per request, whatever the outcome**. A request whose handler or hook threw runs `onError` and then `onResponse`, so an access log or a request counter written here sees the failures as well as the successes.

`info` is a `ResponseInfo`:

| Field | Type | Description |
|---|---|---|
| `statusCode` | `number` | The status code that was sent, including the status of an error response. |
| `durationMs` | `number` | Time from request start to response, in milliseconds. |
| `hadError` | `boolean` | `true` when the request was answered from the error path (the handler, or a hook before it, threw). `false` on the normal path. |

---

## Order and scope

- **Global first, then the route's own, in array order.** Within each phase, hooks fire in the order they appear in the exported array, and a route's own hooks run after the global ones.
- **`onRequest` runs before schema validation.** An auth hook decides before a schema does, so an unauthenticated caller gets your `401` rather than a report on a body it was never entitled to submit.
- Hooks run on **every deploy target**: `vura dev`, the built `dist/server/entry.js`, the generated `dist/functions/` output, and both serverless adapters (Cloudflare Workers and AWS Lambda). Each per-function bundle gets its own copy of the hooks file. They wrap every `/api/*` request.
- **Task routes are not wrapped.** A task is invoked by a scheduler, not over HTTP, so it never enters the request lifecycle. Guard a task inside the task.

> **One difference worth knowing.** `req.headers` answers `.get(name)` and `.has(name)` on every target, and index access (`req.headers['authorization']`) works everywhere too. `req.url` does not match: on the unified server and in `dist/functions/` it is the full URL, and on the two serverless adapters it is the path only. Read the path with `new URL(req.url, 'http://x').pathname` if a hook needs to work on all of them.

> **What a hooks file may import on serverless targets.** A Workers or Lambda function bundle carries no Node server runtime, and Workers carries no Node built-ins at all, so a hooks file is limited to the same imports a serverless route has. If it imports outside that set, **the build fails** with the file named. It is not skipped: a hooks file is where an app-wide authorization check lives, and dropping one quietly would ship a deploy whose auth layer is missing while the build reports success. Fix the import or move the code into the routes that need it. See [Adapters](/reference/adapters).

---

## Programmatic hooks API

For building a custom server or adapter, `@celsian/vura-core` also exports a standalone hook engine — `HookRegistry`, `createHookRegistry`, `getHookRegistry`, `setDefaultHookRegistry`, and `executeWithHooks`, plus the `OnRequestHook`, `OnErrorHook`, `OnResponseHook`, `ResponseInfo`, and `RouteHooks` types. These let you run the full request lifecycle yourself:

```ts
import { createHookRegistry, executeWithHooks } from '@celsian/vura-core';

const registry = createHookRegistry();
registry.onRequest((req, reply) => { /* ... */ });

const { statusCode, hadError, result } = await executeWithHooks(
  registry, req, reply, () => handler(req, reply),
);
```

This engine is independent of the conventional hooks file above — most apps use the file and never touch it.
