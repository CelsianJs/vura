import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
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
    filePath: 'src/api/echo.ts',
    urlPattern: '/api/echo',
    methods: ['POST'],
    kind: 'serverless',
    config: {},
    ...overrides,
  };
}

function manifest(api: ApiRoute[]): RouteManifest {
  return { api, pages: [], layouts: [], timestamp: new Date().toISOString() };
}

describe('cloudflareAdapter deployment artifacts', () => {
  it('bundles TS route modules to executable JS and exposes req.body', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vura-cf-artifact-'));
    try {
      mkdirSync(join(root, 'src', 'api'), { recursive: true });
      writeFileSync(join(root, 'src', 'api', 'echo.ts'), `import { HttpError } from '@celsian/vura-core';

export async function POST(req: { body: unknown; parsedBody: unknown }) {
  return { body: req.body, parsedBody: req.parsedBody, marker: new HttpError(418, 'INTERNAL_ERROR', 'teapot').name };
}
`);

      const outDir = join(root, 'dist');
      const ctx: AdapterBuildContext = {
        serverEntry: join(outDir, 'server', 'entry.js'),
        clientDir: join(outDir, 'client'),
        manifest: manifest([route()]),
        projectRoot: root,
        outDir,
      };
      await cloudflareAdapter({ name: 'test-worker', compatibilityDate: '2026-05-10' }).buildEnd(ctx);

      const entryPath = join(outDir, 'cloudflare', 'entry.js');
      const bundledRoutePath = join(outDir, 'cloudflare', 'routes', 'src_api_echo.js');
      expect(existsSync(entryPath)).toBe(true);
      expect(existsSync(bundledRoutePath)).toBe(true);
      expect(
        JSON.parse(readFileSync(join(outDir, 'cloudflare', 'package.json'), 'utf-8')),
      ).toEqual({ type: 'module' });
      expect(readFileSync(entryPath, 'utf-8')).toContain("from './routes/src_api_echo.js'");
      const bundledRoute = readFileSync(bundledRoutePath, 'utf-8');
      expect(bundledRoute).not.toContain('req: {');
      expect(bundledRoute).not.toContain("from '@celsian/vura-core'");
      expect(bundledRoute).not.toContain('from \"@celsian/vura-core\"');

      const result = runModuleJson(entryPath, `
const response = await mod.default.fetch(new Request('https://example.com/api/echo', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: 'hello' }),
}), {}, { waitUntil: () => {}, passThroughOnException: () => {} });
console.log(JSON.stringify({ status: response.status, body: await response.json() }));
`);
      expect(result.status).toBe(200);
      expect(result.body).toEqual({
        body: { text: 'hello' },
        parsedBody: { text: 'hello' },
        marker: 'HttpError',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

  it('fails with route context when a source file is missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vura-cf-missing-'));
    try {
      const outDir = join(root, 'dist');
      const ctx: AdapterBuildContext = {
        serverEntry: join(outDir, 'server', 'entry.js'),
        clientDir: join(outDir, 'client'),
        manifest: manifest([route({ filePath: 'src/api/missing.ts', urlPattern: '/api/missing' })]),
        projectRoot: root,
        outDir,
      };
      await expect(cloudflareAdapter({ name: 'test-worker' }).buildEnd(ctx)).rejects.toThrow(
        /Route source not found for src\/api\/missing\.ts:/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });


it('validates schemas and stops handler execution when onRequest throws', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vura-cf-lifecycle-'));
  try {
    mkdirSync(join(root, 'src', 'api'), { recursive: true });
    writeFileSync(join(root, 'src', 'api', 'echo.ts'), `
let handlerCalls = 0;
export const schema = {
  body: {
    safeParse(input) {
      return input && input.ok === true
        ? { success: true, data: input }
        : { success: false, error: { issues: [{ path: ['ok'], message: 'Expected true', code: 'invalid_literal' }] } };
    }
  }
};
export const hooks = {
  onRequest: [async (req) => { if (req.headers['x-block'] === 'yes') throw new Error('blocked'); }],
  onResponse: [async () => { globalThis.__onResponseSeen = true; }]
};
export async function POST(req, reply) { handlerCalls++; if (req.body.redirect) return reply.redirect('/target', 307); return { handlerCalls }; }
`);

    const outDir = join(root, 'dist');
    await cloudflareAdapter({ name: 'test-worker', compatibilityDate: '2026-05-10' }).buildEnd({
      serverEntry: join(outDir, 'server', 'entry.js'),
      clientDir: join(outDir, 'client'),
      manifest: manifest([route()]),
      projectRoot: root,
      outDir,
    });

    const result = runModuleJson(join(outDir, 'cloudflare', 'entry.js'), `
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
function request(body, headers = {}) { return new Request('https://example.com/api/echo', {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
}); }
const invalidResponse = await mod.default.fetch(request({ ok: false }), {}, ctx);
const blockedResponse = await mod.default.fetch(request({ ok: true }, { 'x-block': 'yes' }), {}, ctx);
const okResponse = await mod.default.fetch(request({ ok: true, redirect: true }), {}, ctx);
console.log(JSON.stringify({
  invalid: { status: invalidResponse.status, body: await invalidResponse.json() },
  blocked: { status: blockedResponse.status, body: await blockedResponse.json() },
  ok: { status: okResponse.status, location: okResponse.headers.get('location'), body: await okResponse.text() },
}));
`);
    expect(result.invalid.status).toBe(400);
    expect(result.invalid.body.code).toBe('VALIDATION_ERROR');
    expect(result.blocked.status).toBe(500);
    expect(result.ok).toEqual({ status: 307, location: '/target', body: 'Redirecting to /target' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('lets only Vura errors choose their own status', async () => {
  // A library error that happens to carry a statusCode must not pick its own
  // HTTP status: picking a non-500 also opts it out of the sanitisation below,
  // which is how a connection string reaches the client.
  const root = mkdtempSync(join(tmpdir(), 'vura-cf-status-'));
  try {
    mkdirSync(join(root, 'src', 'api'), { recursive: true });
    writeFileSync(join(root, 'src', 'api', 'echo.ts'), `import { notFound } from '@celsian/vura-core';

export async function GET() {
  throw notFound('No such thing');
}
export async function POST() {
  const err = new Error('connect ECONNREFUSED postgres://admin:hunter2@db.internal:5432');
  err.statusCode = 400;
  throw err;
}
`);

    const outDir = join(root, 'dist');
    await cloudflareAdapter({ name: 'test-worker', compatibilityDate: '2026-05-10' }).buildEnd({
      serverEntry: join(outDir, 'server', 'entry.js'),
      clientDir: join(outDir, 'client'),
      manifest: manifest([route({ methods: ['GET', 'POST'] })]),
      projectRoot: root,
      outDir,
    });

    const result = runModuleJson(join(outDir, 'cloudflare', 'entry.js'), `
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
const deliberate = await mod.default.fetch(new Request('https://example.com/api/echo'), {}, ctx);
const accidental = await mod.default.fetch(new Request('https://example.com/api/echo', { method: 'POST' }), {}, ctx);
console.log(JSON.stringify({
  deliberate: { status: deliberate.status },
  accidental: { status: accidental.status, body: await accidental.text() },
}));
`);
    expect(result.deliberate.status).toBe(404);
    expect(result.accidental.status).toBe(500);
    expect(result.accidental.body).not.toContain('hunter2');
    expect(result.accidental.body).not.toContain('db.internal');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('query coercion: the validated output lands on both req.parsedQuery and req.query', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vura-cf-query-'));
  try {
    mkdirSync(join(root, 'src', 'api'), { recursive: true });
    writeFileSync(join(root, 'src', 'api', 'echo.ts'), `
export const schema = {
  query: {
    safeParse(input) {
      const n = Number(input.page);
      if (Number.isNaN(n)) {
        return { success: false, error: { issues: [{ path: ['page'], message: 'Expected number', code: 'invalid_type' }] } };
      }
      return { success: true, data: { page: n } };
    }
  }
};
export async function GET(req) {
  return {
    rawPage: req.query.page,
    rawType: typeof req.query.page,
    parsedQuery: req.parsedQuery,
    parsedType: typeof req.parsedQuery.page,
    validatedQuery: req.validated.query,
  };
}
`);

    const outDir = join(root, 'dist');
    await cloudflareAdapter({ name: 'test-worker', compatibilityDate: '2026-05-10' }).buildEnd({
      serverEntry: join(outDir, 'server', 'entry.js'),
      clientDir: join(outDir, 'client'),
      manifest: manifest([route({ methods: ['GET'] })]),
      projectRoot: root,
      outDir,
    });

    const result = runModuleJson(join(outDir, 'cloudflare', 'entry.js'), `
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
const okResponse = await mod.default.fetch(new Request('https://example.com/api/echo?page=2'), {}, ctx);
const invalidResponse = await mod.default.fetch(new Request('https://example.com/api/echo?page=abc'), {}, ctx);
console.log(JSON.stringify({
  ok: { status: okResponse.status, body: await okResponse.json() },
  invalid: { status: invalidResponse.status, body: await invalidResponse.json() },
}));
`);
    expect(result.ok.status).toBe(200);
    // req.query is the validated output, not the raw string from the URL:
    // reading the ergonomic property must not hand back input that skipped the
    // schema (matches the celsian runtime).
    expect(result.ok.body.rawPage).toBe(2);
    expect(result.ok.body.rawType).toBe('number');
    // the same value is on req.parsedQuery, the explicitly-typed alias
    expect(result.ok.body.parsedQuery).toEqual({ page: 2 });
    expect(result.ok.body.parsedType).toBe('number');
    // req.validated.query still carries the coerced data
    expect(result.ok.body.validatedQuery).toEqual({ page: 2 });
    // invalid query → 400 unchanged
    expect(result.invalid.status).toBe(400);
    expect(result.invalid.body.code).toBe('VALIDATION_ERROR');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('runs only scheduled tasks matching the Cloudflare cron event', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vura-cf-cron-'));
  try {
    mkdirSync(join(root, 'src', 'api', 'tasks'), { recursive: true });
    writeFileSync(join(root, 'src', 'api', 'tasks', 'hourly.ts'), `export async function POST() { return 'hourly'; }`);
    writeFileSync(join(root, 'src', 'api', 'tasks', 'daily.ts'), `export async function POST() { return 'daily'; }`);
    const outDir = join(root, 'dist');
    await cloudflareAdapter({ name: 'test-worker', compatibilityDate: '2026-05-10' }).buildEnd({
      serverEntry: join(outDir, 'server', 'entry.js'),
      clientDir: join(outDir, 'client'),
      manifest: manifest([
        { filePath: 'src/api/tasks/hourly.ts', urlPattern: '/api/tasks/hourly', methods: ['POST'], kind: 'task', config: { schedule: '0 * * * *' } } as ApiRoute,
        { filePath: 'src/api/tasks/daily.ts', urlPattern: '/api/tasks/daily', methods: ['POST'], kind: 'task', config: { schedule: '0 0 * * *' } } as ApiRoute,
      ]),
      projectRoot: root,
      outDir,
    });
    const result = runModuleJson(join(outDir, 'cloudflare', 'entry.js'), `
const results = await mod.default.scheduled({ cron: '0 * * * *' }, {}, { waitUntil: () => {}, passThroughOnException: () => {} });
console.log(JSON.stringify(results));
`);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ task: 'tasks.hourly', status: 'completed', result: 'hourly' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
