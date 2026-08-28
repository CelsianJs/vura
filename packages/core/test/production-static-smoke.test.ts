import { afterEach, describe, expect, it } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from '../src/build.js';
import { reservePort } from './reserve-port.js';
import type { RouteManifest } from '../src/manifest.js';

const childProcesses = new Set<ChildProcess>();
const tempRoots = new Set<string>();

function writeFile(root: string, relPath: string, source: string): void {
  const fullPath = join(root, relPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, source);
}

async function httpGet(port: number, path: string): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function startServer(root: string, manifest: RouteManifest): Promise<{ port: number; child: ChildProcess }> {
  const port = await reservePort();
  // Phase B: use build() to produce a bundled, self-contained entry.js
  const buildResult = await build(manifest, {}, root);
  const entryPath = buildResult.serverEntry;
  const serverDir = join(root, 'dist', 'server');

  const child = fork(entryPath, [], {
    cwd: serverDir,
    stdio: 'pipe',
    env: { ...process.env, NODE_ENV: 'production', THEN_LOG_LEVEL: 'error', PORT: String(port) },
  });
  childProcesses.add(child);

  await new Promise<void>((resolve, reject) => {
    let stderr = '';
    const timeout = setTimeout(() => reject(new Error('server did not start' + (stderr ? `\n${stderr}` : ''))), 5000);
    child.stdout?.on('data', (data: Buffer) => {
      if (data.toString().includes('listening')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });
    child.on('error', (error) => { clearTimeout(timeout); reject(error); });
    child.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        clearTimeout(timeout);
        reject(new Error(`server exited with code ${code}${stderr ? `\n${stderr}` : ''}`));
      }
    });
  });

  return { port, child };
}

afterEach(async () => {
  for (const child of childProcesses) {
    if (!child.killed && child.exitCode === null) child.kill('SIGTERM');
    childProcesses.delete(child);
  }
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
    tempRoots.delete(root);
  }
});

describe('generated production server static fallback', () => {
  it('serves dist/static pages with index fallback while preserving API routes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vura-prod-static-'));
    tempRoots.add(root);

    writeFile(root, 'dist/static/index.html', '<h1>Home Static</h1>');
    writeFile(root, 'dist/static/about/index.html', '<h1>About Static</h1>');
    writeFile(root, 'dist/static/dashboard/index.html', '<h1>Dashboard Static</h1>');
    // Phase B: build() bundles from src/ — write the TypeScript source, not pre-compiled JS
    writeFile(root, 'src/api/hello.ts', `
export async function GET(_req: any, reply: any) {
  return reply.json({ ok: true, source: 'api' });
}
`);

    const manifest: RouteManifest = {
      api: [{ filePath: 'src/api/hello.ts', urlPattern: '/api/hello', methods: ['GET'], kind: 'serverless', config: {} }],
      pages: [],
      layouts: [],
      timestamp: new Date().toISOString(),
    };

    const { port } = await startServer(root, manifest);

    await expect(httpGet(port, '/')).resolves.toMatchObject({ statusCode: 200, body: '<h1>Home Static</h1>' });
    await expect(httpGet(port, '/about')).resolves.toMatchObject({ statusCode: 200, body: '<h1>About Static</h1>' });
    await expect(httpGet(port, '/dashboard')).resolves.toMatchObject({ statusCode: 200, body: '<h1>Dashboard Static</h1>' });

    const api = await httpGet(port, '/api/hello');
    expect(api.statusCode).toBe(200);
    expect(JSON.parse(api.body)).toEqual({ ok: true, source: 'api' });
  }, 10000);
});
