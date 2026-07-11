# Error handling

Throw a structured error from any handler and Vura turns it into a clean JSON response — with the right status code, a stable error code, and details that are safe in production. `@celsian/vura-core` gives you the `HttpError` class, a set of factory helpers, and dev/production formatting.

```ts
// src/api/orders/[id].ts
import { notFound } from '@celsian/vura-core';

export async function GET(req: any) {
  const order = await db.orders.find(req.params.id);
  if (!order) throw notFound('Order not found');
  return order;
}
```

The thrown error becomes:

```json
{ "error": "Order not found", "code": "NOT_FOUND" }
```

with a `404` status.

---

## `HttpError`

The core error type. Throw it directly, or use a [factory](#factory-helpers) for the common cases.

```ts
new HttpError(statusCode: number, code: string, message: string, details?: unknown)
```

```ts
import { HttpError } from '@celsian/vura-core';

throw new HttpError(409, 'CONFLICT', 'Email already registered', { email });
```

| Property | Type | Description |
|---|---|---|
| `statusCode` | `number` | HTTP status sent to the client. |
| `code` | `string` | Stable machine-readable code (see [`ErrorCode`](#error-codes)). Any string is allowed. |
| `message` | `string` | Human-readable message. |
| `details` | `unknown` | Optional structured context. Surfaced only in development (see below). |

---

## Factory helpers

Shorthands for the common statuses — each returns an `HttpError` you `throw`:

```ts
import { badRequest, unauthorized, forbidden, notFound } from '@celsian/vura-core';

throw badRequest('Missing "email" field');
throw unauthorized();
throw forbidden('Not your resource');
```

| Helper | Status | Code |
|---|---|---|
| `badRequest(message?, details?)` | 400 | `BAD_REQUEST` |
| `unauthorized(message?, details?)` | 401 | `UNAUTHORIZED` |
| `forbidden(message?, details?)` | 403 | `FORBIDDEN` |
| `notFound(message?, details?)` | 404 | `NOT_FOUND` |
| `methodNotAllowed(message?, details?)` | 405 | `METHOD_NOT_ALLOWED` |
| `conflict(message?, details?)` | 409 | `CONFLICT` |
| `rateLimited(message?, details?)` | 429 | `RATE_LIMITED` |
| `internalError(message?, details?)` | 500 | `INTERNAL_ERROR` |
| `serviceUnavailable(message?, details?)` | 503 | `SERVICE_UNAVAILABLE` |

Every argument is optional — `unauthorized()` defaults to the message `'Unauthorized'`.

---

## Dev vs. production responses

Error bodies are **sanitized in production** so you never leak internals. The mode comes from `NODE_ENV` (`production` → production mode, anything else → development).

**Development** — full detail for debugging:

```json
{
  "error": "Database connection refused",
  "code": "INTERNAL_ERROR",
  "statusCode": 500,
  "details": { "host": "db.internal" },
  "stack": "Error: Database connection refused\n    at ..."
}
```

**Production** — `5xx` messages are replaced with a generic string; no `details`, no `stack`:

```json
{ "error": "Internal Server Error", "code": "INTERNAL_ERROR" }
```

`4xx` errors keep their message in both modes — they're client-facing by design (a `404` message is meant to be read). Only `5xx` messages are masked in production, since those can carry internal detail.

---

## Error codes

`ErrorCode` is a map of predefined codes you can reference instead of typing string literals. The set spans request errors (`VALIDATION_ERROR`, `BAD_REQUEST`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `METHOD_NOT_ALLOWED`, `CONFLICT`, `RATE_LIMITED`, `PAYLOAD_TOO_LARGE`), server errors (`INTERNAL_ERROR`, `NOT_IMPLEMENTED`, `BAD_GATEWAY`, `SERVICE_UNAVAILABLE`, `TIMEOUT`), and framework errors (`RENDER_ERROR`, `HANDLER_ERROR`, `HOOK_ERROR`, `CONFIG_ERROR`). Codes are extensible — any string works as a `code`.

```ts
import { HttpError, ErrorCode } from '@celsian/vura-core';

throw new HttpError(413, ErrorCode.PAYLOAD_TOO_LARGE, 'File exceeds 10 MB');
```

---

## Reporting to an error service

To forward uncaught errors to Sentry or similar, register a global error handler. It runs **in addition to** the normal error response — it doesn't replace it.

```ts
import { setGlobalErrorHandler, reportError, getLogger } from '@celsian/vura-core';

setGlobalErrorHandler((error, context) => {
  Sentry.captureException(error, { extra: context });
});
```

`reportError(error, context?, logger?)` logs an error and invokes the registered handler (a no-op if none is set). It's what an [`onError` hook](/reference/hooks) typically calls:

```ts
// src/api/_hooks.ts
export const onError = [
  (error, req) => reportError(error, { path: req.url }, getLogger()),
];
```

---

## Utilities

| Function | Purpose |
|---|---|
| `formatErrorResponse(error, mode?)` | Turn any `Error` into `{ statusCode, body }`, applying dev/prod rules. |
| `sendErrorResponse(reply, error, mode?)` | Format and send the error through a `reply`. |
| `getErrorMode()` | `'development'` or `'production'`, from `NODE_ENV`. |
| `renderErrorPage(error, options?)` | Render an HTML error page (dev shows the stack; prod shows a generic page). Accepts a `customHandler` that can return HTML or `null` to fall back. |
| `setGlobalErrorHandler(fn)` / `getGlobalErrorHandler()` | Set / read the global reporting handler. |
| `reportError(error, context?, logger?)` | Log and forward an error to the global handler. |
