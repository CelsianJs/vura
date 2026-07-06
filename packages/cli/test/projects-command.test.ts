import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { projectsCommand } from '../src/commands/projects.js';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function withSilencedConsole(): () => void {
  const log = console.log;
  const error = console.error;
  console.log = () => {};
  console.error = () => {};
  return () => {
    console.log = log;
    console.error = error;
  };
}

describe('CLI projects command', () => {
  const savedEnv = { ...process.env };
  let fakeHome: string;
  let root: string;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'vura-projects-home-'));
    root = realpathSync(mkdtempSync(join(tmpdir(), 'vura-projects-root-')));
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    process.env.VURA_TOKEN = 'tok_abc';
    process.env.VURA_API_URL = 'https://api.test';
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    process.exitCode = undefined;
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('list', () => {
    it('resolves a single team automatically when --team is omitted', async () => {
      const fetchMock = vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u === 'https://api.test/v1/teams') {
          return jsonResponse(200, { data: [{ id: 't1', name: 'Acme', slug: 'acme', role: 'owner' }] });
        }
        if (u === 'https://api.test/v1/projects?teamId=t1') {
          return jsonResponse(200, { data: [{ id: 'p1', name: 'My App', slug: 'my-app' }] });
        }
        throw new Error(`unexpected fetch: ${u}`);
      });
      vi.stubGlobal('fetch', fetchMock);

      const logs: string[] = [];
      const restore = withSilencedConsole();
      const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));
      try {
        await projectsCommand(['list'], root);
      } finally {
        restore();
        logSpy.mockRestore();
      }

      expect(process.exitCode).toBeFalsy();
      expect(logs.join('\n')).toMatch(/my-app/);
    });

    it('errors with a disambiguation hint when the caller has multiple teams', async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse(200, {
          data: [
            { id: 't1', name: 'Acme', slug: 'acme' },
            { id: 't2', name: 'Widgets', slug: 'widgets' },
          ],
        }),
      );
      vi.stubGlobal('fetch', fetchMock);

      const restore = withSilencedConsole();
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await projectsCommand(['list'], root);
      } finally {
        restore();
      }

      expect(process.exitCode).toBe(1);
      const messages = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(messages).toMatch(/--team/);
      expect(messages).toMatch(/acme/);
      expect(messages).toMatch(/widgets/);
    });

    it('resolves a UUID --team flag directly without a lookup round trip', async () => {
      const teamId = '11111111-2222-3333-4444-555555555555';
      const fetchMock = vi.fn(async (url: string | URL) => {
        expect(String(url)).toBe(`https://api.test/v1/projects?teamId=${teamId}`);
        return jsonResponse(200, { data: [] });
      });
      vi.stubGlobal('fetch', fetchMock);

      const restore = withSilencedConsole();
      try {
        await projectsCommand(['list', '--team', teamId], root);
      } finally {
        restore();
      }

      expect(process.exitCode).toBeFalsy();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('resolves a slug --team flag via GET /v1/teams/:slug', async () => {
      const fetchMock = vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u === 'https://api.test/v1/teams/acme') {
          return jsonResponse(200, { data: { id: 't1', name: 'Acme', slug: 'acme' } });
        }
        if (u === 'https://api.test/v1/projects?teamId=t1') {
          return jsonResponse(200, { data: [] });
        }
        throw new Error(`unexpected fetch: ${u}`);
      });
      vi.stubGlobal('fetch', fetchMock);

      const restore = withSilencedConsole();
      try {
        await projectsCommand(['list', '--team', 'acme'], root);
      } finally {
        restore();
      }

      expect(process.exitCode).toBeFalsy();
    });
  });

  describe('create', () => {
    it('creates a project and links the directory when it looks like a Vura project root', async () => {
      writeFileSync(join(root, 'vura.config.ts'), 'export default {};\n');

      const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        if (u === 'https://api.test/v1/teams') {
          return jsonResponse(200, { data: [{ id: 't1', name: 'Acme', slug: 'acme' }] });
        }
        if (u === 'https://api.test/v1/projects') {
          expect(init?.method).toBe('POST');
          expect(JSON.parse(String(init?.body))).toEqual({ name: 'My App', teamId: 't1' });
          return jsonResponse(201, { data: { id: 'p1', name: 'My App', slug: 'my-app' } });
        }
        throw new Error(`unexpected fetch: ${u}`);
      });
      vi.stubGlobal('fetch', fetchMock);

      const restore = withSilencedConsole();
      try {
        await projectsCommand(['create', 'My App'], root);
      } finally {
        restore();
      }

      expect(process.exitCode).toBeFalsy();
      const link = JSON.parse(readFileSync(join(root, '.vura', 'project.json'), 'utf-8'));
      expect(link).toEqual({ projectId: 'p1', teamId: 't1', teamSlug: 'acme' });
    });

    it('does not link when the directory has no vura.config.* (not a project root)', async () => {
      const fetchMock = vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u === 'https://api.test/v1/teams') {
          return jsonResponse(200, { data: [{ id: 't1', name: 'Acme', slug: 'acme' }] });
        }
        return jsonResponse(201, { data: { id: 'p1', name: 'My App', slug: 'my-app' } });
      });
      vi.stubGlobal('fetch', fetchMock);

      const restore = withSilencedConsole();
      try {
        await projectsCommand(['create', 'My App'], root);
      } finally {
        restore();
      }

      expect(process.exitCode).toBeFalsy();
      expect(() => readFileSync(join(root, '.vura', 'project.json'), 'utf-8')).toThrow();
    });

    it('does not overwrite an existing project link', async () => {
      writeFileSync(join(root, 'vura.config.ts'), 'export default {};\n');
      mkdirSync(join(root, '.vura'), { recursive: true });
      writeFileSync(join(root, '.vura', 'project.json'), JSON.stringify({ projectId: 'existing' }));

      const fetchMock = vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u === 'https://api.test/v1/teams') {
          return jsonResponse(200, { data: [{ id: 't1', name: 'Acme', slug: 'acme' }] });
        }
        return jsonResponse(201, { data: { id: 'p1', name: 'My App', slug: 'my-app' } });
      });
      vi.stubGlobal('fetch', fetchMock);

      const restore = withSilencedConsole();
      try {
        await projectsCommand(['create', 'My App'], root);
      } finally {
        restore();
      }

      expect(process.exitCode).toBeFalsy();
      const link = JSON.parse(readFileSync(join(root, '.vura', 'project.json'), 'utf-8'));
      expect(link).toEqual({ projectId: 'existing' });
    });

    it('requires a name argument', async () => {
      const restore = withSilencedConsole();
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await projectsCommand(['create'], root);
      } finally {
        restore();
      }
      expect(process.exitCode).toBe(1);
      expect(errSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/Usage/);
    });
  });

  it('errors with a `vura login` hint when no token is available', async () => {
    delete process.env.VURA_TOKEN;
    const restore = withSilencedConsole();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await projectsCommand(['list'], root);
    } finally {
      restore();
    }
    expect(process.exitCode).toBe(1);
    expect(errSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/vura login/);
  });
});
