import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { AdapterBuildContext, ApiRoute, RouteManifest } from '@then/core';

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

describe('lambda adapter clean tarball smoke', () => {
  it('resolves @then/core from flattened clean installs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vura-lambda-pack-'));
    try {
      const tarballs = join(root, 'tarballs');
      mkdirSync(tarballs, { recursive: true });
      const coreTgz = packPackage(join(repoRoot, 'packages/core'), tarballs);
      const adapterTgz = packPackage(join(repoRoot, 'packages/adapter-lambda'), tarballs);

      const app = join(root, 'app');
      mkdirSync(app, { recursive: true });
      writeFileSync(join(app, 'package.json'), '{"type":"module"}\n');
      execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', coreTgz, adapterTgz], {
        cwd: app,
        stdio: 'pipe',
      });

      const nestedCore = join(app, 'node_modules/@then/adapter-lambda/node_modules/@then/core');
      rmSync(nestedCore, { recursive: true, force: true });
      expect(existsSync(join(app, 'node_modules/@then/core/dist/index.js'))).toBe(true);
      expect(existsSync(nestedCore)).toBe(false);

      const project = join(root, 'project');
      mkdirSync(join(project, 'src/api'), { recursive: true });
      writeFileSync(join(project, 'src/api/echo.ts'), `import { HttpError } from '@then/core';
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
const mod = await import(${JSON.stringify('file://' + join(app, 'node_modules/@then/adapter-lambda/dist/index.js'))});
const ctx = ${JSON.stringify(ctx)};
await mod.lambdaAdapter().buildEnd(ctx);
`], { encoding: 'utf8' });

      const handlerPath = join(outDir, 'lambda/api_echo_post/index.js');
      const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
const handler = await import(${JSON.stringify('file://' + handlerPath)});
const result = await handler.handler({
  version: '2.0',
  routeKey: 'POST /api/echo',
  rawPath: '/api/echo',
  rawQueryString: '',
  headers: { host: 'example.com', 'content-type': 'application/json' },
  body: JSON.stringify({ text: 'hello' }),
  isBase64Encoded: false,
  requestContext: { domainName: 'example.com', http: { method: 'POST', path: '/api/echo' } },
}, {});
console.log(JSON.stringify(result));
`], { encoding: 'utf8' });
      const result = JSON.parse(output);
      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body)).toEqual({ body: { text: 'hello' }, marker: 'HttpError' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60000);
});
