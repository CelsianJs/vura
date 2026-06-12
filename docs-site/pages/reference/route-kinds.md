# Route kinds

Every file in `src/api/` is one of three kinds. The kind determines where the route runs — which runtime, which lifecycle, and which deploy targets support it.

## Annotation

```ts
// shorthand — kind only
export const kind = 'hot';

// route object — kind + config fields
export const route = { kind: 'task', retries: 2, timeout: 60_000 };
```

When both `kind` and `route` are exported from the same file, **`route` wins**. Use the shorthand when you have no additional config.

---

## `serverless` (default)

Stateless, per-request. Runs inside the unified Node server (persistent hosts) or as an individual Lambda/Worker function (serverless adapters). No state persists between requests. No timeout beyond the adapter limit.

**Exports recognized:**

| Export | Description |
|---|---|
| `GET(req, reply)` | Handle HTTP GET |
| `POST(req, reply)` | Handle HTTP POST |
| `PUT(req, reply)` | Handle HTTP PUT |
| `DELETE(req, reply)` | Handle HTTP DELETE |
| `PATCH(req, reply)` | Handle HTTP PATCH |
| `HEAD(req, reply)` | Handle HTTP HEAD |
| `OPTIONS(req, reply)` | Handle HTTP OPTIONS |

Any subset of these. `req` is the Celsian request object; `reply` has `.json()`, `.text()`, `.html()`, `.status()`, `.redirect()`.

**Lifecycle:** request comes in → handler runs → response sent → handler scope is discarded.

---

## `hot`

Persistent process. The server holds a WebSocket open for each connection. In-memory state (sets, maps, objects) lives for the lifetime of the server process, not the request. There is no timeout.

**Exports recognized:**

| Export | Description |
|---|---|
| `websocket(peer, req)` | Called once per connection on open. |
| `GET / POST / ...` | Plain HTTP methods work alongside WebSocket on the same route file. |

**`websocket(peer, req)` contract:**

`peer` — `HotPeer`:
- `peer.id` — unique connection id (string)
- `peer.send(data)` — send string or ArrayBuffer; no-op after close
- `peer.close(code?, reason?)` — close this connection
- `peer.on('message' | 'close', cb)` — subscribe to events
- `peer.broadcast(data, excludeSelf = true)` — send to all peers on the same concrete URL path. Broadcast is path-keyed (e.g. `/api/rooms/7`), not pattern-keyed (`/api/rooms/:id`), so it delivers only to peers in the same "room".

`req` — `HotRequest`:
- `req.url` — full URL string of the upgrade request
- `req.headers` — `Headers` object from the upgrade request
- `req.query` — `URLSearchParams` from the upgrade URL
- `req.params` — path params extracted from the route pattern (e.g. `{ room: '7' }` for `/api/rooms/:room`)

**`route` config fields:**

| Field | Type | Default | Effect |
|---|---|---|---|
| `origins` | `string[]` | unset | Origin allowlist for the WebSocket handshake. When set, upgrade requests whose `Origin` header is not on the list are rejected with `403` before the handshake. Entries are compared as URL origins, case-insensitively (trailing slashes/paths/default ports are normalized away). Requests with **no** `Origin` header always pass — browsers always send one, and non-browser clients can forge any value anyway. **Default is open**: without `origins`, any site can open a WebSocket to this route — set it for any cookie-authenticated app. |

```ts
export const route = { kind: 'hot', origins: ['https://app.example.com'] };
```

**Known limitation — backpressure:** `peer.send()` is fire-and-forget with no bufferedAmount cap. A slow consumer can buffer unbounded data in the socket write queue. Implement your own flow-control in the message handler for high-throughput binary streams.

**Lifecycle:** server boots → per-connection `websocket(peer, req)` called on upgrade → `peer.on('message', ...)` fires per frame → `peer.on('close', ...)` fires on disconnect. State in module scope persists across all connections for the lifetime of the process.

---

## `task`

Off the request path. Not exposed as a regular HTTP endpoint — calls go through `/__tasks`. The handler is the `POST` export and receives a context object.

**Exports recognized:**

| Export | Description |
|---|---|
| `POST(ctx)` | Handler. `ctx.attempt` (1-based retry count), `ctx.input` (parsed JSON body or `{ _cron: true }` for scheduled runs). |
| `route` | Object with `kind: 'task'` plus optional `retries` (default 0) and `timeout` in ms (default 30 000). |
| `schedule` | Top-level cron expression sugar (standard five-field). Registers a cron trigger automatically on server start. Can be exported separately from `route`; does not need to be inside `route`. |

**`route` config fields:**

| Field | Type | Default | Effect |
|---|---|---|---|
| `retries` | `number` | `0` | Number of retry attempts after a failure. |
| `timeout` | `number` (ms) | `30000` | Milliseconds before the run is considered timed-out and retried (if retries remain). |

**`/__tasks` admin interface:**

| Request | Effect |
|---|---|
| `GET /__tasks` | List all registered task routes. |
| `POST /__tasks/<name>` | Trigger task `<name>` immediately with an optional JSON body as `ctx.input`. |

**`vura tasks` CLI:**

```sh
vura tasks list                       # list task routes and their schedules
vura tasks run <name>                 # trigger immediately
vura tasks run <name> --input '{"k":1}' # with input
```

**Lifecycle:** `POST` to `/__tasks/<name>` → handler runs → retried up to `retries` times on throw → result returned as JSON. Scheduled tasks fire via the cron engine inside the running server.

---

## Per-adapter support matrix

| Route kind | Node / VPS | Docker | Fly.io | Railway | CF Workers | Lambda |
|---|---|---|---|---|---|---|
| Serverless | yes | yes | yes | yes | yes | yes |
| Hot (WebSocket) | yes | yes | yes | yes | **no** | **no** |
| Task / cron | yes | yes | yes | yes | via `scheduled` event | yes (EventBridge) |

Hot routes require a persistent process that can hold a WebSocket open. Cloudflare Workers and Lambda terminate the process between invocations and cannot fulfill this contract. `vura build` emits a warning at build time when a hot route is detected and the selected adapter cannot support it:

```
[vura] N hot route(s) cannot run on <adapter> and were not bundled: /api/live/room — deploy them to a persistent host (see /self-host/)
```

The hot routes are not silently omitted — they are excluded with an explicit named warning.

See the [Deploy rung](/ladder/6-deploy/) and [Adapters reference](/reference/adapters/) for the full per-adapter picture.
