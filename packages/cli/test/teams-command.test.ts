import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { teamsCommand } from '../src/commands/teams.js';

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

describe('CLI teams command', () => {
  const savedEnv = { ...process.env };
  let fakeHome: string;

  beforeEach(() => {
    // Point HOME at an empty temp dir so a real ~/.vura/credentials on the
    // machine running this suite can never leak in as a fallback token.
    fakeHome = mkdtempSync(join(tmpdir(), 'vura-teams-home-'));
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
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('errors with a `vura login` hint when no token is available', async () => {
    delete process.env.VURA_TOKEN;
    const restore = withSilencedConsole();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await teamsCommand(['list']);
    } finally {
      restore();
    }
    expect(process.exitCode).toBe(1);
    expect(errSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/vura login/);
  });

  it('lists teams from GET /v1/teams', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.test/v1/teams');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok_abc');
      return jsonResponse(200, {
        data: [{ id: 't1', name: 'Acme', slug: 'acme', role: 'owner', plan: 'free' }],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const logs: string[] = [];
    const restore = withSilencedConsole();
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.join(' '));
    });
    try {
      await teamsCommand(['list']);
    } finally {
      restore();
      logSpy.mockRestore();
    }

    expect(process.exitCode).toBeFalsy();
    expect(logs.join('\n')).toMatch(/acme/);
    expect(logs.join('\n')).toMatch(/Acme/);
  });

  it('creates a team, deriving the slug from the name', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.test/v1/teams');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({ name: 'My Cool Team', slug: 'my-cool-team' });
      return jsonResponse(201, { data: { id: 't2', name: 'My Cool Team', slug: 'my-cool-team' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const restore = withSilencedConsole();
    try {
      await teamsCommand(['create', 'My Cool Team']);
    } finally {
      restore();
    }

    expect(process.exitCode).toBeFalsy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('honors an explicit --slug flag over the derived one', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ name: 'My Cool Team', slug: 'custom-slug' });
      return jsonResponse(201, { data: { id: 't3', name: 'My Cool Team', slug: 'custom-slug' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const restore = withSilencedConsole();
    try {
      await teamsCommand(['create', 'My Cool Team', '--slug', 'custom-slug']);
    } finally {
      restore();
    }

    expect(process.exitCode).toBeFalsy();
  });

  it('surfaces a 409 slug-taken error from the API', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(409, { error: { code: 'TEAM_SLUG_TAKEN', message: 'Team slug is already taken' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const restore = withSilencedConsole();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await teamsCommand(['create', 'Acme']);
    } finally {
      restore();
    }

    expect(process.exitCode).toBe(1);
    expect(errSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/already taken/);
  });

  it('errors on unknown subcommands', async () => {
    const restore = withSilencedConsole();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await teamsCommand(['bogus']);
    } finally {
      restore();
    }
    expect(process.exitCode).toBe(1);
    expect(errSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/Unknown subcommand/);
  });
});
