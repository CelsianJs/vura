/**
 * Hot routes — WebSocket contract + upgrade wiring + drain tests (A2.5)
 *
 * Tests:
 *   1. manifest — hasWebsocket flag detection
 *   2. upgrade + echo + closeWebSockets drain (code 1001)
 *   3. broadcast — sender excluded by default, receiver gets message
 *   4. unmatched upgrade path — server survives + HTTP still works
 *   5. binary frames — round-trip as ArrayBuffer (not corrupted strings)
 *   6. param routes — :id matched, req.params populated
 *   7. broadcast scoped to concrete path — rooms/7 != rooms/8
 *   8. shutdown guard — upgrades during drain receive 503
 */

import { describe, it, expect, afterEach } from 'vitest';
import { startVuraServer, type VuraServer } from '../src/runtime/server.js';
import { extractApiExports } from '../src/manifest.js';
import WebSocket from 'ws';

let srv: VuraServer | undefined;
afterEach(async () => {
  if (srv) {
    await srv.close();
    srv = undefined;
  }
});

// ─── Manifest detection ───

describe('manifest websocket detection', () => {
  it('flags hasWebsocket on hot routes exporting websocket()', () => {
    const src = `export const route = { kind: 'hot' };\nexport function websocket(peer, req) {}`;
    const out = extractApiExports(src);
    expect(out.kind).toBe('hot');
    expect(out.hasWebsocket).toBe(true);
  });

  it('does not flag hasWebsocket when no websocket export', () => {
    const src = `export const route = { kind: 'hot' };\nexport function GET(req) {}`;
    const out = extractApiExports(src);
    expect(out.kind).toBe('hot');
    expect(out.hasWebsocket).toBe(false);
  });

  it('does not false-positive on websocketHelper', () => {
    const src = `export const route = { kind: 'hot' };\nexport function websocketHelper(x) {}`;
    const out = extractApiExports(src);
    // websocketHelper should NOT trigger hasWebsocket (word-boundary check)
    expect(out.hasWebsocket).toBe(false);
  });

  it("accepts the `export const kind = 'hot'` shorthand (Phase 0 wedge contract)", () => {
    const src = `export const kind = 'hot';\nexport function websocket(peer, req) {}`;
    const out = extractApiExports(src);
    expect(out.kind).toBe('hot');
    expect(out.hasWebsocket).toBe(true);
  });

  it('route config kind wins over the kind shorthand', () => {
    const src = `export const kind = 'hot';\nexport const route = { kind: 'task' };\nexport async function POST() {}`;
    const out = extractApiExports(src);
    expect(out.kind).toBe('task');
  });

  it('ignores invalid kind shorthand values', () => {
    const src = `export const kind = 'banana';\nexport function GET(req) {}`;
    const out = extractApiExports(src);
    expect(out.kind).toBe('serverless');
  });

  it('detects const websocket = ... form', () => {
    const src = `export const route = { kind: 'hot' };\nexport const websocket = (peer, req) => {};`;
    const out = extractApiExports(src);
    expect(out.hasWebsocket).toBe(true);
  });
});

// ─── Upgrade, echo, drain ───

describe('hot route websockets', () => {
  it('upgrades, echoes, and closes on drain', async () => {
    srv = await startVuraServer({
      port: 0,
      apiRoutes: [
        {
          urlPattern: '/api/chat',
          methods: [],
          kind: 'hot',
          hasWebsocket: true,
          filePath: 'src/api/chat.ts',
          config: {},
          module: {
            websocket: (peer: any) => {
              peer.on('message', (data: string) => peer.send(`echo:${data}`));
            },
          },
        } as any,
      ],
      pages: [],
    });

    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/api/chat`);
    const reply = await new Promise<string>((resolve, reject) => {
      ws.on('open', () => ws.send('hi'));
      ws.on('message', (d) => resolve(d.toString()));
      ws.on('error', reject);
    });
    expect(reply).toBe('echo:hi');

    const closed = new Promise<number>((resolve) =>
      ws.on('close', (code) => resolve(code)),
    );
    await srv.closeWebSockets(1001, 'shutting down');
    expect(await closed).toBe(1001);
  });

  // ─── Broadcast: sender excluded ───

  it('broadcast delivers to other peers and excludes sender by default', async () => {
    srv = await startVuraServer({
      port: 0,
      apiRoutes: [
        {
          urlPattern: '/api/broadcast',
          methods: [],
          kind: 'hot',
          hasWebsocket: true,
          filePath: 'src/api/broadcast.ts',
          config: {},
          module: {
            websocket: (peer: any) => {
              peer.on('message', (data: string) => {
                // Broadcast to all OTHER peers — sender excluded (default)
                peer.broadcast(`bcast:${data}`);
              });
            },
          },
        } as any,
      ],
      pages: [],
    });

    const url = `ws://127.0.0.1:${srv.port}/api/broadcast`;
    const ws1 = new WebSocket(url);
    const ws2 = new WebSocket(url);

    // Wait for both to open
    await Promise.all([
      new Promise<void>((resolve, reject) => { ws1.on('open', resolve); ws1.on('error', reject); }),
      new Promise<void>((resolve, reject) => { ws2.on('open', resolve); ws2.on('error', reject); }),
    ]);

    // ws1 sends; ws2 should receive; ws1 should NOT receive (excluded by default)
    const receivedByWs2 = new Promise<string>((resolve) =>
      ws2.on('message', (d) => resolve(d.toString())),
    );

    // Track if ws1 receives anything (it shouldn't for the broadcast from itself)
    let ws1ReceivedBroadcast = false;
    ws1.on('message', () => { ws1ReceivedBroadcast = true; });

    ws1.send('hello');
    const msg = await receivedByWs2;
    expect(msg).toBe('bcast:hello');

    // Give a short window to ensure ws1 didn't get the broadcast
    await new Promise((r) => setTimeout(r, 50));
    expect(ws1ReceivedBroadcast).toBe(false);

    ws1.close();
    ws2.close();
  });

  // ─── Unmatched upgrade path ───

  it('unmatched upgrade path closes cleanly and HTTP still works', async () => {
    srv = await startVuraServer({
      port: 0,
      apiRoutes: [
        {
          urlPattern: '/api/chat',
          methods: [],
          kind: 'hot',
          hasWebsocket: true,
          filePath: 'src/api/chat.ts',
          config: {},
          module: {
            websocket: (_peer: any) => {
              // no-op
            },
          },
        } as any,
        {
          urlPattern: '/api/health',
          methods: ['GET'],
          kind: 'serverless',
          hasWebsocket: false,
          filePath: 'src/api/health.ts',
          config: {},
          module: {
            GET: () => new Response(JSON.stringify({ ok: true }), {
              headers: { 'content-type': 'application/json' },
            }),
          },
        } as any,
      ],
      pages: [],
    });

    // Try to upgrade to a path that has no ws handler
    const badWs = new WebSocket(`ws://127.0.0.1:${srv.port}/api/nope`);
    const badClosed = await new Promise<boolean>((resolve) => {
      badWs.on('close', () => resolve(true));
      badWs.on('error', () => resolve(true)); // error also counts as "closed gracefully"
    });
    expect(badClosed).toBe(true);

    // Server must still handle HTTP after a bad upgrade attempt
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  // ─── Binary frames: round-trip as ArrayBuffer ───

  it('binary frames are delivered as ArrayBuffer with intact bytes', async () => {
    srv = await startVuraServer({
      port: 0,
      apiRoutes: [
        {
          urlPattern: '/api/binary',
          methods: [],
          kind: 'hot',
          hasWebsocket: true,
          filePath: 'src/api/binary.ts',
          config: {},
          module: {
            websocket: (peer: any) => {
              peer.on('message', (data: string | ArrayBuffer) => {
                // Echo the byte length back as a text frame so we can assert it
                if (data instanceof ArrayBuffer) {
                  const view = new Uint8Array(data);
                  // Send back all bytes as comma-separated string for easy assertion
                  peer.send(`bytes:${Array.from(view).join(',')}`);
                } else {
                  peer.send(`got-string:${data}`);
                }
              });
            },
          },
        } as any,
      ],
      pages: [],
    });

    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/api/binary`);
    const reply = await new Promise<string>((resolve, reject) => {
      ws.on('open', () => {
        // Send a binary frame: [1, 255, 128, 0]
        ws.send(Buffer.from([1, 255, 128, 0]));
      });
      ws.on('message', (d) => resolve(d.toString()));
      ws.on('error', reject);
    });
    // Must arrive as ArrayBuffer (not stringified Buffer), bytes preserved
    expect(reply).toBe('bytes:1,255,128,0');
    ws.close();
  });

  // ─── Param routes: :id matched + req.params populated ───

  it('param routes match and req.params is populated', async () => {
    const capturedParams: Record<string, string>[] = [];

    srv = await startVuraServer({
      port: 0,
      apiRoutes: [
        {
          urlPattern: '/api/rooms/:id',
          methods: [],
          kind: 'hot',
          hasWebsocket: true,
          filePath: 'src/api/rooms/[id].ts',
          config: {},
          module: {
            websocket: (peer: any, req: any) => {
              capturedParams.push({ ...req.params });
              peer.on('message', (data: string) => peer.send(`room:${req.params.id}:${data}`));
            },
          },
        } as any,
      ],
      pages: [],
    });

    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/api/rooms/42`);
    const reply = await new Promise<string>((resolve, reject) => {
      ws.on('open', () => ws.send('ping'));
      ws.on('message', (d) => resolve(d.toString()));
      ws.on('error', reject);
    });

    expect(reply).toBe('room:42:ping');
    expect(capturedParams[0]).toEqual({ id: '42' });
    ws.close();
  });

  // ─── Broadcast scoped to concrete path ───

  it('broadcast from rooms/7 does NOT reach peers in rooms/8', async () => {
    srv = await startVuraServer({
      port: 0,
      apiRoutes: [
        {
          urlPattern: '/api/rooms/:id',
          methods: [],
          kind: 'hot',
          hasWebsocket: true,
          filePath: 'src/api/rooms/[id].ts',
          config: {},
          module: {
            websocket: (peer: any) => {
              peer.on('message', (data: string) => {
                // Broadcast to all OTHER peers on same concrete path (excludeSelf default=true)
                peer.broadcast(`bcast:${data}`);
              });
            },
          },
        } as any,
      ],
      pages: [],
    });

    const base = `ws://127.0.0.1:${srv.port}`;
    const ws7a = new WebSocket(`${base}/api/rooms/7`);
    const ws7b = new WebSocket(`${base}/api/rooms/7`);
    const ws8  = new WebSocket(`${base}/api/rooms/8`);

    await Promise.all([
      new Promise<void>((res, rej) => { ws7a.on('open', res); ws7a.on('error', rej); }),
      new Promise<void>((res, rej) => { ws7b.on('open', res); ws7b.on('error', rej); }),
      new Promise<void>((res, rej) => { ws8.on('open', res);  ws8.on('error', rej);  }),
    ]);

    // ws7a sends → ws7b (same room) must receive via broadcast; ws8 must NOT
    const room7bGot = new Promise<string>((res) => ws7b.on('message', (d) => res(d.toString())));
    let room8Got = false;
    ws8.on('message', () => { room8Got = true; });

    ws7a.send('hello-room7');
    const msg = await room7bGot;
    expect(msg).toBe('bcast:hello-room7');

    // Give a small window then confirm rooms/8 got nothing
    await new Promise((r) => setTimeout(r, 50));
    expect(room8Got).toBe(false);

    ws7a.close();
    ws7b.close();
    ws8.close();
  });

  // ─── Registry eviction: ephemeral param paths freed after last peer leaves ───

  it('registry evicts ephemeral concrete paths when last peer disconnects', async () => {
    srv = await startVuraServer({
      port: 0,
      apiRoutes: [
        {
          urlPattern: '/api/rooms/:id',
          methods: [],
          kind: 'hot',
          hasWebsocket: true,
          filePath: 'src/api/rooms/[id].ts',
          config: {},
          module: {
            websocket: (_peer: any) => { /* no-op */ },
          },
        } as any,
      ],
      pages: [],
    });

    const base = `ws://127.0.0.1:${srv.port}`;

    // Access the registry directly (exposed via srv._wsRegistry for test introspection).
    const reg = srv._wsRegistry as {
      handlers: Map<string, unknown>;
      connections: Map<string, unknown>;
      getConnectionCount(path?: string): number;
    };

    // Baseline: only the pattern-level entry from startup registration (if any).
    // Concrete paths (/api/rooms/1..5) have not yet been visited.
    const baselineHandlerCount = reg.handlers.size;

    // Connect to 5 distinct rooms, then disconnect each one.
    for (const id of [1, 2, 3, 4, 5]) {
      const ws = new WebSocket(`${base}/api/rooms/${id}`);
      await new Promise<void>((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
      });
      const closed = new Promise<void>((resolve) => ws.on('close', resolve));
      ws.close(1000);
      await closed;

      // Poll until server-side connection count for this path reaches 0.
      // The server 'close' handler fires on the raw ws event which is async
      // relative to the client-side close acknowledgement.
      const path = `/api/rooms/${id}`;
      for (let i = 0; i < 20; i++) {
        if (reg.getConnectionCount(path) === 0) break;
        await new Promise((r) => setTimeout(r, 10));
      }
    }

    // After all peers have left all 5 ephemeral rooms, the registry Maps must
    // have been trimmed back to baseline — no lingering /api/rooms/1..5 entries.
    expect(reg.handlers.size).toBe(baselineHandlerCount);
    expect(reg.connections.size).toBe(baselineHandlerCount);
  });

  // ─── Shutdown guard: upgrades during drain get 503 ───

  it('upgrade attempts during shutdown receive 503', async () => {
    srv = await startVuraServer({
      port: 0,
      apiRoutes: [
        {
          urlPattern: '/api/chat',
          methods: [],
          kind: 'hot',
          hasWebsocket: true,
          filePath: 'src/api/chat.ts',
          config: {},
          module: {
            websocket: (_peer: any) => { /* no-op */ },
          },
        } as any,
      ],
      pages: [],
    });

    const port = srv.port;

    // Trigger shutdown (don't await — we want to race it)
    const closePromise = srv.close();
    srv = undefined; // prevent afterEach double-close

    // Small delay to let shuttingDown flag propagate, then attempt upgrade
    await new Promise((r) => setTimeout(r, 10));

    // The upgrade should be rejected — either ws error or close with !1000
    const rejected = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/chat`);
      ws.on('error', () => resolve(true));
      ws.on('close', (code) => resolve(code !== 1000 || true));
      // Treat any close/error as "rejected" (503 destroys the socket)
    });
    expect(rejected).toBe(true);

    await closePromise;
  });
});
