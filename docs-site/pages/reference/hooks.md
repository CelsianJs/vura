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

Runs **before** the route handler, on every request. Modify the request, attach state, or authenticate. Return a `Response` to short-circuit (the handler never runs); `throw` to jump to `onError`.

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

- **Global first, in array order.** Within each phase, hooks fire in the order they appear in the exported array.
- Hooks run on the **unified server** — both `vura dev` and the built `dist/server/entry.js`. They wrap every `/api/*` request.

> **Serverless caveat.** Global hooks run on persistent-host deploys (Node/VPS, Docker, Fly, Railway). On per-function serverless targets (Cloudflare Workers, AWS Lambda) each route is bundled as its own function that calls the handler directly, so the global hooks file is **not** applied there. Put auth and logging that must run everywhere into the handler itself, or deploy to a persistent host. See [Adapters](/reference/adapters).

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
