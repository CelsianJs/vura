import { afterEach, describe, expect, it } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateServerEntry } from '../src/build.js';
import type { RouteManifest } from '../src/manifest.js';

const childProcesses = new Set<ChildProcess>();
const tempRoots = new Set<string>();

function createTempProject(prefix = 'vura-runtime-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.add(root);
  mkdirSync(join(root, 'src', 'api'), { recursive: true });
  mkdirSync(join(root, 'dist', 'server', 'pages'), { recursive: true });
  return root;
}

function writeModule(root: string, relPath: string, source: string): void {
  const fullPath = join(root, relPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, source);
}

function pickPort(): number {
  return 12000 + Math.floor(Math.random() * 40000);
}

async function startGeneratedServer(
  root: string,
  manifest: RouteManifest,
  env: Record<string, string> = {},
): Promise<{ process: ChildProcess; port: number }> {
  const port = pickPort();
  const serverDir = join(root, 'dist', 'server');
  const entryPath = join(serverDir, 'entry.mjs');
  const code = generateServerEntry(manifest, root).replace(
    "parseInt(process.env.PORT || '3000', 10)",
    String(port),
  );
  writeFileSync(entryPath, code);

  const child = fork(entryPath, [], {
    cwd: serverDir,
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


function evaluateGeneratedTaskAdminAuth(
  entry: string,
  options: {
    taskSecret?: string;
    nodeEnv?: string;
    authorization?: string;
    remoteAddress?: string;
    forwardedFor?: string;
  },
): boolean {
  const start = entry.indexOf('function _normalizeSocketRemoteAddress');
  const end = entry.indexOf('const server = createServer', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);

  const helperSource = entry.slice(start, end);
  const headers: Record<string, string> = {};
  if (options.authorization) headers.authorization = options.authorization;
  if (options.forwardedFor) headers['x-forwarded-for'] = options.forwardedFor;

  return Function('env', 'headers', 'remoteAddress', `
    const process = { env };
    ${helperSource}
    return _isTaskAdminAuthorized({ headers, socket: { remoteAddress } });
  `)(
    { THEN_TASK_SECRET: options.taskSecret ?? '', NODE_ENV: options.nodeEnv ?? '' },
    headers,
    options.remoteAddress ?? '',
  ) as boolean;
}

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
  it('serves server pages marked stream as chunked full HTML responses', async () => {
    const root = createTempProject();
    writeModule(root, 'dist/server/pages/stream.js', `
export const page = { mode: 'server', stream: true, title: 'Chunked Runtime' };
export default function StreamPage() {
  return { type: 'main', props: { id: 'stream-page' }, children: [
    { type: 'h1', props: {}, children: ['Chunked HTML'] },
    { type: 'p', props: {}, children: ['full body'] }
  ] };
}
`);

    const manifest: RouteManifest = {
      api: [],
      pages: [{
        filePath: 'src/pages/stream.tsx',
        urlPattern: '/stream',
        mode: 'server',
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
    writeModule(root, 'dist/server/api/tasks/cleanup.js', `
export const route = { kind: 'task' };
export async function POST(job) {
  return { ok: true, taskId: job.taskId };
}
`);

    const manifest: RouteManifest = {
      api: [{
        filePath: 'src/api/tasks/cleanup.ts',
        urlPattern: '/api/tasks/cleanup',
        methods: ['POST'],
        kind: 'task',
        config: { kind: 'task' },
      }],
      pages: [],
      layouts: [],
      timestamp: new Date().toISOString(),
    };

    const { port } = await startGeneratedServer(root, manifest, { THEN_TASK_SECRET: '' });
    const res = await httpGet(port, '/__tasks', { 'X-Forwarded-For': '203.0.113.10' });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      tasks: [{ name: 'tasks.cleanup' }],
      queueLength: 0,
      completedJobs: 0,
    });
  }, 10000);

  it('does not trust X-Forwarded-For for generated task admin localhost authorization', () => {
    const manifest: RouteManifest = {
      api: [{
        filePath: 'src/api/tasks/cleanup.ts',
        urlPattern: '/api/tasks/cleanup',
        methods: ['POST'],
        kind: 'task',
        config: { kind: 'task' },
      }],
      pages: [],
      layouts: [],
      timestamp: new Date().toISOString(),
    };

    const entry = generateServerEntry(manifest, '/project');

    expect(entry).not.toContain('x-forwarded-for');
    expect(evaluateGeneratedTaskAdminAuth(entry, {
      remoteAddress: '203.0.113.10',
      forwardedFor: '127.0.0.1',
    })).toBe(false);
    expect(evaluateGeneratedTaskAdminAuth(entry, {
      remoteAddress: '203.0.113.10',
      forwardedFor: '127.0.0.1',
      taskSecret: 'correct-secret',
      authorization: 'Bearer correct-secret',
    })).toBe(true);
    expect(evaluateGeneratedTaskAdminAuth(entry, {
      remoteAddress: '::ffff:127.0.0.1',
      forwardedFor: '203.0.113.10',
      nodeEnv: 'development',
    })).toBe(true);
    expect(evaluateGeneratedTaskAdminAuth(entry, {
      remoteAddress: '::ffff:127.0.0.1',
      forwardedFor: '203.0.113.10',
      nodeEnv: 'production',
    })).toBe(false);
  });

  it('renders nested layouts from outermost to innermost around the page', async () => {
    const root = createTempProject();
    writeModule(root, 'dist/server/pages/_layout.js', `
export default function RootLayout({ children }) {
  return { type: 'section', props: { id: 'root-layout' }, children: [
    { type: 'span', props: {}, children: ['root-before'] }, children,
    { type: 'span', props: {}, children: ['root-after'] }
  ] };
}
`);
    writeModule(root, 'dist/server/pages/blog/_layout.js', `
export default function BlogLayout({ children, params }) {
  return { type: 'article', props: { id: 'blog-layout' }, children: [
    { type: 'span', props: {}, children: ['blog-before-' + params.slug] }, children,
    { type: 'span', props: {}, children: ['blog-after'] }
  ] };
}
`);
    writeModule(root, 'dist/server/pages/blog/[slug].js', `
export const page = { mode: 'server', title: 'Nested Layout' };
export default function Post({ params }) {
  return { type: 'h1', props: {}, children: ['post-' + params.slug] };
}
`);

    const manifest: RouteManifest = {
      api: [],
      pages: [{
        filePath: 'src/pages/blog/[slug].tsx',
        urlPattern: '/blog/:slug',
        mode: 'server',
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
    writeModule(root, 'dist/server/pages/_layout.js', `
export default function BrokenLayout() {
  throw new Error('layout explosion');
}
`);
    writeModule(root, 'dist/server/pages/broken.js', `
export const page = { mode: 'server', title: 'Broken Layout' };
export default function BrokenPage() {
  return { type: 'p', props: {}, children: ['never visible'] };
}
`);

    const manifest: RouteManifest = {
      api: [],
      pages: [{
        filePath: 'src/pages/broken.tsx',
        urlPattern: '/broken',
        mode: 'server',
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
    expect(res.body).toContain('Internal Server Error');
    expect(res.body).not.toContain('layout explosion');
    expect(health.statusCode).toBe(200);
    expect(health.body).toContain('ThenJS');
  }, 10000);

  it('lets an in-flight request complete before SIGTERM exits the process', async () => {
    const root = createTempProject();
    const startedFile = join(root, 'slow-started');
    writeModule(root, 'dist/server/api/slow.js', `
import { writeFileSync } from 'node:fs';

export async function GET(_req, reply) {
  writeFileSync(process.env.SLOW_STARTED_FILE, 'started');
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
});
