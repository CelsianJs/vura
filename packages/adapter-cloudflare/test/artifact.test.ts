import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { cloudflareAdapter } from '../src/index.js';
import type { AdapterBuildContext, ApiRoute, RouteManifest } from '@then/core';

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
      writeFileSync(join(root, 'src', 'api', 'echo.ts'), `import { HttpError } from '@then/core';

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
      expect(readFileSync(entryPath, 'utf-8')).toContain("from './routes/src_api_echo.js'");
      const bundledRoute = readFileSync(bundledRoutePath, 'utf-8');
      expect(bundledRoute).not.toContain('req: {');
      expect(bundledRoute).not.toContain("from '@then/core'");
      expect(bundledRoute).not.toContain('from \"@then/core\"');

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
