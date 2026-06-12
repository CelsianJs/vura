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
import { buildManifest } from '@celsian/vura-core';
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

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'vura-standalone-ws-'));
  await mkdir(join(root, 'src', 'api'), { recursive: true });
  await writeFile(join(root, 'src', 'api', 'echo.ts'), ECHO);
  await writeFile(join(root, 'src', 'api', 'guarded.ts'), GUARDED);
  await writeFile(join(root, 'src', 'api', 'guarded-bare.ts'), GUARDED_BARE);

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

  it('warns once (not per connection) for allowlist entries that do not URL-normalize', async () => {
    // /api/guarded-bare has not been connected to before this test, so its
    // bare entry's first-and-only warning must fire on the FIRST connection.
    const warnSpy = vi.spyOn(console, 'warn');
    try {
      await wsRoundTrip(`ws://127.0.0.1:${port}/api/guarded-bare`, 'a', { origin: 'http://allowed.test' });
      await wsRoundTrip(`ws://127.0.0.1:${port}/api/guarded-bare`, 'b', { origin: 'http://allowed.test' });
      const bareWarnings = warnSpy.mock.calls.filter((args) =>
        args.some((a) => typeof a === 'string' && a.includes('bare.example.com')),
      );
      expect(bareWarnings.length).toBe(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
