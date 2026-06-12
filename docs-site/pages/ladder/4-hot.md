# Rung 4 — Hot routes: websockets, state, and no timeout

You need a websocket. Or presence. Or an AI agent loop that streams for four
minutes. Or a 40-second export job a user is waiting on. This is the moment
every serverless platform fails you — and the moment Vura was built for.

## The problem this rung solves

Serverless functions are stateless and time-boxed. The day your app needs a
persistent connection or in-memory state, the conventional answer is: keep
your frontend where it is, stand up a second app on a second platform for the
"real-time part," and glue them together — two deploys, two log streams, two
type boundaries, one new failure mode.

Vura's answer is one line, in the project you already have:

```ts
export const kind = 'hot';
```

## A complete hot route

```ts
// src/api/live/room.ts
import type { HotPeer, HotRequest } from '@celsian/vura-core';

export const kind = 'hot';

type Client = { peer: HotPeer; name: string };
const rooms = new Map<string, Set<Client>>();

// websocket() receives upgraded connections for this route.
// peer  — HotPeer: send(), close(), on('message'|'close'), broadcast()
// req   — HotRequest: url, headers, query (URLSearchParams), params
export function websocket(peer: HotPeer, req: HotRequest) {
  const roomId = req.params['room'] ?? 'lobby';
  const client: Client = { peer, name: req.query.get('name') ?? 'anon' };

  const room = rooms.get(roomId) ?? new Set<Client>();
  room.add(client);
  rooms.set(roomId, room);

  broadcast(room, { type: 'join', name: client.name, count: room.size });

  peer.on('message', (data) => {
    broadcast(room, { type: 'message', name: client.name, body: String(data) });
  });

  peer.on('close', () => {
    room.delete(client);
    broadcast(room, { type: 'leave', name: client.name, count: room.size });
    if (room.size === 0) rooms.delete(roomId);
  });
}

// Plain HTTP methods work on the same hot route file.
export function GET(req: HotRequest, reply: any) {
  return reply.json({
    rooms: [...rooms.entries()].map(([id, c]) => ({ id, clients: c.size })),
  });
}

function broadcast(room: Set<Client>, msg: object) {
  const data = JSON.stringify(msg);
  for (const c of room) c.peer.send(data);
}
```

Note what did *not* change: the file lives in `src/api/` next to your
serverless routes, the route path comes from the file path, and types flow to
the client the same way.

### Key API differences from a serverless route

- The kind annotation is `export const kind = 'hot'` (shorthand) or `export const route = { kind: 'hot', ... }` when you also need route config — the route object wins if both are present.
- The websocket handler is named `websocket`, not `ws`.
- The first argument is a `HotPeer` object, not a raw `WebSocket`.
  Use `peer.send()`, `peer.on()`, `peer.broadcast()`, `peer.close()`.
- The second argument is a `HotRequest`: use `req.query.get('name')` (it is a
  `URLSearchParams`, not a plain object) and `req.params['room']` for path params.

## What `kind: 'hot'` actually means

| | Serverless route (default) | Hot route |
|---|---|---|
| Process | per-invocation, disposable | persistent, long-lived |
| In-memory state | lost between requests | lives as long as the process |
| WebSockets | not possible | first-class (`export function websocket()`) |
| Execution time | platform-limited (seconds) | unlimited |
| Scaling model | per-request | per-process (vertical first) |
| Cost at idle | zero | one small always-on process |

Hot routes are real processes. State in module scope (like `rooms` above) is
shared across all connections to that process — which is exactly what you want
for presence, rooms, and live caches, and exactly what you must not assume
once you run more than one instance. Start with one instance; when you need
more, partition by room/tenant at the load balancer.

## Talking to a hot route from a page

```tsx
// src/pages/chat.tsx
import { useSignal, onMount } from 'what-framework';

export const page = { mode: 'client' };

export default function Chat() {
  const messages = useSignal<string[]>([]);

  onMount(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/live/room?name=kirby`);
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'message') {
        messages.set([...messages(), `${msg.name}: ${msg.body}`]);
      }
    };
    ws.onclose = () => {};
  });

  return <ul>{() => messages().map((m, i) => <li key={i}>{m}</li>)}</ul>;
}
```

`useSignal` and `onMount` are exported from `what-framework` (re-exported from
`what-core`). Import them directly — no separate package needed.

The what-fw signals API: `useSignal(initial)` returns a signal. Read the
current value by calling it as a function (`messages()`); write by calling
`.set(newValue)` (`messages.set([...])`). The scaffold includes `ws` as a
dependency. For projects created before this version: `npm install ws`.

## Try it now

Hot routes work directly in `vura dev`: the dev server (both the Vite mode
and the standalone fallback) accepts WebSocket upgrades for `kind: 'hot'`
routes, with edits to a route file applying on the next connection. Start
`vura dev` and connect with `npx wscat -c "ws://localhost:3000/api/live/room?name=alice"`.

For the production-parity check, build and run the real server entry —
WebSocket upgrades require a persistent process in production too:

```sh
# 1. Build
npm run build
# → emits dist/server/entry.js, dist/Dockerfile, dist/fly.toml, dist/package.json

# 2. Start the production server
PORT=3000 node dist/server/entry.js
# → [vura] listening on port 3000

# 3. In one terminal — connect as "alice"
npx wscat -c "ws://localhost:3000/api/live/room?name=alice"
# Connected (press CTRL+C to quit)
# < {"type":"join","name":"alice","count":1}

# 4. In another terminal — connect as "bob"
npx wscat -c "ws://localhost:3000/api/live/room?name=bob"
# Connected (press CTRL+C to quit)
# < {"type":"join","name":"bob","count":2}
# (alice's terminal also receives the join event)

# 5. Type a message in alice's terminal
> hello from alice
# alice receives: {"type":"message","name":"alice","body":"hello from alice"}
# bob receives:   {"type":"message","name":"alice","body":"hello from alice"}

# 6. Query active rooms via HTTP (GET on the same route)
curl -s localhost:3000/api/live/room
# → {"rooms":[{"id":"lobby","clients":2}]}
```

Note: `vura build` detects the hot route and emits `dist/Dockerfile`,
`dist/fly.toml`, and `dist/package.json` alongside `dist/server/entry.js`.
The fly.toml is ready to deploy with `fly deploy ./dist`.

## Deploying hot routes

`vura build` detects hot routes and emits, alongside the normal output:

- `dist/server/entry.js` — the unified server that handles both HTTP and WebSocket
  traffic (there is no separate "hot entry"; everything runs through one process)
- `dist/Dockerfile` — a copy-paste recipe for a persistent host
- `dist/fly.toml` — pre-configured with `auto_stop_machines = "off"` and
  `kill_timeout = "30s"` (Fly.io must not idle-stop a process that holds live sockets)
- `dist/package.json` — with the `ws` dependency included when ws routes exist

Deploy to Fly.io:

```sh
vura build
fly launch --config dist/fly.toml   # first deploy, creates the app
# subsequent deploys:
fly deploy ./dist
```

Hot routes need a persistent host: a VPS, Docker on anything, Fly.io, or
Railway. They **cannot** run on Cloudflare Workers or AWS Lambda — that is the
structural limitation this rung exists to escape. `vura build` emits a
`[vura] N hot route(s) cannot run on <adapter> and were not bundled` warning
when a hot route is present and a non-persistent adapter is active, so you
find out at build time, not in production. See the
[Fly.io guide](/self-host/fly/) for the full path, or
[Node/VPS](/self-host/node-vps/) for the simplest one.

## Restrict origins in production

By default a hot route accepts WebSocket upgrades from **any** Origin. If your
app authenticates with cookies, that means any website a logged-in user visits
can open a socket to your route with their credentials attached
(cross-site WebSocket hijacking). Lock it down with the `origins` route config:

```ts
export const route = {
  kind: 'hot',
  origins: ['https://yourapp.example'],
};
```

Upgrade requests from any other browser Origin are rejected with `403` before
the handshake. Requests with no `Origin` header (curl, wscat, server-to-server
clients) still connect — browsers always send Origin, and non-browser clients
can forge any value, so blocking them would add no security. Recommended for
**any cookie-authenticated app**; harmless to set everywhere. Entries must be
inline string literals in the `route` export — identifiers, spreads, or
template literals are not extracted at build time, leaving the route open.

## Graceful drain on deploy

When a new version is deployed, the old process receives SIGTERM. Vura's
shutdown path:

1. Stops accepting new WebSocket upgrades (returns 503 to new upgrade requests).
2. Sends a close frame (`1001 going away`) to every open socket.
3. Waits up to 3 seconds per socket for the client to acknowledge the close.
4. Force-terminates any socket that has not responded after the grace window.
5. Closes the HTTP server and exits cleanly.

The `fly.toml` emitted by `vura build` sets `kill_timeout = "30s"` so the
platform gives the process enough time to drain before it force-kills it.

There is no `hot.drainTimeoutMs` key in `vura.config` — drain behavior is
wired at the server level and is not currently user-configurable.

## Next

Your app now holds static pages, cached server pages, serverless APIs, and a
websocket server — one project, one type system, one deploy. The last
capability is work that shouldn't block a request at all:
**[Rung 5 — Background tasks →](/ladder/5-tasks/)**
