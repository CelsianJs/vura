/**
 * `cookieSession` in a Cloudflare Workers artifact.
 *
 * The documented auth story for a Vura app is `cookieSession()` in
 * `src/api/_hooks.ts`, and it could not be deployed to Workers at all. It
 * failed the build, because `auth.ts` imported `node:crypto` for a synchronous
 * HMAC and `@celsian/core` for the cookie serialiser, and neither resolves
 * under the `platform: 'neutral'` esbuild this adapter runs:
 *
 *   No matching export in "vura-core-runtime-shim:@celsian/vura-core"
 *   for import "cookieSession"
 *
 * Fixing the imports was necessary and not sufficient. The reply this adapter
 * hands a hook is hand-rolled and had no `headers` record, so the first thing
 * the hook did on a Worker was `new Proxy(undefined, ...)` — a TypeError in the
 * app's authorization layer, on every request, from a build that reported
 * success. The reply now carries `headers` and the response is built from
 * `reply.headers`, which is what makes the plain-object return path commit a
 * session at all.
 *
 * These run the emitted artifact under Node, which is where an automated test
 * can run it. That is not the same as running it in workerd, and the gap is the
 * whole failure mode, so the bundle is also asserted to contain no `node:`
 * import: under `platform: 'neutral'` a surviving one is what a Worker would
 * die on. The workerd run itself is in the branch's commit message.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { cloudflareAdapter } from '../src/index.js';
import type { AdapterBuildContext, ApiRoute, RouteManifest } from '@celsian/vura-core';

const SECRET = 'a-very-long-test-secret-32chars!!';

function runModuleJson(entryPath: string, body: string): any {
  const source = `const mod = await import(${JSON.stringify(pathToFileURL(entryPath).href)});
${body}`;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' }));
}

/** One request through the emitted worker, reported as status + set-cookie + body. */
function request(entryPath: string, path: string, cookie?: string): any {
  return runModuleJson(entryPath, `
const response = await mod.default.fetch(new Request('https://example.com${path}', {
  method: 'GET',
  headers: ${JSON.stringify(cookie ? { cookie } : {})},
}), {}, { waitUntil: () => {}, passThroughOnException: () => {} });
console.log(JSON.stringify({
  status: response.status,
  setCookie: response.headers.get('set-cookie'),
  body: await response.json(),
}));
`);
}

/** The name=value half of a Set-Cookie, ready to send back. */
function cookiePair(setCookie: string): string {
  return setCookie.split(';')[0]!;
}

function manifest(api: ApiRoute[]): RouteManifest {
  return { api, pages: [], layouts: [], timestamp: new Date().toISOString() };
}

const ROUTES: ApiRoute[] = [
  { filePath: 'src/api/session.ts', urlPattern: '/api/session', methods: ['GET'], kind: 'serverless', config: {} },
  { filePath: 'src/api/whoami.ts', urlPattern: '/api/whoami', methods: ['GET'], kind: 'serverless', config: {} },
  { filePath: 'src/api/asset.ts', urlPattern: '/api/asset', methods: ['GET'], kind: 'serverless', config: {} },
];

function scaffold(root: string): void {
  mkdirSync(join(root, 'src', 'api'), { recursive: true });
  writeFileSync(join(root, 'src', 'api', '_hooks.ts'), `import { cookieSession } from '@celsian/vura-core';
export const onRequest = cookieSession({ secret: ${JSON.stringify(SECRET)}, cookie: { secure: false } });
`);
  // A plain-object return: the path that never calls reply.json and is
  // therefore committed only through the reply.headers Proxy.
  writeFileSync(join(root, 'src', 'api', 'session.ts'), `export function GET(req: any) {
  const count = (req.session.count ?? 0) + 1;
  req.session.count = count;
  req.session.user = 'kirby';
  return { count, user: req.session.user };
}
`);
  // Reads the session and does not write it: no Set-Cookie should be emitted.
  writeFileSync(join(root, 'src', 'api', 'whoami.ts'), `export function GET(req: any, reply: any) {
  return reply.json({ user: req.session.user ?? null, count: req.session.count ?? null });
}
`);
  writeFileSync(join(root, 'src', 'api', 'asset.ts'), `import { getMimeType, parseRangeHeader } from '@celsian/vura-core';
export function GET(req: any) {
  return { mime: getMimeType(String(req.query.name ?? '')), range: parseRangeHeader('bytes=200-400', 1000) };
}
`);
}

async function buildWorker(root: string): Promise<string> {
  const outDir = join(root, 'dist');
  const ctx: AdapterBuildContext = {
    serverEntry: join(outDir, 'server', 'entry.js'),
    clientDir: join(outDir, 'client'),
    manifest: manifest(ROUTES),
    projectRoot: root,
    outDir,
  };
  // A compatibility date from before Cloudflare turned Node built-ins on by
  // default. Measured: at 2026-06-01 workerd has no Buffer, no process and no
  // node:crypto, which is the runtime the portable signer has to work on, and
  // is what a project pinning its date (as Cloudflare advises) actually gets.
  await cloudflareAdapter({ name: 'test-worker', compatibilityDate: '2026-06-01' }).buildEnd(ctx);
  return join(outDir, 'cloudflare');
}

describe('cookieSession in a Cloudflare Workers artifact', () => {
  it('builds, signs, round-trips and rejects a tampered cookie', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vura-cf-cookiesession-'));
    try {
      scaffold(root);
      const workerDir = await buildWorker(root);
      const entry = join(workerDir, 'entry.js');

      // Nothing Node-shaped survived the bundle. The build succeeding is the
      // first half of the claim; this is the half that would still be false if
      // an import had been made external rather than removed.
      for (const file of ['hooks.js', 'routes/src_api_session.js', 'routes/src_api_asset.js']) {
        expect(readFileSync(join(workerDir, file), 'utf-8'), file).not.toMatch(/from\s*["']node:/);
      }
      expect(readFileSync(join(workerDir, 'wrangler.toml'), 'utf-8')).not.toContain('nodejs_compat');

      // A fresh session, committed from a handler that returned a plain object.
      const first = request(entry, '/api/session');
      expect(first.status).toBe(200);
      expect(first.body).toEqual({ count: 1, user: 'kirby' });
      expect(first.setCookie, 'a mutated session must emit Set-Cookie').toMatch(/^vura_session=/);
      expect(first.setCookie).toContain('HttpOnly');
      expect(first.setCookie).toContain('Path=/');

      // The signature is the one node:crypto would have produced, so a session
      // issued by a Node deployment of the same app is the same string.
      const value = decodeURIComponent(cookiePair(first.setCookie).slice('vura_session='.length));
      const dot = value.lastIndexOf('.');
      expect(createHmac('sha256', SECRET).update(value.slice(0, dot)).digest('base64url'))
        .toBe(value.slice(dot + 1));

      // Sent back, verified, read.
      const second = request(entry, '/api/session', cookiePair(first.setCookie));
      expect(second.body).toEqual({ count: 2, user: 'kirby' });

      // Read without writing: no Set-Cookie. Re-issuing an unchanged session on
      // every request is the bug this half of the hook exists to avoid.
      const read = request(entry, '/api/whoami', cookiePair(second.setCookie));
      expect(read.body).toEqual({ user: 'kirby', count: 2 });
      expect(read.setCookie).toBeNull();

      // One character of the signature changed: the session is discarded rather
      // than trusted, which is the whole point of signing it.
      const tampered = cookiePair(first.setCookie).replace(/.$/, m => (m === 'A' ? 'B' : 'A'));
      const forged = request(entry, '/api/whoami', tampered);
      expect(forged.body).toEqual({ user: null, count: null });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('runs the two streaming helpers that need no filesystem', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vura-cf-streamhelpers-'));
    try {
      scaffold(root);
      const entry = join(await buildWorker(root), 'entry.js');
      // A Worker serving an R2 object needs both of these, and both were
      // excluded only because they shared a module with node:fs.
      expect(request(entry, '/api/asset?name=/img/logo.SVG').body).toEqual({
        mime: 'image/svg+xml',
        range: { start: 200, end: 400 },
      });
      expect(request(entry, '/api/asset?name=notes').body.mime).toBe('application/octet-stream');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
