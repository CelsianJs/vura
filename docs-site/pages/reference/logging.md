# Logging

Vura ships a structured logger from `@celsian/vura-core`. It writes JSON in production and colorized, human-readable lines in development, carries per-request IDs, and is configurable by environment variable or in code.

```ts
import { getLogger } from '@celsian/vura-core';

const log = getLogger();
log.info('server started', { port: 3000 });
log.error('payment failed', { orderId: 'o_42', code: 'CARD_DECLINED' });
```

Every log call takes a message and an optional data object. The data is merged into the structured entry — in JSON mode it becomes top-level fields; in pretty mode it's appended inline.

The logger runs on every target Vura builds for. It imports nothing, takes its request IDs from Web Crypto and writes to `process.stdout` where there is one and `console.log` where there is not, so `getLogger()` works the same in a hot route, a Lambda function and a Cloudflare Worker. On a Worker its output is what `wrangler tail` shows.

---

## Levels

```ts
log.debug(msg, data?);
log.info(msg, data?);
log.warn(msg, data?);
log.error(msg, data?);
```

Levels are ordered `debug < info < warn < error`. The logger drops anything below its minimum level (default `info`, so `debug` is hidden until you lower it).

---

## Configuration

Set the level and format with environment variables — no code change needed:

| Variable | Values | Default |
|---|---|---|
| `THEN_LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` | `info` |
| `THEN_LOG_FORMAT` | `json` \| `pretty` | `json` in production (`NODE_ENV=production`), otherwise `pretty` |

Or configure a logger in code with `createLogger()`:

```ts
import { createLogger } from '@celsian/vura-core';

const log = createLogger({
  level: 'debug',
  format: 'json',
  write: (line) => process.stderr.write(line), // custom sink
});
```

`LoggerConfig`:

| Option | Type | Default | Effect |
|---|---|---|---|
| `level` | `LogLevel` | `'info'` (or `THEN_LOG_LEVEL`) | Minimum level to emit. |
| `format` | `'json'` \| `'pretty'` | auto | Output format. |
| `write` | `(output: string) => void` | `process.stdout.write` | Where log lines go. |

---

## Request tracing

Attach a request ID to a group of related log lines with a **child logger**. Everything logged through it carries the same `requestId`:

```ts
const log = getLogger();
const requestId = log.generateRequestId(); // crypto.randomUUID()
const reqLog = log.child(requestId);

reqLog.info('handling request');   // { ..., requestId }
reqLog.error('validation failed'); // same requestId
```

For request start/end timing, `requestStart` / `requestEnd` bookend a request and log its duration and status:

```ts
const ctx = log.requestStart('GET', '/api/orders'); // logs "request start"
// ... handle the request ...
log.requestEnd(ctx, 200);                            // logs "request end" with durationMs
```

`requestEnd` picks the level from the status code: `info` for `< 400`, `warn` for `4xx`, `error` for `5xx`.

---

## API

| Function | Returns / Effect |
|---|---|
| `getLogger()` | The shared default logger (created lazily from env config on first call). |
| `createLogger(config?)` | A new independent `Logger`. |
| `setDefaultLogger(logger)` | Replace the shared default logger — useful in tests or custom setups. |
| `logger.child(requestId)` | A `ChildLogger` that stamps `requestId` on every entry. |
| `logger.generateRequestId()` | A fresh UUID. |
| `logger.requestStart(method, path, requestId?)` | Log a request start; returns a context for `requestEnd`. |
| `logger.requestEnd(ctx, statusCode)` | Log request completion with `durationMs` and `status`. |
