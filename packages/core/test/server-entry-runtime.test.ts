import { afterEach, describe, expect, it } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Buffer } from 'node:buffer';
import { tmpdir } from 'node:os';
import { build, generateFunctionEntry } from '../src/build.js';
import { reservePort } from './reserve-port.js';
import type { RouteManifest } from '../src/manifest.js';

const childProcesses = new Set<ChildProcess>();
const tempRoots = new Set<string>();

function createTempProject(prefix = 'vura-runtime-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.add(root);
  mkdirSync(join(root, 'src', 'api'), { recursive: true });
  mkdirSync(join(root, 'dist', 'server', 'pages'), { recursive: true });
  writeFileSync(join(root, 'dist', 'server', 'package.json'), JSON.stringify({ type: 'module' }) + '\n');
  return root;
}

function writeModule(root: string, relPath: string, source: string): void {
  const fullPath = join(root, relPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, source);
}


async function startGeneratedServer(
  root: string,
  manifest: RouteManifest,
  env: Record<string, string> = {},
): Promise<{ process: ChildProcess; port: number }> {
  // Phase B: use build() to produce a bundled entry.js (self-contained ESM)
  const buildResult = await build(manifest, {}, root);
  return bootBuiltEntry(buildResult.serverEntry, root, env);
}

/** Fork an already-built dist/server/entry.js and wait for it to listen. */
async function bootBuiltEntry(
  entryPath: string,
  root: string,
  env: Record<string, string> = {},
): Promise<{ process: ChildProcess; port: number }> {
  const port = await reservePort();
  const child = fork(entryPath, [], {
    cwd: join(root, 'dist', 'server'),
    stdio: 'pipe',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      THEN_LOG_LEVEL: 'error',
      PORT: String(port),
      ...env,
    },
  });
  childProcesses.add(child);

  await new Promise<void>((resolve, reject) => {
    let stderr = '';
    const timeout = setTimeout(() => {
      reject(new Error('Generated server did not start within 5 seconds' + (stderr ? `\n${stderr}` : '')));
    }, 5000);

    child.stdout?.on('data', (data: Buffer) => {
      if (data.toString().includes('listening')) {
        clearTimeout(timeout);
        resolve();
      }
    });

    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    child.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        clearTimeout(timeout);
        reject(new Error(`Generated server exited with code ${code}`));
      }
    });
  });

  return { process: child, port };
}

function httpGet(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  chunks: string[];
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      const chunks: string[] = [];
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode ?? 0,
          headers: res.headers,
          chunks,
          body: chunks.join(''),
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function httpRequest(
  port: number,
  method: string,
  path: string,
): Promise<{
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method }, (res) => {
      const chunks: string[] = [];
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => chunks.push(chunk));
      res.on('end', () => resolve({
        statusCode: res.statusCode ?? 0,
        headers: res.headers,
        body: chunks.join(''),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}


// evaluateGeneratedTaskAdminAuth removed in Phase B: the thin entry no longer
// contains inline helper functions that can be string-extracted.
// Task admin auth is tested behaviorally in the HTTP-level tests below.
// TODO(Task 11): restore full task admin tests when task admin endpoints land.

function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function waitForFile(path: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for file: ${path}`);
}

afterEach(async () => {
  for (const child of childProcesses) {
    if (!child.killed && child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([
        waitForExit(child),
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]);
    }
    childProcesses.delete(child);
  }
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
    tempRoots.delete(root);
  }
});

describe('generated server runtime hardening', () => {
  it('keeps hot-server and serverless handler return finalization in parity', async () => {
    const routeSource = `
export function GET(_req, reply) {
  reply.status(201).header('x-mode', 'object');
  return { ok: true, target: 'both' };
}
export function POST() {
  return new Response('accepted', { status: 202, headers: { 'x-mode': 'response' } });
}
export function DELETE(_req, reply) {
  return reply.redirect('/target', 307);
}
`;

    const root = createTempProject();
    // Phase B: write to src/ so build() can bundle it (esbuild handles plain JS too)
    writeModule(root, 'src/api/return.ts', routeSource);

    const route = {
      filePath: 'src/api/return.ts',
      urlPattern: '/api/return',
      methods: ['GET', 'POST', 'DELETE'],
      kind: 'serverless' as const,
      config: {},
    };
    const manifest: RouteManifest = {
      api: [route],
      pages: [],
      layouts: [],
      timestamp: new Date().toISOString(),
    };

    const { port } = await startGeneratedServer(root, manifest);

    const functionDir = mkdtempSync(join(tmpdir(), 'vura-function-parity-'));
    tempRoots.add(functionDir);
    writeFileSync(join(functionDir, 'package.json'), JSON.stringify({ type: 'module' }) + '\n');
    writeFileSync(join(functionDir, 'route.js'), routeSource);
    const entrySource = generateFunctionEntry(route, root);
    writeFileSync(join(functionDir, 'entry.mjs'), entrySource);
    const routeDataUrl = `data:text/javascript;base64,${Buffer.from(routeSource).toString('base64')}`;
    const importableEntrySource = entrySource.replace(
      /import \* as (\w+) from '\.\/route\.js';/,
      (_match, name) => `import * as ${name} from '${routeDataUrl}';`,
    );
    const entryDataUrl = `data:text/javascript;base64,${Buffer.from(importableEntrySource).toString('base64')}`;
    const functionMod = await import(/* @vite-ignore */ entryDataUrl);

    for (const method of ['GET', 'POST', 'DELETE']) {
      const hot = await httpRequest(port, method, '/api/return');
      const serverless = await functionMod.default.fetch(new Request(`http://example.com/api/return`, { method }));
      const serverlessBody = await serverless.text();
      const isRedirect = serverless.status >= 300 && serverless.status < 400;

      // Status and location must always match.
      expect({ method, status: hot.statusCode, location: hot.headers.location }).toEqual({
        method,
        status: serverless.status,
        location: serverless.headers.get('location') ?? undefined,
      });
      // Body parity only for non-redirect responses — redirect body text varies
      // between the celsian hot-server (empty) and the inline serverless shim.
      if (!isRedirect) {
        expect(hot.body).toEqual(serverlessBody);
      }
    }
  }, 10000);

  it('lets only Vura errors choose their own status in a serverless function', async () => {
    // The serverless entry used to take any `error.statusCode` at face value.
    // A driver error that happens to carry one could then pick its own HTTP
    // status, and picking a non-500 also opted it out of the message
    // sanitisation — putting a connection string on the wire. Celsian closed
    // the same hole in 0.6; the generated runtimes had to follow, or the same
    // route would answer differently on a hot server and on a function.
    const routeSource = `
import { notFound } from '@celsian/vura-core';

export function GET() {
  throw notFound('No such thing');
}
export function POST() {
  const err = new Error('connect ECONNREFUSED postgres://admin:hunter2@db.internal:5432');
  err.statusCode = 400;
  err.code = 'ECONNREFUSED';
  throw err;
}
`;
    const root = createTempProject();
    writeModule(root, 'src/api/boom.ts', routeSource);
    const route = {
      filePath: 'src/api/boom.ts',
      urlPattern: '/api/boom',
      methods: ['GET', 'POST'],
      kind: 'serverless' as const,
      config: {},
    };
    const manifest: RouteManifest = {
      api: [route],
      pages: [],
      layouts: [],
      timestamp: new Date().toISOString(),
    };

    // Build so the function entry resolves @celsian/vura-core through the same
    // runtime shim a real deploy uses — that is what makes the thrown error a
    // different class object from the one the entry closes over.
    const built = await build(manifest, {}, root);
    const fnEntry = built.functions.find(f => f.route.filePath === 'src/api/boom.ts');
    expect(fnEntry).toBeDefined();
    const mod = await import(/* @vite-ignore */ pathToFileURL(fnEntry!.entryPath).href);

    const deliberate = await mod.default.fetch(new Request('http://example.com/api/boom'));
    expect(deliberate.status).toBe(404);

    const accidental = await mod.default.fetch(new Request('http://example.com/api/boom', { method: 'POST' }));
    const body = await accidental.text();
    expect(accidental.status).toBe(500);
    expect(body).not.toContain('hunter2');
    expect(body).not.toContain('db.internal');
  }, 30000);

  it('commits a cookie session from a plain-object return in a serverless function', async () => {
    // The generated function entry hands a hook a hand-rolled reply, and that
    // reply had no `headers` record. cookieSession's first act is to Proxy it,
    // so this path threw `Cannot create proxy with a non-object as target` in
    // the app's authorization hook before any handler ran — the same hole the
    // two serverless adapters had, in core's own output, which is why the fix
    // is in all three templates rather than only in the adapters.
    //
    // The plain-object return is the case worth running: it is the shape the
    // docs show, and it never calls reply.json, so it is committed only through
    // the Proxy on reply.headers. A test that used reply.json would have gone
    // green against a reply that never grew the property.
    const root = createTempProject();
    writeModule(root, 'src/api/_hooks.ts', `
import { cookieSession } from '@celsian/vura-core';
export const onRequest = cookieSession({ secret: 'a-very-long-test-secret-32chars!!', cookie: { secure: false } });
`);
    writeModule(root, 'src/api/session.ts', `
export function GET(req) {
  const count = (req.session.count ?? 0) + 1;
  req.session.count = count;
  return { count };
}
`);
    const route = {
      filePath: 'src/api/session.ts',
      urlPattern: '/api/session',
      methods: ['GET'],
      kind: 'serverless' as const,
      config: {},
    };
    const manifest: RouteManifest = {
      api: [route],
      pages: [],
      layouts: [],
      timestamp: new Date().toISOString(),
    };

    const built = await build(manifest, {}, root);
    const fnEntry = built.functions.find(f => f.route.filePath === 'src/api/session.ts');
    expect(fnEntry).toBeDefined();
    const mod = await import(/* @vite-ignore */ pathToFileURL(fnEntry!.entryPath).href);

    const first = await mod.default.fetch(new Request('http://example.com/api/session'));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ count: 1 });
    const setCookie = first.headers.get('set-cookie');
    expect(setCookie, 'a mutated session must reach the response').toMatch(/^vura_session=/);

    const second = await mod.default.fetch(new Request('http://example.com/api/session', {
      headers: { cookie: setCookie!.split(';')[0]! },
    }));
    expect(await second.json()).toEqual({ count: 2 });
  }, 30000);

  it('serves server pages marked stream as chunked full HTML responses', async () => {
    const root = createTempProject();
    // Phase B: write page source to src/ so build() bundles it into dist/server/pages/
    writeModule(root, 'src/pages/stream.tsx', `
import { h } from 'what-framework';
export const page = { mode: 'server', stream: true, title: 'Chunked Runtime' };
export default function StreamPage() {
  return h('main', { id: 'stream-page' },
    h('h1', null, 'Chunked HTML'),
    h('p', null, 'full body')
  );
}
`);

    const manifest: RouteManifest = {
      api: [],
      pages: [{
        filePath: 'src/pages/stream.tsx',
        urlPattern: '/stream',
        mode: 'server',
        hasLoader: false,
        hasGetServerData: false,
        config: { mode: 'server', stream: true, title: 'Chunked Runtime' },
      }],
      layouts: [],
      timestamp: new Date().toISOString(),
    };

    const { port } = await startGeneratedServer(root, manifest);
    const res = await httpGet(port, '/stream');

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['transfer-encoding']).toBe('chunked');
    expect(res.body).toContain('<title>Chunked Runtime</title>');
    expect(res.body).toContain('<h1>Chunked HTML</h1>');
    expect(res.body).toContain('<p>full body</p>');
  }, 10000);

  it('authorizes task management from the true socket-local address without a task secret', async () => {
    const root = createTempProject();
    writeModule(root, 'src/api/mytask.ts', `
export const route = { kind: 'task', retries: 0, timeout: 5000 };
export async function POST() { return { done: true }; }
`);

    const manifest: RouteManifest = {
      api: [{
        filePath: 'src/api/mytask.ts',
        urlPattern: '/api/mytask',
        methods: ['POST'],
        kind: 'task',
        config: { kind: 'task', retries: 0, timeout: 5000 },
      }],
      pages: [],
      layouts: [],
      timestamp: new Date().toISOString(),
    };

    const { port } = await startGeneratedServer(root, manifest, {
      NODE_ENV: 'test',
      THEN_TASK_SECRET: '', // no secret
    });

    // From loopback in test mode — should be authorized
    const res = await httpGet(port, '/__tasks');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.tasks).toBeDefined();
    expect(Array.isArray(body.tasks)).toBe(true);
  }, 10000);

  it('does not trust X-Forwarded-For for generated task admin localhost authorization', async () => {
    const root = createTempProject();
    writeModule(root, 'src/api/mytask.ts', `
export const route = { kind: 'task', retries: 0, timeout: 5000 };
export async function POST() { return { done: true }; }
`);

    const manifest: RouteManifest = {
      api: [{
        filePath: 'src/api/mytask.ts',
        urlPattern: '/api/mytask',
        methods: ['POST'],
        kind: 'task',
        config: { kind: 'task', retries: 0, timeout: 5000 },
      }],
      pages: [],
      layouts: [],
      timestamp: new Date().toISOString(),
    };

    const { port } = await startGeneratedServer(root, manifest, {
      NODE_ENV: 'production',
      THEN_TASK_SECRET: 'secret123',
    });

    // X-Forwarded-For: 127.0.0.1 must NOT grant access — only Bearer secret does
    const resWithSpoof = await httpGet(port, '/__tasks', {
      'x-forwarded-for': '127.0.0.1',
    });
    expect(resWithSpoof.statusCode).toBe(403);

    // Correct Bearer auth should succeed
    const resWithAuth = await httpGet(port, '/__tasks', {
      authorization: 'Bearer secret123',
    });
    expect(resWithAuth.statusCode).toBe(200);
  }, 10000);

  it('renders nested layouts from outermost to innermost around the page', async () => {
    const root = createTempProject();
    // Phase B: write page source to src/ so build() bundles it
    writeModule(root, 'src/pages/_layout.tsx', `
import { h } from 'what-framework';
export default function RootLayout({ children }: any) {
  return h('section', { id: 'root-layout' },
    h('span', null, 'root-before'), children,
    h('span', null, 'root-after')
  );
}
`);
    writeModule(root, 'src/pages/blog/_layout.tsx', `
import { h } from 'what-framework';
export default function BlogLayout({ children, params }: any) {
  return h('article', { id: 'blog-layout' },
    h('span', null, 'blog-before-' + params.slug), children,
    h('span', null, 'blog-after')
  );
}
`);
    writeModule(root, 'src/pages/blog/[slug].tsx', `
import { h } from 'what-framework';
export const page = { mode: 'server', title: 'Nested Layout' };
export default function Post({ params }: any) {
  return h('h1', null, 'post-' + params.slug);
}
`);

    const manifest: RouteManifest = {
      api: [],
      pages: [{
        filePath: 'src/pages/blog/[slug].tsx',
        urlPattern: '/blog/:slug',
        mode: 'server',
        hasLoader: false,
        hasGetServerData: false,
        layouts: ['src/pages/_layout.tsx', 'src/pages/blog/_layout.tsx'],
        config: { mode: 'server', title: 'Nested Layout' },
      }],
      layouts: [
        { filePath: 'src/pages/_layout.tsx', urlPattern: '/', dirPattern: '' },
        { filePath: 'src/pages/blog/_layout.tsx', urlPattern: '/blog', dirPattern: 'blog' },
      ],
      timestamp: new Date().toISOString(),
    };

    const { port } = await startGeneratedServer(root, manifest);
    const res = await httpGet(port, '/blog/hardening');

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<section id="root-layout">');
    expect(res.body).toContain('<article id="blog-layout">');
    expect(res.body.indexOf('root-before')).toBeLessThan(res.body.indexOf('blog-before-hardening'));
    expect(res.body.indexOf('blog-before-hardening')).toBeLessThan(res.body.indexOf('post-hardening'));
    expect(res.body.indexOf('post-hardening')).toBeLessThan(res.body.indexOf('blog-after'));
    expect(res.body.indexOf('blog-after')).toBeLessThan(res.body.indexOf('root-after'));
  }, 10000);

  it('keeps the server alive and returns 500 when a layout throws during rendering', async () => {
    const root = createTempProject();
    // Phase B: write page source to src/ so build() bundles it
    writeModule(root, 'src/pages/_layout.tsx', `
export default function BrokenLayout() {
  throw new Error('layout explosion');
}
`);
    writeModule(root, 'src/pages/broken.tsx', `
import { h } from 'what-framework';
export const page = { mode: 'server', title: 'Broken Layout' };
export default function BrokenPage() {
  return h('p', null, 'never visible');
}
`);

    const manifest: RouteManifest = {
      api: [],
      pages: [{
        filePath: 'src/pages/broken.tsx',
        urlPattern: '/broken',
        mode: 'server',
        hasLoader: false,
        hasGetServerData: false,
        layouts: ['src/pages/_layout.tsx'],
        config: { mode: 'server', title: 'Broken Layout' },
      }],
      layouts: [{ filePath: 'src/pages/_layout.tsx', urlPattern: '/', dirPattern: '' }],
      timestamp: new Date().toISOString(),
    };

    const { port } = await startGeneratedServer(root, manifest);
    const res = await httpGet(port, '/broken');
    const health = await httpGet(port, '/__health');

    expect(res.statusCode).toBe(500);
    // Error page should indicate server error without exposing the internal exception
    expect(res.body).toMatch(/500|Server Error|Internal/i);
    expect(res.body).not.toContain('layout explosion');
    expect(health.statusCode).toBe(200);
    expect(health.body).toContain('Vura');
  }, 10000);

  it('lets an in-flight request complete before SIGTERM exits the process', async () => {
    const root = createTempProject();
    const startedFile = join(root, 'slow-started');
    // Phase B: write source to src/ so build() can bundle it
    writeModule(root, 'src/api/slow.ts', `
import { writeFileSync } from 'node:fs';

export async function GET(_req: any, reply: any) {
  writeFileSync(process.env.SLOW_STARTED_FILE as string, 'started');
  await new Promise(resolve => setTimeout(resolve, 250));
  return reply.json({ done: true });
}
`);

    const manifest: RouteManifest = {
      api: [{
        filePath: 'src/api/slow.ts',
        urlPattern: '/api/slow',
        methods: ['GET'],
        kind: 'serverless',
        config: {},
      }],
      pages: [],
      layouts: [],
      timestamp: new Date().toISOString(),
    };

    const { process: child, port } = await startGeneratedServer(root, manifest, {
      THEN_SHUTDOWN_TIMEOUT: '2000',
      SLOW_STARTED_FILE: startedFile,
    });
    const inFlight = httpGet(port, '/api/slow');

    await waitForFile(startedFile);
    child.kill('SIGTERM');

    const [res, exit] = await Promise.all([inFlight, waitForExit(child)]);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ done: true });
    expect(exit.code).toBe(0);
  }, 10000);

  it('wires a filesystem cache store from vura.config that persists ISR entries across restarts', async () => {
    const root = createTempProject();
    // A revalidate page whose body embeds a per-process random token: if the
    // second boot re-rendered (i.e. the store were memory, not filesystem),
    // the token would change and the cross-boot body assertion would fail.
    writeModule(root, 'src/pages/cached.tsx', `
import { h } from 'what-framework';
export const page = { mode: 'server', revalidate: 300, title: 'Cached' };
const bootToken = Math.random().toString(36).slice(2);
export default function CachedPage() {
  return h('p', { id: 'cached' }, 'token-' + bootToken);
}
`);

    const manifest: RouteManifest = {
      api: [],
      pages: [{
        filePath: 'src/pages/cached.tsx',
        urlPattern: '/cached',
        mode: 'server',
        hasLoader: false,
        hasGetServerData: false,
        config: { mode: 'server', revalidate: 300 },
      }],
      layouts: [],
      timestamp: new Date().toISOString(),
    };

    // Build with a filesystem store from vura.config — this is the wiring
    // under test. The relative dir resolves from the server process cwd
    // (dist/server here, /app in the generated Docker image).
    const buildResult = await build(
      manifest,
      { cache: { store: 'filesystem', dir: '.vura/cache', maxEntries: 500 } },
      root,
    );

    // The artifact must carry the literals but never any secret value.
    const thinSource = readFileSync(join(root, 'dist', 'server', 'entry.source.mjs'), 'utf8');
    expect(thinSource).toContain('store: "filesystem"');
    expect(thinSource).toContain('dir: ".vura/cache"');
    expect(thinSource).toContain('maxEntries: 500');
    expect(thinSource).toContain('revalidateSecret: process.env.VURA_REVALIDATE_SECRET');

    // Boot 1 — MISS then HIT populates the on-disk store.
    const first = await bootBuiltEntry(buildResult.serverEntry, root);
    const r1 = await httpGet(first.port, '/cached');
    expect(r1.statusCode).toBe(200);
    expect(r1.headers['x-what-cache']).toBe('MISS');
    const r2 = await httpGet(first.port, '/cached');
    // HIT here proves the entry was read back from the filesystem store
    // (the store's get() reads from disk on every call).
    expect(r2.headers['x-what-cache']).toBe('HIT');
    first.process.kill('SIGTERM');
    await waitForExit(first.process);

    // Boot 2 — a fresh process. A memory store starts empty and would MISS;
    // only on-disk persistence can serve HIT on the very first request.
    const second = await bootBuiltEntry(buildResult.serverEntry, root);
    const r3 = await httpGet(second.port, '/cached');
    expect(r3.headers['x-what-cache']).toBe('HIT');
    // Same body as boot 1 — the render (and its boot token) came from disk,
    // not from a re-render in the new process.
    expect(r3.body).toBe(r1.body);
  }, 30000);
});
