/**
 * v0.4.x backlog Task 4 — WebSocket upgrades in `vura dev` (Vite path).
 *
 * Boots a REAL Vite dev server with thenPlugin on an ephemeral port against a
 * fixture project containing an echo hot route, then verifies:
 *
 *   1. ws client connects to the hot route, sends 'hi', receives 'echo:hi'.
 *   2. A ws client offering `sec-websocket-protocol: vite-hmr` to a
 *      non-hot-route path is NOT intercepted by our upgrade handler — Vite's
 *      own HMR listener accepts it (connection opens with that protocol).
 *   3. Editing the hot route module takes effect on the NEXT connection
 *      (ssrLoadModule per upgrade — the dev-rescan contract).
 *   4. The Origin allowlist 403 applies in dev too (guarded route fixture).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import WebSocket from 'ws';
import { thenPlugin } from '../src/index.js';

const ECHO_V1 = `export const route = { kind: 'hot' };
export function websocket(peer: any) {
  peer.on('message', (data: string) => peer.send('echo:' + data));
}
`;

const ECHO_V2 = `export const route = { kind: 'hot' };
export function websocket(peer: any) {
  peer.on('message', (data: string) => peer.send('echo2:' + data));
}
`;

const GUARDED = `export const route = { kind: 'hot', origins: ['http://allowed.test'] };
export function websocket(peer: any) {
  peer.on('message', (data: string) => peer.send('guarded:' + data));
}
`;

let root: string;
let server: ViteDevServer;
let port: number;

function wsRoundTrip(url: string, send: string, headers?: Record<string, string>, protocols?: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const ws = protocols ? new WebSocket(url, protocols, { headers }) : new WebSocket(url, { headers });
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

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'vura-vite-ws-'));
  await mkdir(join(root, 'src', 'api'), { recursive: true });
  await writeFile(join(root, 'src', 'api', 'echo.ts'), ECHO_V1);
  await writeFile(join(root, 'src', 'api', 'guarded.ts'), GUARDED);

  server = await createViteServer({
    root,
    configFile: false,
    logLevel: 'silent',
    server: { port: 0, host: '127.0.0.1' },
    plugins: [thenPlugin({ root })],
  });
  await server.listen();
  const addr = server.httpServer!.address() as { port: number };
  port = addr.port;
}, 30000);

afterAll(async () => {
  await server?.close();
  await rm(root, { recursive: true, force: true });
});

describe('vite dev — hot route websocket upgrades', () => {
  it('upgrades and echoes on a hot route', async () => {
    const reply = await wsRoundTrip(`ws://127.0.0.1:${port}/api/echo`, 'hi');
    expect(reply).toBe('echo:hi');
  });

  it('does not intercept vite-hmr protocol upgrades (Vite accepts them)', async () => {
    // Vite's HMR listener claims protocol vite-hmr/vite-ping at the HMR base
    // path ('/'). Our handler must return without touching the socket so the
    // handshake completes against Vite's own WebSocketServer.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, 'vite-hmr');
    const opened = await new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => { ws.terminate(); reject(new Error('vite-hmr handshake timed out')); }, 5000);
      ws.on('open', () => { clearTimeout(timer); resolve(true); });
      ws.on('error', (err) => { clearTimeout(timer); reject(err); });
    });
    expect(opened).toBe(true);
    expect(ws.protocol).toBe('vite-hmr');
    ws.close();
  });

  it('claims hot-route upgrades whose subprotocol merely CONTAINS a vite-hmr-like token', async () => {
    // `x-vite-hmr` is NOT Vite traffic — the old word-boundary regex matched
    // it and ignored the socket (which then hung). Exact token matching must
    // let our handler claim it and echo normally.
    const reply = await wsRoundTrip(`ws://127.0.0.1:${port}/api/echo`, 'hi', undefined, ['x-vite-hmr']);
    expect(reply).toBe('echo:hi');
  });

  it('picks up edits to the hot route module on the next connection', async () => {
    await writeFile(join(root, 'src', 'api', 'echo.ts'), ECHO_V2);
    // The watcher invalidates the SSR module graph asynchronously — poll with
    // fresh connections until the edited handler responds (or time out).
    let reply = '';
    for (let attempt = 0; attempt < 40; attempt++) {
      reply = await wsRoundTrip(`ws://127.0.0.1:${port}/api/echo`, 'hi');
      if (reply === 'echo2:hi') break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(reply).toBe('echo2:hi');
  }, 15000);

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
});
