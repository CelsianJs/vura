import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deployToVura } from '../src/index.js';

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
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
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
});
