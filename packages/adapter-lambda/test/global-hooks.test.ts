/**
 * The conventional global hooks file, in an AWS Lambda artifact.
 *
 * `src/api/_hooks.ts` is documented as the place an app-wide auth check, an
 * access log or a CORS header goes, and core wires it into both the hot server
 * and the generated `dist/functions/` output. This adapter emitted one
 * self-contained handler per route+method and read only that route's own hook
 * exports, so the file reached neither the function directory nor the handler:
 * an app deployed here lost its global hooks with no error and no warning.
 * Proven inside the real public.ecr.aws/lambda/nodejs:22 runtime before the
 * fix — `GET /api/secret` answered 200 with the protected body while the same
 * build's `dist/functions/` output answered 401.
 *
 * These assertions run the emitted handler, not the generator's output text:
 * the whole class of bug is a passing unit test over a wrong bundle. The
 * Cloudflare adapter carries the matching file, so the pair going out of step
 * shows up as a failure.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { lambdaAdapter } from '../src/index.js';
import type { AdapterBuildContext, ApiRoute, RouteManifest } from '@celsian/vura-core';

function runModuleJson(entryPath: string, body: string): any {
  const source = `const mod = await import(${JSON.stringify(pathToFileURL(entryPath).href)});
${body}`;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' }));
}

/** An API Gateway v2 event, as the deployed function receives it. */
function event(method: string, path: string, headers: Record<string, string> = {}, body?: string): string {
  return JSON.stringify({
    version: '2.0',
    routeKey: `${method} ${path}`,
    rawPath: path,
    rawQueryString: '',
    headers: { host: 'example.com', ...headers },
    body,
    isBase64Encoded: false,
    requestContext: { domainName: 'example.com', http: { method, path } },
  });
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

async function buildLambda(root: string, api: ApiRoute[]): Promise<string> {
  const outDir = join(root, 'dist');
  const ctx: AdapterBuildContext = {
    serverEntry: join(outDir, 'server', 'entry.js'),
    clientDir: join(outDir, 'client'),
    manifest: manifest(api),
    projectRoot: root,
    outDir,
  };
  await lambdaAdapter().buildEnd(ctx);
  return join(outDir, 'lambda');
}

describe('lambdaAdapter global hooks file', () => {
  it('bundles src/api/_hooks.ts into each function and runs it around every request', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vura-lambda-globalhooks-'));
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

      const lambdaDir = await buildLambda(root, [route()]);
      const funcDir = join(lambdaDir, 'api_secret_get');
      // A Lambda function ships from its own CodeUri and cannot reach a
      // sibling's files, so each function needs its own copy. Asserted after
      // buildEnd returns, which is after the stale-output sweep: a hooks.js
      // the sweep deleted would look, from outside, exactly like a hooks.js
      // that was never bundled.
      expect(existsSync(join(funcDir, 'hooks.js'))).toBe(true);

      const result = runModuleJson(join(funcDir, 'index.js'), `
const result = await mod.handler(${event('GET', '/api/secret')}, {});
console.log(JSON.stringify({
  result,
  handlerRan: globalThis.__handlerRan === true,
  onResponse: globalThis.__onResponse ?? null,
}));
`);
      expect(result.result.statusCode).toBe(401);
      expect(result.result.headers['x-global-hook']).toBe('ran');
      expect(JSON.parse(result.result.body)).toEqual({ error: 'Unauthorized by global hook' });
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
    // write an app-wide auth check. A function's req.headers was a plain
    // object, so that snippet threw — a hooks file is written once and deployed
    // to every target, and this is the one target where the documented spelling
    // did not exist.
    const root = mkdtempSync(join(tmpdir(), 'vura-lambda-hookheaders-'));
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

      const lambdaDir = await buildLambda(root, [route()]);
      const result = runModuleJson(join(lambdaDir, 'api_secret_get', 'index.js'), `
const denied = await mod.handler(${event('GET', '/api/secret')}, {});
const allowed = await mod.handler(${event('GET', '/api/secret', { authorization: 'Bearer t' })}, {});
console.log(JSON.stringify({ denied, allowed }));
`);
      expect(result.denied.statusCode).toBe(401);
      expect(JSON.parse(result.denied.body)).toEqual({ error: 'Unauthorized' });
      expect(result.allowed.statusCode).toBe(200);
      expect(JSON.parse(result.allowed.body)).toEqual({
        viaIndex: 'Bearer t', keys: false, has: true, missing: null,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs global hooks before the route\'s own, in each phase', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vura-lambda-hookorder-'));
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

      const lambdaDir = await buildLambda(root, [route()]);
      const result = runModuleJson(join(lambdaDir, 'api_secret_get', 'index.js'), `
const result = await mod.handler(${event('GET', '/api/secret')}, {});
console.log(JSON.stringify({ statusCode: result.statusCode, order: globalThis.__order }));
`);
      expect(result.statusCode).toBe(200);
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
    const root = mkdtempSync(join(tmpdir(), 'vura-lambda-hookvalidation-'));
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

      const lambdaDir = await buildLambda(root, [route({ methods: ['POST'] })]);
      const result = runModuleJson(join(lambdaDir, 'api_secret_post', 'index.js'), `
const unauthed = await mod.handler(${event('POST', '/api/secret', { 'content-type': 'application/json' }, '{}')}, {});
const authed = await mod.handler(${event('POST', '/api/secret', { 'content-type': 'application/json', 'x-auth': 'yes' }, '{}')}, {});
console.log(JSON.stringify({ unauthed, authed, seen: globalThis.__seen }));
`);
      // The auth hook decides first: no schema report for a caller who was
      // never entitled to submit a body.
      expect(result.unauthed.statusCode).toBe(401);
      expect(JSON.parse(result.unauthed.body)).toEqual({ error: 'Unauthorized' });
      // A caller who passes the hook still gets the 400 unchanged.
      expect(result.authed.statusCode).toBe(400);
      expect(JSON.parse(result.authed.body).code).toBe('VALIDATION_ERROR');
      // And both outcomes reached the access log.
      expect(result.seen).toEqual([401, 400]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails the build when the hooks file cannot be bundled for a function', async () => {
    // The deliberate choice: loud, not degraded. A hooks file is where an
    // app-wide authorization check lives, so skipping an unbuildable one would
    // ship functions whose auth layer is missing while the build reports
    // success — the same silent failure this wiring exists to close.
    const root = mkdtempSync(join(tmpdir(), 'vura-lambda-hooksunbuildable-'));
    try {
      mkdirSync(join(root, 'src', 'api'), { recursive: true });
      // startVuraServer is deliberately off the runtime-shim allowlist for
      // serverless targets (includeServerRuntime: false) — there is no Node
      // server inside a function bundle.
      writeFileSync(join(root, 'src', 'api', '_hooks.ts'), `import { startVuraServer } from '@celsian/vura-core';
export const onRequest = [() => { void startVuraServer; }];
`);
      writeFileSync(join(root, 'src', 'api', 'secret.ts'), `export function GET(_req: any, reply: any) { return reply.json({ ok: true }); }\n`);

      await expect(buildLambda(root, [route()])).rejects.toThrow(
        /global hooks file src\/api\/_hooks\.ts could not be bundled for AWS Lambda/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('gives a task function no global hooks', async () => {
    // A task function is invoked by EventBridge, never through the HTTP
    // lifecycle. Core applies the same rule: hooks.js goes to serverless
    // routes only.
    //
    // Unlike its neighbours this one also passes on the pre-fix adapter, which
    // emitted no hooks anywhere. It guards against over-applying the fix, not
    // against the bug: read a green here as "still scoped", not as evidence.
    const root = mkdtempSync(join(tmpdir(), 'vura-lambda-hookstasks-'));
    try {
      mkdirSync(join(root, 'src', 'api', 'tasks'), { recursive: true });
      writeFileSync(join(root, 'src', 'api', '_hooks.ts'), `export const onRequest = [() => {}];\n`);
      writeFileSync(join(root, 'src', 'api', 'tasks', 'hourly.ts'), `export async function POST() { return 'hourly'; }\n`);

      const lambdaDir = await buildLambda(root, [
        { filePath: 'src/api/tasks/hourly.ts', urlPattern: '/api/tasks/hourly', methods: ['POST'], kind: 'task', config: { schedule: '0 * * * *' } } as ApiRoute,
      ]);
      expect(existsSync(join(lambdaDir, 'task_api_tasks_hourly', 'hooks.js'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
