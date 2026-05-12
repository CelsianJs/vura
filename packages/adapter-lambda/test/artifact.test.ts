import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { lambdaAdapter } from '../src/index.js';
import type { AdapterBuildContext, ApiRoute, RouteManifest } from '@celsian/then-core';

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

describe('lambdaAdapter deployment artifacts', () => {
  it('bundles TS route modules to executable JS and exposes req.body', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vura-lambda-artifact-'));
    try {
      mkdirSync(join(root, 'src', 'api'), { recursive: true });
      writeFileSync(join(root, 'src', 'api', 'echo.ts'), `import { HttpError } from '@celsian/then-core';

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
      await lambdaAdapter().buildEnd(ctx);

      const funcDir = join(outDir, 'lambda', 'api_echo_post');
      const entryPath = join(funcDir, 'index.js');
      const bundledRoutePath = join(funcDir, 'route.js');
      expect(existsSync(entryPath)).toBe(true);
      expect(existsSync(bundledRoutePath)).toBe(true);
      expect(readFileSync(entryPath, 'utf-8')).toContain("import * as routeMod from './route.js'");
      const bundledRoute = readFileSync(bundledRoutePath, 'utf-8');
      expect(bundledRoute).not.toContain('req: {');
      expect(bundledRoute).not.toContain("from '@celsian/then-core'");
      expect(bundledRoute).not.toContain('from \"@celsian/then-core\"');

      const result = runModuleJson(entryPath, `
const result = await mod.handler({
  version: '2.0',
  routeKey: 'POST /api/echo',
  rawPath: '/api/echo',
  rawQueryString: '',
  headers: { host: 'example.com', 'content-type': 'application/json' },
  body: JSON.stringify({ text: 'hello' }),
  isBase64Encoded: false,
  requestContext: {
    domainName: 'example.com',
    http: { method: 'POST', path: '/api/echo' },
  },
}, {});
console.log(JSON.stringify(result));
`);
      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body)).toEqual({
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
    const root = mkdtempSync(join(tmpdir(), 'vura-lambda-missing-'));
    try {
      const outDir = join(root, 'dist');
      const ctx: AdapterBuildContext = {
        serverEntry: join(outDir, 'server', 'entry.js'),
        clientDir: join(outDir, 'client'),
        manifest: manifest([route({ filePath: 'src/api/missing.ts', urlPattern: '/api/missing' })]),
        projectRoot: root,
        outDir,
      };
      await expect(lambdaAdapter().buildEnd(ctx)).rejects.toThrow(
        /Route source not found for src\/api\/missing\.ts:/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });


it('validates schemas and stops handler execution when onRequest throws', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vura-lambda-lifecycle-'));
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
export function GET() { return { handlerCalls, onResponseSeen: globalThis.__onResponseSeen === true }; }
`);

    const outDir = join(root, 'dist');
    await lambdaAdapter().buildEnd({
      serverEntry: join(outDir, 'server', 'entry.js'),
      clientDir: join(outDir, 'client'),
      manifest: manifest([route({ methods: ['POST', 'GET'] })]),
      projectRoot: root,
      outDir,
    });

    const entryPath = join(outDir, 'lambda', 'api_echo_post', 'index.js');
    const result = runModuleJson(entryPath, `
function event(body, headers = {}) { return {
  version: '2.0', routeKey: 'POST /api/echo', rawPath: '/api/echo', rawQueryString: '',
  headers: { host: 'example.com', 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body), isBase64Encoded: false,
  requestContext: { domainName: 'example.com', http: { method: 'POST', path: '/api/echo' } },
}; }
const invalid = await mod.handler(event({ ok: false }), {});
const blocked = await mod.handler(event({ ok: true }, { 'x-block': 'yes' }), {});
const ok = await mod.handler(event({ ok: true, redirect: true }), {});
console.log(JSON.stringify({ invalid, blocked, ok }));
`);
    expect(result.invalid.statusCode).toBe(400);
    expect(JSON.parse(result.invalid.body).code).toBe('VALIDATION_ERROR');
    expect(result.blocked.statusCode).toBe(500);
    expect(result.ok.statusCode).toBe(307);
    expect(result.ok.headers.location).toBe('/target');
    expect(result.ok.body).toBe('Redirecting to /target');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
