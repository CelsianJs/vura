import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deployToVura } from '../src/index.js';

const execFileAsync = promisify(execFile);

async function listArchive(buffer: Buffer): Promise<string[]> {
  const root = await mkdtemp(join(tmpdir(), 'vura-deploy-list-'));
  const archive = join(root, 'artifact.tar.gz');
  try {
    await writeFile(archive, buffer);
    const { stdout } = await execFileAsync('tar', ['-tzf', archive]);
    return stdout.split('\n').filter(Boolean).map((entry) => entry.replace(/^\.\//, '').replace(/\/$/, ''));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function listArchiveVerbose(buffer: Buffer): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vura-deploy-list-'));
  const archive = join(root, 'artifact.tar.gz');
  try {
    await writeFile(archive, buffer);
    const { stdout } = await execFileAsync('tar', ['-tvzf', archive]);
    return stdout;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runFromArchive(buffer: Buffer, script: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vura-deploy-run-'));
  const archive = join(root, 'artifact.tar.gz');
  try {
    await writeFile(archive, buffer);
    await execFileAsync('tar', ['-xzf', archive, '-C', root]);
    const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], { cwd: root });
    return stdout.trim();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * Build a scripted `fetch` mock.
 *
 * The deploy flow makes exactly these calls in order:
 *   1. POST {api}/v1/projects/{projectId}/deployments   → 201 create
 *   then, per poll iteration:
 *   2. GET  {api}/v1/deployments/{id}                    → status
 *   3. GET  {api}/v1/deployments/{id}/logs               → logs
 *
 * We script the status endpoint to return `building` once (with two log
 * lines available) and then `ready`.
 */
function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
  } as unknown as Response;
}

describe('deployToVura', () => {
  let distDir: string;

  beforeEach(async () => {
    distDir = await mkdtemp(join(tmpdir(), 'vura-deploy-test-'));
    await writeFile(join(distDir, 'manifest.json'), JSON.stringify({ pages: [], api: [] }));
    await mkdir(join(distDir, 'static'), { recursive: true });
    await writeFile(join(distDir, 'static', 'index.html'), '<!doctype html>hi');
  });

  afterEach(async () => {
    await rm(distDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('uploads the artifact, streams logs, and resolves when ready', async () => {
    const logLines = [
      { sequence: 1, stream: 'stdout', content: 'Installing deps\n' },
      { sequence: 2, stream: 'stdout', content: 'Build complete\n' },
    ];

    let statusPoll = 0;
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/v1/projects/proj_123/deployments')) {
        expect(init?.method).toBe('POST');
        expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok_abc');
        expect(init?.body).toBeInstanceOf(FormData);
        return jsonResponse(201, { data: { id: 'dep_1', url: 'app.vura.io', status: 'building' } });
      }
      if (u.endsWith('/v1/deployments/dep_1/logs')) {
        return jsonResponse(200, { data: logLines });
      }
      if (u.endsWith('/v1/deployments/dep_1')) {
        statusPoll++;
        return jsonResponse(200, {
          data: { id: 'dep_1', url: 'app.vura.io', status: statusPoll === 1 ? 'building' : 'ready' },
        });
      }
      throw new Error(`unexpected fetch: ${u}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const printed: string[] = [];
    const result = await deployToVura({
      distDir,
      apiUrl: 'https://api.test',
      token: 'tok_abc',
      projectId: 'proj_123',
      production: true,
      pollIntervalMs: 1,
      logger: (line: string) => printed.push(line),
    });

    expect(result).toEqual({ deploymentId: 'dep_1', url: 'https://app.vura.io', status: 'ready' });

    // create + (building poll: status+logs) + (ready poll: status+logs)
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls).toContain('https://api.test/v1/projects/proj_123/deployments');
    expect(urls).toContain('https://api.test/v1/deployments/dep_1');
    expect(urls).toContain('https://api.test/v1/deployments/dep_1/logs');

    // log content surfaced to the logger
    const joined = printed.join('');
    expect(joined).toContain('Installing deps');
    expect(joined).toContain('Build complete');
  });

  it('backs off through rate limits and redacts provider internals from streamed logs', async () => {
    let statusPoll = 0;
    let logPoll = 0;
    const fetchMock = vi.fn(async (url: string | URL) => {
      const value = String(url);
      if (value.endsWith('/v1/projects/proj_123/deployments')) {
        return jsonResponse(201, { data: { id: 'dep_rate', url: 'app.vura.io', status: 'building' } });
      }
      if (value.endsWith('/v1/deployments/dep_rate/logs')) {
        logPoll++;
        if (logPoll === 1) return jsonResponse(429, {}, { 'retry-after': '0.001' });
        return jsonResponse(200, {
          data: [{
            sequence: 1,
            stream: 'stdout',
            content: '[deploy:hot-image] Hot server image pushed: registry.fly.io/vura-hot-app:deployment-1\n',
          }],
        });
      }
      if (value.endsWith('/v1/deployments/dep_rate')) {
        statusPoll++;
        if (statusPoll === 1) return jsonResponse(429, {}, { 'retry-after': '0.001' });
        return jsonResponse(200, { data: { status: 'ready' } });
      }
      throw new Error(`unexpected fetch: ${value}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const printed: string[] = [];
    await expect(deployToVura({
      distDir,
      apiUrl: 'https://api.test',
      token: 'tok_abc',
      projectId: 'proj_123',
      pollIntervalMs: 1,
      maxPolls: 3,
      logger: (line) => printed.push(line),
    })).resolves.toMatchObject({ status: 'ready' });

    const output = printed.join('');
    expect(output).toContain('[deploy:runtime-image] runtime image pushed: managed-runtime-image');
    expect(output).not.toMatch(/fly|hot server image/i);
  });

  it('rejects with meta.build_error when the deployment fails', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/v1/projects/proj_123/deployments')) {
        return jsonResponse(201, { data: { id: 'dep_2', url: 'app.vura.io', status: 'building' } });
      }
      if (u.endsWith('/v1/deployments/dep_2/logs')) {
        return jsonResponse(200, { data: [] });
      }
      if (u.endsWith('/v1/deployments/dep_2')) {
        return jsonResponse(200, {
          data: { id: 'dep_2', status: 'failed', meta: { build_error: 'esbuild exited 1' } },
        });
      }
      throw new Error(`unexpected fetch: ${u}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      deployToVura({
        distDir,
        apiUrl: 'https://api.test',
        token: 'tok_abc',
        projectId: 'proj_123',
        pollIntervalMs: 1,
        logger: () => {},
      }),
    ).rejects.toThrow('esbuild exited 1');
  });

  it('uploads a portable project-root context for Dedicated routes with pnpm-style dependency links', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'vura-deploy-hot-'));
    const hotDist = join(projectRoot, 'dist');
    let uploaded: Buffer | undefined;

    try {
      await mkdir(join(hotDist, 'server'), { recursive: true });
      const virtualStore = join(projectRoot, 'node_modules', '.pnpm');
      const pkg = join(virtualStore, 'pkg@1.0.0', 'node_modules', 'pkg');
      const dep = join(virtualStore, 'dep@1.0.0', 'node_modules', 'dep');
      await mkdir(join(pkg, 'node_modules'), { recursive: true });
      await mkdir(join(dep, 'node_modules'), { recursive: true });
      await writeFile(join(projectRoot, 'package.json'), JSON.stringify({ type: 'module' }));
      await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'pkg', type: 'module', main: 'index.js' }));
      await writeFile(join(pkg, 'index.js'), "import dep from 'dep'; export default dep + 1");
      await writeFile(join(dep, 'package.json'), JSON.stringify({ name: 'dep', type: 'module', main: 'index.js' }));
      await writeFile(join(dep, 'index.js'), 'export default 2');
      await symlink('../../../../dep@1.0.0/node_modules/dep', join(pkg, 'node_modules', 'dep'), 'dir');
      await symlink('../../../../pkg@1.0.0/node_modules/pkg', join(dep, 'node_modules', 'pkg'), 'dir');
      await symlink('.pnpm/pkg@1.0.0/node_modules/pkg', join(projectRoot, 'node_modules', 'pkg'), 'dir');
      await writeFile(join(hotDist, 'server', 'entry.js'), 'console.log("hot")');

      const manifest = {
        api: [{ urlPattern: '/api/hot', kind: 'hot' }],
        pages: [],
        timestamp: 't',
      };
      await writeFile(join(hotDist, 'manifest.json'), JSON.stringify(manifest));

      const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        if (u.endsWith('/v1/projects/proj_hot/deployments')) {
          const artifact = (init?.body as FormData).get('artifact');
          expect(artifact).toBeInstanceOf(Blob);
          uploaded = Buffer.from(await (artifact as Blob).arrayBuffer());
          return jsonResponse(201, { data: { id: 'dep_hot', url: 'hot.vura.test', status: 'building' } });
        }
        if (u.endsWith('/v1/deployments/dep_hot/logs')) return jsonResponse(200, { data: [] });
        if (u.endsWith('/v1/deployments/dep_hot')) return jsonResponse(200, { data: { status: 'ready' } });
        throw new Error(`unexpected fetch: ${u}`);
      });
      vi.stubGlobal('fetch', fetchMock);

      await deployToVura({
        distDir: hotDist,
        projectRoot,
        apiUrl: 'https://api.test',
        token: 'tok_abc',
        projectId: 'proj_hot',
        manifest,
        pollIntervalMs: 1,
        logger: () => {},
      });

      expect(uploaded).toBeDefined();
      const entries = await listArchive(uploaded!);
      expect(entries).toContain('dist/manifest.json');
      expect(entries).toContain('dist/server/entry.js');
      expect(entries).toContain('package.json');
      expect(entries).toContain('node_modules/pkg/index.js');
      expect(entries).toContain('node_modules/pkg/node_modules/dep/index.js');
      expect(entries.some((entry) => entry.startsWith('node_modules/.pnpm'))).toBe(false);
      expect(await listArchiveVerbose(uploaded!)).not.toContain(' -> ');
      expect(await runFromArchive(uploaded!, "import('pkg').then((mod) => console.log(mod.default))"))
        .toBe('3');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects dependency links that resolve outside the project before upload', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'vura-deploy-external-link-'));
    const externalRoot = await mkdtemp(join(tmpdir(), 'vura-deploy-outside-'));
    const hotDist = join(projectRoot, 'dist');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    try {
      await mkdir(hotDist, { recursive: true });
      await mkdir(join(projectRoot, 'node_modules'), { recursive: true });
      await writeFile(join(projectRoot, 'package.json'), JSON.stringify({ type: 'module' }));
      await writeFile(join(externalRoot, 'secret.txt'), 'must-not-be-uploaded');
      await symlink(externalRoot, join(projectRoot, 'node_modules', 'outside-link'), 'dir');
      await writeFile(join(hotDist, 'manifest.json'), JSON.stringify({ api: [{ kind: 'hot' }], pages: [] }));

      await expect(deployToVura({
        distDir: hotDist,
        projectRoot,
        apiUrl: 'https://api.test',
        token: 'tok_abc',
        projectId: 'proj_hot',
        logger: () => {},
      })).rejects.toThrow(/outside its allowed deploy tree/);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
      await rm(externalRoot, { recursive: true, force: true });
    }
  });

  it('rejects dependency links to project secrets before upload', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'vura-deploy-secret-link-'));
    const hotDist = join(projectRoot, 'dist');
    const pkg = join(projectRoot, 'node_modules', 'pkg');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    try {
      await mkdir(hotDist, { recursive: true });
      await mkdir(pkg, { recursive: true });
      await writeFile(join(projectRoot, 'package.json'), JSON.stringify({ type: 'module' }));
      await writeFile(join(projectRoot, '.env'), 'PRIVATE_REVIEW_SECRET=must-not-upload');
      await symlink('../../.env', join(pkg, 'leaked-env'));
      await writeFile(join(hotDist, 'manifest.json'), JSON.stringify({ api: [{ kind: 'hot' }], pages: [] }));

      await expect(deployToVura({
        distDir: hotDist,
        projectRoot,
        apiUrl: 'https://api.test',
        token: 'tok_abc',
        projectId: 'proj_hot',
        logger: () => {},
      })).rejects.toThrow(/outside its allowed deploy tree/);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('keeps Function-only uploads lean even when projectRoot is available', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'vura-deploy-function-'));
    const functionDist = join(projectRoot, 'dist');
    let uploaded: Buffer | undefined;

    try {
      await mkdir(join(projectRoot, 'node_modules', 'pkg'), { recursive: true });
      await mkdir(join(functionDist, 'functions', 'api_hello'), { recursive: true });
      await writeFile(join(projectRoot, 'package.json'), JSON.stringify({ type: 'module' }));
      await writeFile(join(projectRoot, 'node_modules', 'pkg', 'large.js'), 'not needed');
      await writeFile(join(functionDist, 'functions', 'api_hello', 'index.js'), 'export default {}');

      const manifest = {
        api: [{ urlPattern: '/api/hello', kind: 'serverless' }],
        pages: [],
        timestamp: 't',
      };
      await writeFile(join(functionDist, 'manifest.json'), JSON.stringify(manifest));

      const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        if (u.endsWith('/v1/projects/proj_function/deployments')) {
          const artifact = (init?.body as FormData).get('artifact') as Blob;
          uploaded = Buffer.from(await artifact.arrayBuffer());
          return jsonResponse(201, { data: { id: 'dep_function', url: 'function.vura.test', status: 'building' } });
        }
        if (u.endsWith('/v1/deployments/dep_function/logs')) return jsonResponse(200, { data: [] });
        if (u.endsWith('/v1/deployments/dep_function')) return jsonResponse(200, { data: { status: 'ready' } });
        throw new Error(`unexpected fetch: ${u}`);
      });
      vi.stubGlobal('fetch', fetchMock);

      await deployToVura({
        distDir: functionDist,
        projectRoot,
        apiUrl: 'https://api.test',
        token: 'tok_abc',
        projectId: 'proj_function',
        manifest,
        pollIntervalMs: 1,
        logger: () => {},
      });

      expect(uploaded).toBeDefined();
      const entries = await listArchive(uploaded!);
      expect(entries).toContain('manifest.json');
      expect(entries).toContain('functions/api_hello/index.js');
      expect(entries).not.toContain('dist/manifest.json');
      expect(entries).not.toContain('package.json');
      expect(entries.some((entry) => entry.startsWith('node_modules'))).toBe(false);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it.each([
    { label: 'Dedicated API route', manifest: { api: [{ kind: 'hot' }], pages: [] } },
    { label: 'server page', manifest: { api: [], pages: [{ mode: 'server' }] } },
    { label: 'hybrid page', manifest: { api: [], pages: [{ mode: 'hybrid' }] } },
  ])('fails before upload when a $label lacks project context', async ({ manifest }) => {
    const root = await mkdtemp(join(tmpdir(), 'vura-deploy-context-required-'));
    const built = join(root, 'dist');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    try {
      await mkdir(built, { recursive: true });
      await writeFile(join(built, 'manifest.json'), JSON.stringify(manifest));
      await expect(deployToVura({
        distDir: built,
        apiUrl: 'https://api.test',
        token: 'tok_abc',
        projectId: 'proj_hot',
        // A stale supplied manifest must not override the built artifact.
        manifest: { api: [], pages: [] },
        logger: () => {},
      })).rejects.toThrow(/projectRoot deploy context/);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
