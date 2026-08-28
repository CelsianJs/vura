/**
 * Smoke test: end-to-end build pipeline verification.
 *
 * Creates a minimal Vura project in a temp directory, runs the full build()
 * pipeline, and verifies the generated server entry is valid, complete, and
 * (optionally) actually boots and serves requests.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { build } from '../src/build.js';
import { reservePort } from './reserve-port.js';
import { buildManifest } from '../src/manifest.js';
import type { RouteManifest, PageRoute } from '../src/manifest.js';
import type { ThenConfig } from '../src/config.js';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync, fork, type ChildProcess } from 'node:child_process';

function runModuleJson(entryPath: string, body: string): any {
  const source = `const mod = await import(${JSON.stringify(pathToFileURL(entryPath).href)});
${body}`;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' }));
}

// ─── Test project scaffold ───

function createTestProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'vura-smoke-'));

  // Minimal dependency fixture for route modules that import zod. Real
  // projects resolve this from their installed dependencies; the smoke temp
  // project needs a tiny local package so the build can prove route bundling.
  const zodDir = join(root, 'node_modules', 'zod');
  mkdirSync(zodDir, { recursive: true });
  writeFileSync(join(zodDir, 'package.json'), JSON.stringify({ type: 'module', exports: './index.js' }));
  writeFileSync(
    join(zodDir, 'index.js'),
    `export const z = {
  object() {
    return {
      safeParse(value) {
        return value && typeof value.text === 'string'
          ? { success: true, data: value }
          : { success: false, error: { issues: [{ path: ['text'], message: 'Required', code: 'invalid_type' }] } };
      },
    };
  },
  string() { return {}; },
};
`,
  );

  // src/api/hello.ts — simple GET handler
  const apiDir = join(root, 'src', 'api');
  mkdirSync(apiDir, { recursive: true });
  writeFileSync(
    join(apiDir, 'hello.ts'),
    `import { HttpError } from '@celsian/vura-core';

export async function GET(req: any, reply: any) {
  const marker = new HttpError(418, 'INTERNAL_ERROR', 'teapot');
  return reply.json({
    message: 'hello',
    marker: marker.name,
    scope: process.env.VURA_ENV_SCOPE || 'unset',
    pathname: new URL(req.url).pathname,
    probe: req.headers.get('x-vura-probe'),
  });
}
`,
  );

  // src/api/echo.ts — POST handler with validation schema
  writeFileSync(
    join(apiDir, 'echo.ts'),
    `import { z } from 'zod';

export const schema = {
  body: z.object({ text: z.string() }),
};

export async function POST(req: any, reply: any) {
  return reply.json({ echo: req.parsedBody });
}
`,
  );

  const usersDir = join(apiDir, 'users');
  mkdirSync(usersDir, { recursive: true });
  writeFileSync(
    join(usersDir, '[id].ts'),
    `export const onRequest = (req: any, reply: any) => reply.header('x-vura-route-hook', 'true');

export async function GET(req: any, reply: any) {
  return reply.json({ id: req.params.id });
}
`,
  );

  // src/api/_hooks.ts — global onRequest hook
  writeFileSync(
    join(apiDir, '_hooks.ts'),
    `export const onRequest = [
  (req: any, reply: any) => {
    reply.header('x-vura-smoke', 'true');
  },
];
`,
  );

  writeFileSync(
    join(apiDir, 'jobs.ts'),
    `export const route = { kind: 'task', schedule: '*/5 * * * *' };

export async function POST(ctx: { input: { text?: string } }) {
  return { upper: ctx.input.text?.toUpperCase() };
}
`,
  );

  // src/pages/index.tsx — simple page component
  const pagesDir = join(root, 'src', 'pages');
  mkdirSync(pagesDir, { recursive: true });
  writeFileSync(
    join(pagesDir, 'index.tsx'),
    `export const page = { mode: 'server', title: 'Smoke Test' };

export default function Home() {
  return <div><h1>Smoke Test</h1></div>;
}
`,
  );

  // src/public/test.txt — static content
  const publicDir = join(root, 'src', 'public');
  mkdirSync(publicDir, { recursive: true });
  writeFileSync(join(publicDir, 'test.txt'), 'smoke-test-static-content');

  return root;
}

// ─── Tests ───

describe('smoke-build: end-to-end build pipeline', () => {
  let projectRoot: string;
  let buildResult: Awaited<ReturnType<typeof build>>;
  let serverCode: string;

  beforeAll(async () => {
    projectRoot = createTestProject();

    // Build a manifest that matches the files we created.
    // We construct it manually (mirroring what buildManifest would produce)
    // because buildManifest reads source files and we want a deterministic test.
    const manifest: RouteManifest = {
      api: [
        {
          filePath: 'src/api/hello.ts',
          urlPattern: '/api/hello',
          methods: ['GET'],
          kind: 'serverless',
          config: {},
        },
        {
          filePath: 'src/api/echo.ts',
          urlPattern: '/api/echo',
          methods: ['POST'],
          kind: 'serverless',
          config: {},
        },
        {
          filePath: 'src/api/jobs.ts',
          urlPattern: '/api/jobs',
          methods: ['POST'],
          kind: 'task',
          config: { schedule: '*/5 * * * *' },
        },
        {
          filePath: 'src/api/users/[id].ts',
          urlPattern: '/api/users/:id',
          methods: ['GET'],
          kind: 'serverless',
          config: {},
        },
      ],
      pages: [
        {
          filePath: 'src/pages/index.tsx',
          urlPattern: '/',
          mode: 'server',
          hasGetServerData: false,
          config: { title: 'Smoke Test', mode: 'server' },
        } as PageRoute,
      ],
      layouts: [],
      timestamp: new Date().toISOString(),
    };

    const config: ThenConfig = {};

    buildResult = await build(manifest, config, projectRoot);
    serverCode = readFileSync(buildResult.serverEntry, 'utf-8');
  });

  afterAll(() => {
    if (projectRoot) {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  // ── 1. Build produces expected artifacts ──

  it('writes server entry to dist/server/entry.js', () => {
    expect(existsSync(buildResult.serverEntry)).toBe(true);
    expect(buildResult.serverEntry).toContain('dist/server/entry.js');
  });

  it('writes function entries for serverless routes', () => {
    expect(buildResult.functions.length).toBe(3);
    expect(
      JSON.parse(readFileSync(join(projectRoot, 'dist', 'functions', 'package.json'), 'utf-8')),
    ).toEqual({ type: 'module' });
    for (const fn of buildResult.functions) {
      expect(existsSync(fn.entryPath)).toBe(true);
    }
  });


  it('bundles @celsian/vura-core imports into serverless route artifacts', async () => {
    const helloFunction = buildResult.functions.find(fn => fn.route.urlPattern === '/api/hello');
    expect(helloFunction).toBeDefined();
    const routeArtifact = readFileSync(join(dirname(helloFunction!.entryPath), 'route.js'), 'utf-8');
    expect(routeArtifact).not.toContain("from '@celsian/vura-core'");
    expect(routeArtifact).not.toContain('from "@celsian/vura-core"');
    const result = runModuleJson(helloFunction!.entryPath, `
const response = await mod.default.fetch(new Request('https://example.com/api/hello', {
  headers: { 'x-vura-probe': 'request-compatible' },
}));
console.log(JSON.stringify({ status: response.status, body: await response.json() }));
`);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      message: 'hello',
      marker: 'HttpError',
      scope: 'unset',
      pathname: '/api/hello',
      probe: 'request-compatible',
    });
  });

  it('writes task entries for task routes', () => {
    expect(buildResult.taskEntries.length).toBe(1);
    for (const task of buildResult.taskEntries) {
      expect(existsSync(task.entryPath)).toBe(true);
      expect(existsSync(join(dirname(task.entryPath), 'route.js'))).toBe(true);
    }
  });

  it('writes manifest.json', () => {
    const manifestPath = join(projectRoot, 'dist', 'manifest.json');
    expect(existsSync(manifestPath)).toBe(true);
    const written = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    expect(written.api).toHaveLength(4);
    expect(written.pages).toHaveLength(1);
  });

  // ── 2. Bundled entry is valid ESM ──

  it('bundled server entry is parseable JavaScript (ESM)', () => {
    // The bundled entry is fully self-contained ESM.
    // Strip ESM-only syntax and wrap in async function for new Function() parse check
    // (new Function() does not support top-level await directly).
    // `import.meta` in every form, not just `import.meta.<name>`. what-core's
    // __DEV__ resolution reads `(import.meta && import.meta.env)`, and the bare
    // occurrence is ESM-only syntax that `new Function()` rejects — so a check
    // meant to catch real syntax errors was failing on legal, working code.
    // Substituting an object expression keeps every member access downstream
    // (`import.meta.env.DEV`) parseable.
    const stripped = serverCode
      .replace(/^import\s.*$/gm, '// [import stripped]')
      .replace(/^export\s.*$/gm, '// [export stripped]')
      .replace(/import\.meta/g, '({ env: {} })');
    const wrapped = `return (async function _vuraEntryCheck() {\n${stripped}\n})`;

    let parseError: Error | null = null;
    try {
      new Function(wrapped);
    } catch (err) {
      parseError = err as Error;
    }
    expect(
      parseError,
      `Bundled code has syntax error: ${parseError?.message}`,
    ).toBeNull();
  });

  // ── 3. ESM format — no CommonJS ──

  it('does not use require()', () => {
    expect(serverCode).not.toMatch(/\brequire\s*\(/);
  });

  // ── 4. Route handlers are wired up (in bundled output) ──

  it('contains the API route URL patterns in bundled output', () => {
    // esbuild normalises quote style to double-quotes; match with regex
    expect(serverCode).toMatch(/['"]\/api\/hello['"]/);
    expect(serverCode).toMatch(/['"]\/api\/echo['"]/);
  });

  // ── 5. Bundled entry has no external @celsian/vura-core import ──

  it('has no unbundled @celsian/vura-core import (bundled in)', () => {
    // esbuild bundles @celsian/vura-core in — no remaining external import
    expect(serverCode).not.toMatch(/from ['"]@celsian\/vura-core['"]/);
  });

  // ── 6. Health check endpoint is present ──

  it('includes health check endpoint', () => {
    expect(serverCode).toContain('/__health');
    // esbuild normalises quotes — match both styles
    expect(serverCode).toMatch(/framework:\s*['"]Vura['"]/);
  });

  // ── 7. Page route is wired ──

  it('page route URL pattern is in bundled output', () => {
    // esbuild normalises quotes
    expect(serverCode).toMatch(/['"]\/['"]/);
  });

  // ── 20. Function entries are valid ──

  it('serverless function entries are parseable JavaScript', () => {
    for (const fn of buildResult.functions) {
      const code = readFileSync(fn.entryPath, 'utf-8');

      // Strip ESM syntax for parsing via new Function() (script mode).
      // `export default { ... }` becomes `var _default = { ... }` to stay parseable.
      const stripped = code
        .replace(/^import\s.*$/gm, '// [import stripped]')
        .replace(/^export\s+default\s+/gm, 'var _default = ')
        .replace(/^export\s.*$/gm, '// [export stripped]')
        .replace(/import\.meta\.\w+/g, '"__stripped__"');

      let parseError: Error | null = null;
      try {
        new Function(stripped);
      } catch (err) {
        parseError = err as Error;
      }
      expect(
        parseError,
        `Function entry ${fn.entryPath} has syntax error: ${parseError?.message}`,
      ).toBeNull();

      // Worker-compatible fetch handler
      expect(code).toContain('async fetch(request)');
    }
  });

  it('serverless function entries import bundled route.js artifacts, not raw TypeScript', async () => {
    for (const fn of buildResult.functions) {
      const code = readFileSync(fn.entryPath, 'utf-8');
      const routeCode = readFileSync(join(dirname(fn.entryPath), 'route.js'), 'utf-8');
      const hooksCode = readFileSync(join(dirname(fn.entryPath), 'hooks.js'), 'utf-8');
      expect(code).toContain("from './route.js'");
      expect(code).toContain("from './hooks.js'");
      expect(code).not.toMatch(/from ['\"].*\.tsx?['\"]/);
      expect(routeCode).not.toContain('req: any');
      expect(hooksCode).not.toContain('req: any');
    }

    const echo = buildResult.functions.find((fn) => fn.route.urlPattern === '/api/echo')!;
    const echoResult = runModuleJson(echo.entryPath, `
const response = await mod.default.fetch(new Request('https://example.com/api/echo', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: 'hello' }),
}));
console.log(JSON.stringify({ status: response.status, body: await response.json() }));
`);
    expect(echoResult.status).toBe(200);
    expect(echoResult.body).toEqual({ echo: { text: 'hello' } });

    const invalidEcho = runModuleJson(echo.entryPath, `
const response = await mod.default.fetch(new Request('https://example.com/api/echo', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: 42 }),
}));
console.log(JSON.stringify({
  status: response.status,
  hook: response.headers.get('x-vura-smoke'),
  body: await response.json(),
}));
`);
    expect(invalidEcho.status).toBe(400);
    expect(invalidEcho.hook).toBe('true');
    expect(invalidEcho.body).toMatchObject({ code: 'VALIDATION_ERROR' });

    const dynamic = buildResult.functions.find((fn) => fn.route.urlPattern === '/api/users/:id')!;
    const dynamicResult = runModuleJson(dynamic.entryPath, `
const response = await mod.default.fetch(new Request('https://example.com/api/users/42'));
console.log(JSON.stringify({
  status: response.status,
  hook: response.headers.get('x-vura-route-hook'),
  body: await response.json(),
}));
`);
    expect(dynamicResult).toEqual({ status: 200, hook: 'true', body: { id: '42' } });
  });

  it('task entries bundle route.js + core executor, not raw TypeScript', async () => {
    const task = buildResult.taskEntries[0]!;
    const code = readFileSync(task.entryPath, 'utf-8');
    const sourceCode = readFileSync(join(dirname(task.entryPath), 'index.source.mjs'), 'utf-8');
    const routeCode = readFileSync(join(dirname(task.entryPath), 'route.js'), 'utf-8');
    // The thin source wires the bundled route artifact through core's
    // runTaskOnce; the shipped index.js is fully self-contained (Workers have
    // no node_modules), so the route + executor are inlined, never imported.
    expect(sourceCode).toContain("from './route.js'");
    expect(sourceCode).toContain("from '@celsian/vura-core'");
    expect(code).not.toMatch(/from ['\"].*\.tsx?['\"]/);
    expect(code).not.toContain("from '@celsian/vura-core'");
    expect(routeCode).not.toContain('ctx: {');

    // Platform-protocol dispatch (X-Vura-Task-Id wrapper) → run envelope.
    const taskResult = runModuleJson(task.entryPath, `
const response = await mod.default.fetch(new Request('https://example.com/api/jobs', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-vura-task-id': 'task-1' },
  body: JSON.stringify({ taskId: 'task-1', input: { text: 'hello' }, attempt: 1, steps: {} }),
}));
console.log(JSON.stringify({ status: response.status, body: await response.json() }));
`);
    expect(taskResult.status).toBe(200);
    expect(taskResult.body).toMatchObject({ ok: true, taskName: 'jobs', result: { upper: 'HELLO' } });
    expect(Array.isArray(taskResult.body.attempts)).toBe(true);
  });
});

// ─── Build manifest integration: verify the scanner picks up our files ──

describe('smoke-build: buildManifest detects project files', () => {
  let projectRoot: string;

  beforeAll(() => {
    projectRoot = createTestProject();
  });

  afterAll(() => {
    if (projectRoot) {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('buildManifest discovers API routes and pages from the file system', async () => {
    const manifest = await buildManifest(projectRoot);

    // Should find hello.ts and echo.ts (not _hooks.ts — that's a hooks file, not a route)
    const apiPatterns = manifest.api.map((r) => r.urlPattern).sort();
    expect(apiPatterns).toContain('/api/echo');
    expect(apiPatterns).toContain('/api/hello');

    // hello.ts exports GET
    const hello = manifest.api.find((r) => r.urlPattern === '/api/hello');
    expect(hello?.methods).toContain('GET');

    // echo.ts exports POST
    const echo = manifest.api.find((r) => r.urlPattern === '/api/echo');
    expect(echo?.methods).toContain('POST');

    // Should find index.tsx page
    expect(manifest.pages.length).toBeGreaterThanOrEqual(1);
    const indexPage = manifest.pages.find((p) => p.urlPattern === '/');
    expect(indexPage).toBeDefined();
    expect(indexPage?.mode).toBe('server');
  });
});

// ─── Live server test: boot the server and hit it with fetch ──

describe('smoke-build: live server integration', () => {
  let projectRoot: string;
  let serverProcess: ChildProcess | null = null;
  let port: number;

  beforeAll(async () => {
    projectRoot = createTestProject();

    // Phase B: use build() which bundles the thin entry into a self-contained entry.js
    const manifest: RouteManifest = {
      api: [
        {
          filePath: 'src/api/hello.ts',
          urlPattern: '/api/hello',
          methods: ['GET'],
          kind: 'serverless',
          config: {},
        },
      ],
      pages: [
        {
          filePath: 'src/pages/index.tsx',
          urlPattern: '/',
          mode: 'server',
          hasGetServerData: false,
          config: { title: 'Smoke Test', mode: 'server' },
        } as PageRoute,
      ],
      layouts: [],
      timestamp: new Date().toISOString(),
    };

    port = await reservePort();

    // build() bundles route modules from src/ and produces dist/server/entry.js
    const buildResult = await build(manifest, {}, projectRoot);
    const entryPath = buildResult.serverEntry;

    // Boot the server in a child process
    serverProcess = fork(entryPath, [], {
      cwd: dirname(entryPath),
      stdio: 'pipe',
      env: {
        ...process.env,
        PORT: String(port),
        NODE_ENV: 'test',
        THEN_LOG_LEVEL: 'error',
      },
    });

    // Wait for the server to start (listen for stdout message)
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Server did not start within 10 seconds'));
      }, 10000);

      serverProcess!.stdout?.on('data', (data: Buffer) => {
        if (data.toString().includes('listening')) {
          clearTimeout(timeout);
          resolve();
        }
      });

      serverProcess!.stderr?.on('data', (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) console.error('[server stderr]', msg);
      });

      serverProcess!.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      serverProcess!.on('exit', (code) => {
        if (code !== 0 && code !== null) {
          clearTimeout(timeout);
          reject(new Error(`Server exited with code ${code}`));
        }
      });
    });
  }, 30000);

  afterAll(() => {
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill('SIGTERM');
    }
    if (projectRoot) {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('GET /__health returns ok', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/__health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.framework).toBe('Vura');
  });

  it('GET /api/hello returns { message: "hello" }', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/hello`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toBe('hello');
  });

  it('GET / renders a JSX server page without requiring React globals', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Smoke Test');
  });

  it('GET /unknown returns 404', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/unknown`);
    expect(res.status).toBe(404);
  });

  it('POST /api/hello returns 404 or 405 (only GET registered)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/hello`, {
      method: 'POST',
    });
    // The route exists but POST is not registered.
    // Celsian returns 405 Method Not Allowed for a known route with unregistered method.
    expect([404, 405]).toContain(res.status);
  });
});
