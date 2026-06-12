/**
 * v0.4.x backlog Task 4 — WebSocket upgrades in `vura dev` (standalone path).
 *
 * Boots the Vite-less standalone dev server (startStandaloneServer, exported
 * for tests) against a fixture project and verifies:
 *
 *   1. ws client connects to an echo hot route and round-trips a message.
 *   2. The Origin allowlist 403 applies in dev: disallowed Origin fails the
 *      handshake, allowlisted Origin connects.
 *   3. Unmatched upgrade paths are 404-rejected (vura owns this server) and
 *      HTTP keeps working afterwards.
 *   4. An allowlist entry that doesn't URL-normalize warns ONCE (per entry,
 *      not per connection).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildManifest,
  compileRoutes,
  createWsUpgradeHandler,
  createNoServerWebSocketServer,
} from '@celsian/vura-core';
import type { ApiRoute, WsRegistryLike } from '@celsian/vura-core';
import WebSocket from 'ws';
import { startStandaloneServer } from '../src/commands/dev.js';

const ECHO = `export const route = { kind: 'hot' };
export function websocket(peer) {
  peer.on('message', (data) => peer.send('echo:' + data));
}
`;

const GUARDED = `export const route = { kind: 'hot', origins: ['http://allowed.test'] };
export function websocket(peer) {
  peer.on('message', (data) => peer.send('guarded:' + data));
}
`;

// 'bare.example.com' is deliberately scheme-less: it can never match a browser
// Origin header and must trigger the one-time unparseable-entry warning.
const GUARDED_BARE = `export const route = { kind: 'hot', origins: ['http://allowed.test', 'bare.example.com'] };
export function websocket(peer) {
  peer.on('message', (data) => peer.send('bare:' + data));
}
`;

// Module-level state IS the hot-route wedge (rooms Maps, counters, Sets).
// Every connection — and the HTTP GET — must observe the SAME module instance,
// exactly like prod (one bundled instance) and Vite dev (ssrLoadModule cache).
const COUNTER = `export const route = { kind: 'hot' };
const peers = new Set();
let connections = 0;
export function websocket(peer) {
  connections += 1;
  peers.add(peer);
  peer.send('count:' + connections);
  peer.on('message', (data) => { for (const p of peers) p.send('relay:' + data); });
  peer.on('close', () => peers.delete(peer));
}
export function GET() {
  return { connections };
}
`;

// Same route, edited: new message prefix + reset counter. Used to verify the
// fs-watcher rescan clears the module cache (edits apply on next connection).
const COUNTER_V2 = `export const route = { kind: 'hot' };
let connections = 0;
export function websocket(peer) {
  connections += 1;
  peer.send('count2:' + connections);
}
`;

// Syntactically broken (missing paren) — the static manifest scan still sees
// a hot route with a websocket export, but esbuild fails on it. The rescan's
// build-then-swap must fail ATOMICALLY: the route never becomes matchable and
// every existing route keeps serving its old consistent module set.
const BROKEN = `export const route = { kind: 'hot' };
export function websocket(peer) {
  peer.send('hello'
}
`;

// The same route, fixed — once it esbuilds, the rescan succeeds and it serves.
const BROKEN_FIXED = `export const route = { kind: 'hot' };
export function websocket(peer) {
  peer.on('message', (data) => peer.send('fixed:' + data));
}
`;

let root: string;
let srv: Awaited<ReturnType<typeof startStandaloneServer>>;
let port: number;

function wsRoundTrip(url: string, send: string, headers?: Record<string, string>): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('ws round-trip timed out')); }, 5000);
    ws.on('open', () => ws.send(send));
    ws.on('message', (d) => {
      clearTimeout(timer);
      resolve(d.toString());
      ws.close();
    });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

/**
 * Connect and buffer every incoming message in an inbox from the moment the
 * socket is created — the server may send its greeting BEFORE the caller gets
 * a chance to attach a listener, so `next()` reads from the queue first.
 */
function openWs(url: string): Promise<{ ws: WebSocket; next: () => Promise<string> }> {
  const inbox: string[] = [];
  const waiters: Array<(msg: string) => void> = [];
  const ws = new WebSocket(url);
  ws.on('message', (d) => {
    const msg = d.toString();
    const waiter = waiters.shift();
    if (waiter) waiter(msg);
    else inbox.push(msg);
  });
  const next = () =>
    new Promise<string>((resolve, reject) => {
      const queued = inbox.shift();
      if (queued !== undefined) return resolve(queued);
      const timer = setTimeout(() => reject(new Error('ws message timed out')), 5000);
      waiters.push((msg) => { clearTimeout(timer); resolve(msg); });
    });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('ws open timed out')); }, 5000);
    ws.on('open', () => { clearTimeout(timer); resolve({ ws, next }); });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

/** Connect expecting the HANDSHAKE to fail; resolves with the client error. */
function wsHandshakeError(url: string): Promise<Error> {
  return new Promise<Error>((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('handshake neither failed nor succeeded')); }, 5000);
    ws.on('error', (err) => { clearTimeout(timer); resolve(err); });
    ws.on('open', () => { clearTimeout(timer); ws.close(); resolve(new Error('handshake unexpectedly succeeded')); });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'vura-standalone-ws-'));
  await mkdir(join(root, 'src', 'api'), { recursive: true });
  await writeFile(join(root, 'src', 'api', 'echo.ts'), ECHO);
  await writeFile(join(root, 'src', 'api', 'guarded.ts'), GUARDED);
  await writeFile(join(root, 'src', 'api', 'guarded-bare.ts'), GUARDED_BARE);
  await writeFile(join(root, 'src', 'api', 'counter.ts'), COUNTER);

  const manifest = await buildManifest(root);
  srv = await startStandaloneServer(manifest, { port: 0, host: '127.0.0.1', projectRoot: root });
  port = srv.port;
}, 30000);

afterAll(async () => {
  await srv?.close();
  await rm(root, { recursive: true, force: true });
});

describe('standalone vura dev — hot route websocket upgrades', () => {
  it('upgrades and echoes on a hot route', async () => {
    const reply = await wsRoundTrip(`ws://127.0.0.1:${port}/api/echo`, 'hi');
    expect(reply).toBe('echo:hi');
  });

  it('applies the Origin allowlist 403 in dev', async () => {
    // Disallowed Origin → pre-upgrade 403, handshake fails.
    const evil = new WebSocket(`ws://127.0.0.1:${port}/api/guarded`, {
      headers: { origin: 'http://evil.test' },
    });
    const evilError = await new Promise<Error>((resolve) => {
      evil.on('error', resolve);
      evil.on('open', () => resolve(new Error('handshake unexpectedly succeeded')));
    });
    expect(evilError.message).toContain('403');

    // Allowlisted Origin → connects and round-trips.
    const reply = await wsRoundTrip(
      `ws://127.0.0.1:${port}/api/guarded`,
      'hi',
      { origin: 'http://allowed.test' },
    );
    expect(reply).toBe('guarded:hi');
  });

  it('rejects unmatched upgrade paths with 404 and keeps serving HTTP', async () => {
    const bad = new WebSocket(`ws://127.0.0.1:${port}/api/nope`);
    const badError = await new Promise<Error>((resolve) => {
      bad.on('error', resolve);
      bad.on('open', () => resolve(new Error('handshake unexpectedly succeeded')));
    });
    expect(badError.message).toContain('404');

    const res = await fetch(`http://127.0.0.1:${port}/__health`);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('shares ONE module instance across ws connections and HTTP (module-level state works)', async () => {
    // Client A connects → module-level counter is 1.
    const a = await openWs(`ws://127.0.0.1:${port}/api/counter`);
    try {
      expect(await a.next()).toBe('count:1');

      // Client B connects → SAME module instance → counter must be 2.
      // (Pre-fix each connection got a fresh esbuild+import: B also saw 1.)
      const b = await openWs(`ws://127.0.0.1:${port}/api/counter`);
      try {
        expect(await b.next()).toBe('count:2');

        // A must receive a relay delivered via the MODULE-LEVEL Set (not
        // peer.broadcast) — the rooms-Map pattern from docs ladder 4-hot.md.
        b.ws.send('hello');
        expect(await a.next()).toBe('relay:hello');

        // The HTTP path must observe the same module instance as ws.
        const res = await fetch(`http://127.0.0.1:${port}/api/counter`);
        expect(res.status).toBe(200);
        const body = await res.json() as { connections: number };
        expect(body.connections).toBe(2);
      } finally {
        b.ws.close();
      }
    } finally {
      a.ws.close();
    }
  }, 15000);

  it('clears the module cache on watcher rescan — edits apply on the next connection', async () => {
    await writeFile(join(root, 'src', 'api', 'counter.ts'), COUNTER_V2);
    // The fs-watcher rescan is async — poll fresh connections until the edited
    // module answers. A fresh instance always greets its first peer with 1.
    let first = '';
    for (let attempt = 0; attempt < 40; attempt++) {
      const client = await openWs(`ws://127.0.0.1:${port}/api/counter`);
      try { first = await client.next(); } finally { client.ws.close(); }
      if (first.startsWith('count2:')) break;
      await sleep(250);
    }
    expect(first).toBe('count2:1');
  }, 15000);

  it('fails the rescan ATOMICALLY when an added file is broken — 404 until fixed, then serves', async () => {
    // Adding a broken file must fail the build-then-swap rebuild as a whole:
    // the manifest is NOT advanced (the route never matches → 404, not a
    // half-built app), existing routes keep serving, and the next successful
    // rescan (the fixed file) recovers. Detect the failed rescan via its
    // console.error diagnostic instead of sleeping blind.
    const errSpy = vi.spyOn(console, 'error');
    try {
      await writeFile(join(root, 'src', 'api', 'broken.ts'), BROKEN);
      let rescanFailed = false;
      for (let attempt = 0; attempt < 40; attempt++) {
        rescanFailed = errSpy.mock.calls.some((args) =>
          args.some((a) => typeof a === 'string' && a.includes('route re-scan failed')),
        );
        if (rescanFailed) break;
        await sleep(250);
      }
      expect(rescanFailed).toBe(true);

      // The broken route never became matchable…
      const err = await wsHandshakeError(`ws://127.0.0.1:${port}/api/broken`);
      expect(err.message).toContain('404');
      // …and the old app keeps serving.
      expect(await wsRoundTrip(`ws://127.0.0.1:${port}/api/echo`, 'hi')).toBe('echo:hi');
    } finally {
      errSpy.mockRestore();
    }

    // Fix the file → the next rescan succeeds and the route serves.
    await writeFile(join(root, 'src', 'api', 'broken.ts'), BROKEN_FIXED);
    let reply = '';
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        reply = await wsRoundTrip(`ws://127.0.0.1:${port}/api/broken`, 'hi');
        if (reply === 'fixed:hi') break;
      } catch {
        // 404 until the rescan lands — retry.
      }
      await sleep(250);
    }
    expect(reply).toBe('fixed:hi');
  }, 30000);

  it('rejects the handshake with 500 (not bare ECONNRESET) when the module fails to load at upgrade time', async () => {
    // In standalone dev the atomic build-then-swap eagerly loads every module
    // at rebuild time, so an upgrade-time load failure is only reachable in
    // the (accepted) mid-rebuild race window. But the shared upgrade handler
    // also serves Vite dev, where ssrLoadModule loads LAZILY at upgrade time
    // and genuinely fails on a broken edit — cover the path directly against
    // a real HTTP server with a rejecting loadModule.
    const { createServer } = await import('node:http');
    const httpSrv = createServer((_req, res) => { res.writeHead(404); res.end(); });

    const brokenRoute: ApiRoute = {
      filePath: 'src/api/broken.ts',
      urlPattern: '/api/broken',
      methods: [],
      kind: 'hot',
      hasWebsocket: true,
      config: {},
    };
    // Never reached: the handler rejects before touching the registry.
    const registry: WsRegistryLike = {
      hasPath: () => false,
      register: () => {},
      addConnection: () => {},
      removeConnection: () => {},
      getConnectionCount: () => 0,
      broadcast: () => {},
    };
    const wsModule = await import('ws');
    httpSrv.on('upgrade', createWsUpgradeHandler({
      wss: createNoServerWebSocketServer(wsModule),
      getWsRoutes: () => compileRoutes([brokenRoute]),
      loadModule: () => Promise.reject(new Error('esbuild failed: syntax error')),
      getWsRegistry: () => registry,
      onUnmatched: 'reject',
    }));

    await new Promise<void>((resolve) => httpSrv.listen(0, '127.0.0.1', resolve));
    const unitPort = (httpSrv.address() as { port: number }).port;
    // Silence the handler's intentional console.error diagnostic.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const err = await wsHandshakeError(`ws://127.0.0.1:${unitPort}/api/broken`);
      expect(err.message).toContain('500');
    } finally {
      errSpy.mockRestore();
      (httpSrv as any).closeAllConnections?.();
      await new Promise<void>((resolve) => httpSrv.close(() => resolve()));
    }
  });

  it('warns once (not per connection) for allowlist entries that do not URL-normalize', async () => {
    // /api/guarded-bare has not been connected to before this test, so its
    // bare entry's first-and-only warning must fire on the FIRST connection.
    const warnSpy = vi.spyOn(console, 'warn');
    try {
      await wsRoundTrip(`ws://127.0.0.1:${port}/api/guarded-bare`, 'a', { origin: 'http://allowed.test' });
      await wsRoundTrip(`ws://127.0.0.1:${port}/api/guarded-bare`, 'b', { origin: 'http://allowed.test' });
      const bareWarnings = warnSpy.mock.calls.filter((args) =>
        args.some((a) => typeof a === 'string' && a.includes('origins entry "bare.example.com" is not a parseable URL')),
      );
      expect(bareWarnings.length).toBe(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
