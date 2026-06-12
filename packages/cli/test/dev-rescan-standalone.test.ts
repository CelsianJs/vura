/**
 * v0.5 backlog — standalone dev fs-watcher rescan must rebuild against the
 * FRESH manifest (regression from the build-then-swap polish in 2aaf94a).
 *
 * `buildStandaloneApiApp()` used to read the `manifest` closure variable, but
 * the rescan only reassigns `manifest = nextManifest` AFTER the rebuild — so
 * every rebuild ran against the previous manifest:
 *
 *   - DELETE a route file → the rebuild tried to esbuild the deleted file →
 *     threw → the old manifest was kept → every later rescan re-failed on the
 *     same missing file forever. The deleted route kept serving 200 AND edits
 *     to other files never applied again until a dev-server restart.
 *   - ADD a route file → the first rescan built the app without it (404 until
 *     a second watcher event happened to fire).
 *
 * Fixed by parameterizing buildStandaloneApiApp(forManifest) and passing
 * nextManifest in the rescan. These tests boot the real standalone server
 * against tmpdir fixtures and exercise both paths end-to-end.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildManifest } from '@celsian/vura-core';
import { startStandaloneServer } from '../src/commands/dev.js';

const ROUTE_A_V1 = `export function GET() { return { who: 'a', v: 1 }; }
`;

const ROUTE_A_V2 = `export function GET() { return { who: 'a', v: 2 }; }
`;

const ROUTE_B = `export function GET() { return { who: 'b' }; }
`;

const ROUTE_C = `export function GET() { return { who: 'c' }; }
`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll an HTTP GET until `pred` accepts the response (status + parsed body),
 * matching the existing watcher-test pattern: the fs-watcher rescan is async
 * and macOS coalesces events, so fresh requests are retried until the rescan
 * lands or the attempts run out (the last observation is returned either way).
 */
async function pollGet(
  url: string,
  pred: (status: number, body: unknown) => boolean,
  attempts = 40,
  intervalMs = 250,
): Promise<{ status: number; body: unknown }> {
  let last: { status: number; body: unknown } = { status: -1, body: undefined };
  for (let attempt = 0; attempt < attempts; attempt++) {
    const res = await fetch(url);
    let body: unknown;
    try { body = await res.json(); } catch { body = undefined; }
    last = { status: res.status, body };
    if (pred(res.status, body)) return last;
    await sleep(intervalMs);
  }
  return last;
}

let root: string;
let srv: Awaited<ReturnType<typeof startStandaloneServer>> | undefined;

async function boot(files: Record<string, string>): Promise<number> {
  root = await mkdtemp(join(tmpdir(), 'vura-standalone-rescan-'));
  await mkdir(join(root, 'src', 'api'), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(root, 'src', 'api', name), content);
  }
  const manifest = await buildManifest(root);
  srv = await startStandaloneServer(manifest, { port: 0, host: '127.0.0.1', projectRoot: root });
  return srv.port;
}

afterEach(async () => {
  await srv?.close();
  srv = undefined;
  await rm(root, { recursive: true, force: true });
});

describe('standalone vura dev — fs-watcher rescan rebuilds against the fresh manifest', () => {
  it('route DELETION: deleted route 404s and the rescan loop does not wedge (later edits still apply)', async () => {
    const port = await boot({ 'a.ts': ROUTE_A_V1, 'b.ts': ROUTE_B });

    // Sanity: both routes serve before the deletion.
    const a = await fetch(`http://127.0.0.1:${port}/api/a`);
    expect(a.status).toBe(200);
    expect(await a.json()).toEqual({ who: 'a', v: 1 });
    const b = await fetch(`http://127.0.0.1:${port}/api/b`);
    expect(b.status).toBe(200);

    // Delete b.ts → the rescan must rebuild WITHOUT it. (Pre-fix the rebuild
    // ran against the stale manifest, tried to esbuild the deleted file,
    // threw, and kept serving b with 200 forever.)
    await rm(join(root, 'src', 'api', 'b.ts'));
    const afterDelete = await pollGet(
      `http://127.0.0.1:${port}/api/b`,
      (status) => status === 404,
    );
    expect(afterDelete.status).toBe(404);

    // The loop must not be wedged: a LATER edit to a different file still
    // applies. (Pre-fix every subsequent rescan re-failed on the missing
    // b.ts, so this edit never took effect until a restart.)
    await writeFile(join(root, 'src', 'api', 'a.ts'), ROUTE_A_V2);
    const afterEdit = await pollGet(
      `http://127.0.0.1:${port}/api/a`,
      (status, body) => status === 200 && (body as { v?: number })?.v === 2,
    );
    expect(afterEdit.status).toBe(200);
    expect(afterEdit.body).toEqual({ who: 'a', v: 2 });
  }, 40000);

  it('route ADDITION: a new route serves after the first rescan (no second watcher event needed)', async () => {
    const port = await boot({ 'a.ts': ROUTE_A_V1 });

    // Sanity: c does not exist yet.
    const before = await fetch(`http://127.0.0.1:${port}/api/c`);
    expect(before.status).toBe(404);

    // Add c.ts → the rescan builds from nextManifest, which includes it, so
    // it serves as soon as ONE rescan completes. (Pre-fix the first rescan
    // built from the stale manifest — c 404'd until a second event fired.)
    await writeFile(join(root, 'src', 'api', 'c.ts'), ROUTE_C);
    const afterAdd = await pollGet(
      `http://127.0.0.1:${port}/api/c`,
      (status) => status === 200,
    );
    expect(afterAdd.status).toBe(200);
    expect(afterAdd.body).toEqual({ who: 'c' });
  }, 40000);
});
