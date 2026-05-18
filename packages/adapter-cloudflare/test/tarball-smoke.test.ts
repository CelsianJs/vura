import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { AdapterBuildContext, ApiRoute, RouteManifest } from '@celsian/vura-core';

const repoRoot = resolve(__dirname, '../../..');

function packPackage(packageDir: string, destination: string): string {
  const before = new Set(readdirSync(destination));
  execFileSync('pnpm', ['--dir', packageDir, 'pack', '--pack-destination', destination], {
    cwd: repoRoot,
    stdio: 'pipe',
  });
  const tgz = readdirSync(destination).find((name) => name.endsWith('.tgz') && !before.has(name));
  if (!tgz) throw new Error(`No tarball produced for ${packageDir}`);
  return join(destination, tgz);
}

function route(): ApiRoute {
  return { filePath: 'src/api/echo.ts', urlPattern: '/api/echo', methods: ['POST'], kind: 'serverless', config: {} };
}

function manifest(api: ApiRoute[]): RouteManifest {
  return { api, pages: [], layouts: [], timestamp: new Date().toISOString() };
}

describe('cloudflare adapter clean tarball smoke', () => {
  it('resolves @celsian/vura-core from flattened clean installs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vura-cf-pack-'));
    try {
      const tarballs = join(root, 'tarballs');
      mkdirSync(tarballs, { recursive: true });
      const coreTgz = packPackage(join(repoRoot, 'packages/core'), tarballs);
      const adapterTgz = packPackage(join(repoRoot, 'packages/adapter-cloudflare'), tarballs);

      const app = join(root, 'app');
      mkdirSync(app, { recursive: true });
      writeFileSync(join(app, 'package.json'), '{"type":"module"}\n');
      execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', coreTgz, adapterTgz], {
        cwd: app,
        stdio: 'pipe',
      });

      const nestedCore = join(app, 'node_modules/@celsian/vura-adapter-cloudflare/node_modules/@celsian/vura-core');
      rmSync(nestedCore, { recursive: true, force: true });
      expect(existsSync(join(app, 'node_modules/@celsian/vura-core/dist/index.js'))).toBe(true);
      expect(existsSync(nestedCore)).toBe(false);

      const project = join(root, 'project');
      mkdirSync(join(project, 'src/api'), { recursive: true });
      writeFileSync(join(project, 'src/api/echo.ts'), `import { HttpError } from '@celsian/vura-core';
export async function POST(req: { body: unknown }) {
  return { body: req.body, marker: new HttpError(418, 'INTERNAL_ERROR', 'teapot').name };
}
`);
      const outDir = join(project, 'dist');
      const ctx: AdapterBuildContext = {
        serverEntry: join(outDir, 'server/entry.js'),
        clientDir: join(outDir, 'client'),
        manifest: manifest([route()]),
        projectRoot: project,
        outDir,
      };

      execFileSync(process.execPath, ['--input-type=module', '-e', `
const mod = await import(${JSON.stringify('file://' + join(app, 'node_modules/@celsian/vura-adapter-cloudflare/dist/index.js'))});
const ctx = ${JSON.stringify(ctx)};
await mod.cloudflareAdapter({ name: 'tarball-worker', compatibilityDate: '2026-05-10' }).buildEnd(ctx);
`], { encoding: 'utf8' });

      const entryPath = join(outDir, 'cloudflare/entry.js');
      const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
const worker = await import(${JSON.stringify('file://' + entryPath)});
const response = await worker.default.fetch(new Request('https://example.com/api/echo', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: 'hello' }),
}), {}, { waitUntil: () => {}, passThroughOnException: () => {} });
console.log(JSON.stringify({ status: response.status, body: await response.json() }));
`], { encoding: 'utf8' });
      const result = JSON.parse(output);
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ body: { text: 'hello' }, marker: 'HttpError' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60000);
});
