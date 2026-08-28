/**
 * The conventional global hooks file, in a Cloudflare Workers artifact.
 *
 * `src/api/_hooks.ts` is documented as the place an app-wide auth check, an
 * access log or a CORS header goes, and core wires it into both the hot server
 * and the generated `dist/functions/` output. This adapter bundled only
 * `[...routes, ...taskRoutes]` and read per-route `handlers.hooks`, so the file
 * reached neither the worker directory nor the entry: an app deployed here lost
 * its global hooks with no error and no warning. Proven under workerd before
 * the fix — `GET /api/secret` answered 200 with the protected body while the
 * same build's `dist/functions/` output answered 401.
 *
 * These assertions run the emitted entry, not the generator's output text: the
 * whole class of bug is a passing unit test over a wrong bundle.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { cloudflareAdapter } from '../src/index.js';
import type { AdapterBuildContext, ApiRoute, RouteManifest } from '@celsian/vura-core';

function runModuleJson(entryPath: string, body: string): any {
  const source = `const mod = await import(${JSON.stringify(pathToFileURL(entryPath).href)});
${body}`;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' }));
}

function route(overrides: Partial<ApiRoute> = {}): ApiRoute {
  return {
    filePath: 'src/api/secret.ts',
    urlPattern: '/api/secret',
    methods: ['GET'],
    kind: 'serverless',
    config: {},
    ...overrides,
  };
}

function manifest(api: ApiRoute[]): RouteManifest {
  return { api, pages: [], layouts: [], timestamp: new Date().toISOString() };
}

async function buildWorker(root: string, api: ApiRoute[]): Promise<string> {
  const outDir = join(root, 'dist');
  const ctx: AdapterBuildContext = {
    serverEntry: join(outDir, 'server', 'entry.js'),
    clientDir: join(outDir, 'client'),
    manifest: manifest(api),
    projectRoot: root,
    outDir,
  };
  await cloudflareAdapter({ name: 'test-worker', compatibilityDate: '2026-05-10' }).buildEnd(ctx);
  return join(outDir, 'cloudflare');
}

describe('cloudflareAdapter global hooks file', () => {
  it('bundles src/api/_hooks.ts and runs it around every request', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vura-cf-globalhooks-'));
    try {
      mkdirSync(join(root, 'src', 'api'), { recursive: true });
      writeFileSync(join(root, 'src', 'api', '_hooks.ts'), `
export const onRequest = [
  (req: any, reply: any) => { reply.header('x-global-hook', 'ran'); },
  (req: any, reply: any) => {
    if ((req.url || '').endsWith('/api/secret')) {
      return reply.status(401).json({ error: 'Unauthorized by global hook' });
    }
  },
];
export const onResponse = [
  (req: any, _reply: any, info: any) => { (globalThis as any).__onResponse = info.statusCode; },
];
`);
      writeFileSync(join(root, 'src', 'api', 'secret.ts'), `
export function GET(_req: any, reply: any) {
  (globalThis as any).__handlerRan = true;
  return reply.json({ secret: 'TOP-SECRET-VALUE' });
}
`);

      const workerDir = await buildWorker(root, [route()]);
      // The file has to be in the worker directory at all — it was not.
      expect(existsSync(join(workerDir, 'hooks.js'))).toBe(true);

      const result = runModuleJson(join(workerDir, 'entry.js'), `
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
const response = await mod.default.fetch(new Request('https://example.com/api/secret'), {}, ctx);
console.log(JSON.stringify({
  status: response.status,
  header: response.headers.get('x-global-hook'),
  body: await response.text(),
  handlerRan: globalThis.__handlerRan === true,
  onResponse: globalThis.__onResponse ?? null,
}));
`);
      expect(result.status).toBe(401);
      expect(result.header).toBe('ran');
      expect(JSON.parse(result.body)).toEqual({ error: 'Unauthorized by global hook' });
      // The security half of the contract: a hook that answered stops the
      // handler. Returning the hook's 401 while the handler has already read
      // the record, written the row or spent the paid API call is not a guard.
      expect(result.handlerRan).toBe(false);
      expect(result.onResponse).toBe(401);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('answers req.headers.get(), so the reference\'s own auth snippet works here', async () => {
    // The hooks reference prints req.headers.get('authorization') as the way to
    // write an app-wide auth check. A worker's req.headers was a plain object,
    // so that snippet threw — a hooks file is written once and deployed to
    // every target, and this is the one target where the documented spelling
    // did not exist.
    const root = mkdtempSync(join(tmpdir(), 'vura-cf-hookheaders-'));
    try {
      mkdirSync(join(root, 'src', 'api'), { recursive: true });
      writeFileSync(join(root, 'src', 'api', '_hooks.ts'), `
export const onRequest = [
  (req: any, reply: any) => {
    if (!req.headers.get('authorization')) {
      return reply.status(401).json({ error: 'Unauthorized' });
    }
  },
];
`);
      writeFileSync(join(root, 'src', 'api', 'secret.ts'), `
export function GET(req: any, reply: any) {
  return reply.json({
    // index access still works, and the accessor did not become an own key
    viaIndex: req.headers['authorization'],
    keys: Object.keys(req.headers).includes('get'),
    has: req.headers.has('authorization'),
    missing: req.headers.get('x-nope'),
  });
}
`);

      const workerDir = await buildWorker(root, [route()]);
      const result = runModuleJson(join(workerDir, 'entry.js'), `
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
const denied = await mod.default.fetch(new Request('https://example.com/api/secret'), {}, ctx);
const allowed = await mod.default.fetch(new Request('https://example.com/api/secret', { headers: { authorization: 'Bearer t' } }), {}, ctx);
console.log(JSON.stringify({
  denied: { status: denied.status, body: await denied.json() },
  allowed: { status: allowed.status, body: await allowed.json() },
}));
`);
      expect(result.denied.status).toBe(401);
      expect(result.denied.body).toEqual({ error: 'Unauthorized' });
      expect(result.allowed.status).toBe(200);
      expect(result.allowed.body).toEqual({
        viaIndex: 'Bearer t', keys: false, has: true, missing: null,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs global hooks before the route\'s own, in each phase', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vura-cf-hookorder-'));
    try {
      mkdirSync(join(root, 'src', 'api'), { recursive: true });
      writeFileSync(join(root, 'src', 'api', '_hooks.ts'), `
export const onRequest = [() => { ((globalThis as any).__order ||= []).push('global-request'); }];
export const onResponse = [() => { ((globalThis as any).__order ||= []).push('global-response'); }];
`);
      writeFileSync(join(root, 'src', 'api', 'secret.ts'), `
export const hooks = {
  onRequest: [() => { (globalThis as any).__order.push('route-request'); }],
  onResponse: [() => { (globalThis as any).__order.push('route-response'); }],
};
export function GET(_req: any, reply: any) {
  (globalThis as any).__order.push('handler');
  return reply.json({ ok: true });
}
`);

      const workerDir = await buildWorker(root, [route()]);
      const result = runModuleJson(join(workerDir, 'entry.js'), `
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
const response = await mod.default.fetch(new Request('https://example.com/api/secret'), {}, ctx);
console.log(JSON.stringify({ status: response.status, order: globalThis.__order }));
`);
      expect(result.status).toBe(200);
      expect(result.order).toEqual([
        'global-request', 'route-request', 'handler', 'global-response', 'route-response',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('lets a global hook answer before schema validation, and reports a rejected request to onResponse', async () => {
    // Validation used to run in front of the hooks and return early, so an
    // unauthenticated caller got the route's 400 schema report instead of the
    // hooks file's 401, and onResponse — documented as running once per
    // request whatever the outcome — never saw a rejected request at all.
    const root = mkdtempSync(join(tmpdir(), 'vura-cf-hookvalidation-'));
    try {
      mkdirSync(join(root, 'src', 'api'), { recursive: true });
      writeFileSync(join(root, 'src', 'api', '_hooks.ts'), `
export const onRequest = [
  (req: any, reply: any) => {
    if (req.headers['x-auth'] !== 'yes') return reply.status(401).json({ error: 'Unauthorized' });
  },
];
export const onResponse = [
  (_req: any, _reply: any, info: any) => { ((globalThis as any).__seen ||= []).push(info.statusCode); },
];
`);
      writeFileSync(join(root, 'src', 'api', 'secret.ts'), `
export const schema = {
  body: { safeParse: () => ({ success: false, error: { issues: [{ path: ['ok'], message: 'Expected true' }] } }) },
};
export function POST(_req: any, reply: any) { return reply.json({ ok: true }); }
`);

      const workerDir = await buildWorker(root, [route({ methods: ['POST'] })]);
      const result = runModuleJson(join(workerDir, 'entry.js'), `
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
function request(headers) { return new Request('https://example.com/api/secret', {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}',
}); }
const unauthed = await mod.default.fetch(request({}), {}, ctx);
const authed = await mod.default.fetch(request({ 'x-auth': 'yes' }), {}, ctx);
console.log(JSON.stringify({
  unauthed: { status: unauthed.status, body: await unauthed.json() },
  authed: { status: authed.status, body: await authed.json() },
  seen: globalThis.__seen,
}));
`);
      // The auth hook decides first: no schema report for a caller who was
      // never entitled to submit a body.
      expect(result.unauthed.status).toBe(401);
      expect(result.unauthed.body).toEqual({ error: 'Unauthorized' });
      // A caller who passes the hook still gets the 400 unchanged.
      expect(result.authed.status).toBe(400);
      expect(result.authed.body.code).toBe('VALIDATION_ERROR');
      // And both outcomes reached the access log.
      expect(result.seen).toEqual([401, 400]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails the build when the hooks file cannot be bundled for Workers', async () => {
    // The deliberate choice: loud, not degraded. A hooks file is where an
    // app-wide authorization check lives, so skipping an unbuildable one would
    // ship a worker whose auth layer is missing while the build reports
    // success — the same silent failure this wiring exists to close.
    const root = mkdtempSync(join(tmpdir(), 'vura-cf-hooksunbuildable-'));
    try {
      mkdirSync(join(root, 'src', 'api'), { recursive: true });
      // cookieSession is the auth reference's own example of a hook that
      // cannot be bundled here: it signs with node:crypto's synchronous HMAC,
      // so it sits outside the allowlist a neutral-platform worker bundle
      // gets. That page already tells the reader importing it from
      // src/api/_hooks.ts "fails the build" — which was not true while the
      // adapter never bundled the file at all. This pins the claim.
      writeFileSync(join(root, 'src', 'api', '_hooks.ts'), `import { cookieSession } from '@celsian/vura-core';
export const onRequest = [cookieSession({ secret: 'x'.repeat(32) })];
`);
      writeFileSync(join(root, 'src', 'api', 'secret.ts'), `export function GET(_req: any, reply: any) { return reply.json({ ok: true }); }\n`);

      await expect(buildWorker(root, [route()])).rejects.toThrow(
        /global hooks file src\/api\/_hooks\.ts could not be bundled for Cloudflare Workers/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('drops a hooks bundle left by an earlier build once the project deletes the file', async () => {
    // hooks.js sits beside the entry rather than in routes/, so the adapter's
    // stale-output sweep does not reach it. Left alone it would be dead weight
    // shipped to Cloudflare on every deploy after the file was removed.
    const root = mkdtempSync(join(tmpdir(), 'vura-cf-hooksstale-'));
    try {
      mkdirSync(join(root, 'src', 'api'), { recursive: true });
      writeFileSync(join(root, 'src', 'api', '_hooks.ts'), `export const onRequest = [() => {}];\n`);
      writeFileSync(join(root, 'src', 'api', 'secret.ts'), `export function GET(_req: any, reply: any) { return reply.json({ ok: true }); }\n`);

      const workerDir = await buildWorker(root, [route()]);
      expect(existsSync(join(workerDir, 'hooks.js'))).toBe(true);

      rmSync(join(root, 'src', 'api', '_hooks.ts'));
      await buildWorker(root, [route()]);
      expect(existsSync(join(workerDir, 'hooks.js'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('emits no hooks import for a worker group that only carries task routes', async () => {
    // A task worker runs through `scheduled`, which never enters the fetch
    // lifecycle. Core applies the same rule: hooks.js goes to serverless
    // routes only.
    //
    // Unlike its neighbours this one also passes on the pre-fix adapter, which
    // emitted no hooks anywhere. It guards against over-applying the fix, not
    // against the bug: read a green here as "still scoped", not as evidence.
    const root = mkdtempSync(join(tmpdir(), 'vura-cf-hookstasks-'));
    try {
      mkdirSync(join(root, 'src', 'api', 'tasks'), { recursive: true });
      writeFileSync(join(root, 'src', 'api', '_hooks.ts'), `export const onRequest = [() => {}];\n`);
      writeFileSync(join(root, 'src', 'api', 'tasks', 'hourly.ts'), `export async function POST() { return 'hourly'; }\n`);

      const workerDir = await buildWorker(root, [
        { filePath: 'src/api/tasks/hourly.ts', urlPattern: '/api/tasks/hourly', methods: ['POST'], kind: 'task', config: { schedule: '0 * * * *' } } as ApiRoute,
      ]);
      expect(existsSync(join(workerDir, 'hooks.js'))).toBe(false);

      const result = runModuleJson(join(workerDir, 'entry.js'), `
const results = await mod.default.scheduled({ cron: '0 * * * *' }, {}, { waitUntil: () => {}, passThroughOnException: () => {} });
console.log(JSON.stringify(results));
`);
      expect(result[0]).toMatchObject({ task: 'tasks.hourly', status: 'completed', result: 'hourly' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
