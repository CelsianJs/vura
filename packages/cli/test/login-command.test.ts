import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { loginCommand } from '../src/commands/login.js';

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

describe('CLI login command', () => {
  let fakeHome: string;
  const savedEnv = { ...process.env };
  const originalIsTTY = process.stdin.isTTY;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'vura-login-home-'));
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    delete process.env.VURA_TOKEN;
    delete process.env.VURA_API_URL;
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    process.exitCode = undefined;
    Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    rmSync(fakeHome, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function readCredentials(): Record<string, unknown> {
    return JSON.parse(readFileSync(join(fakeHome, '.vura', 'credentials'), 'utf-8'));
  }

  describe('--token mode (paste-token)', () => {
    it('verifies the token against /v1/auth/me and stores it on success', async () => {
      const fetchMock = vi.fn(async (url: string | URL) => {
        expect(String(url)).toBe('https://api.test/v1/auth/me');
        return jsonResponse(200, { user: { email: 'kirby@vura.dev' } });
      });
      vi.stubGlobal('fetch', fetchMock);

      const restore = withSilencedConsole();
      try {
        await loginCommand(['--token', 'tok_pasted', '--api-url', 'https://api.test']);
      } finally {
        restore();
      }

      expect(process.exitCode).toBeFalsy();
      const creds = readCredentials();
      expect(creds).toMatchObject({ token: 'tok_pasted', email: 'kirby@vura.dev' });
    });

    it('rejects an invalid token without writing credentials', async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse(401, { error: { code: 'AUTH_UNAUTHORIZED', message: 'Invalid or expired token' } }),
      );
      vi.stubGlobal('fetch', fetchMock);

      const restore = withSilencedConsole();
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await loginCommand(['--token', 'tok_bad', '--api-url', 'https://api.test']);
      } finally {
        restore();
      }

      expect(process.exitCode).toBe(1);
      expect(() => readCredentials()).toThrow();
      const messages = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(messages).toMatch(/Invalid or expired token/);
    });
  });

  describe('interactive mode', () => {
    it('prompts for email/password, logs in, and stores the returned token', async () => {
      const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
        expect(String(url)).toBe('https://api.test/v1/auth/login');
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toEqual({ email: 'kirby@vura.dev', password: 'hunter2' });
        return jsonResponse(200, {
          token: 'tok_fresh',
          refreshToken: 'refresh_fresh',
          user: { email: 'kirby@vura.dev' },
        });
      });
      vi.stubGlobal('fetch', fetchMock);
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

      const io = {
        prompt: vi.fn(async () => 'kirby@vura.dev'),
        promptPassword: vi.fn(async () => 'hunter2'),
      };

      const restore = withSilencedConsole();
      try {
        await loginCommand(['--api-url', 'https://api.test'], io);
      } finally {
        restore();
      }

      expect(process.exitCode).toBeFalsy();
      const creds = readCredentials();
      expect(creds).toMatchObject({ token: 'tok_fresh', email: 'kirby@vura.dev', refreshToken: 'refresh_fresh' });
    });

    it('surfaces invalid-credentials errors from the API', async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse(401, { error: { code: 'AUTH_INVALID_CREDENTIALS', message: 'Invalid email or password' } }),
      );
      vi.stubGlobal('fetch', fetchMock);
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

      const io = {
        prompt: vi.fn(async () => 'kirby@vura.dev'),
        promptPassword: vi.fn(async () => 'wrong'),
      };

      const restore = withSilencedConsole();
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await loginCommand(['--api-url', 'https://api.test'], io);
      } finally {
        restore();
      }

      expect(process.exitCode).toBe(1);
      expect(() => readCredentials()).toThrow();
      const messages = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(messages).toMatch(/Invalid email or password/);
    });

    it('refuses to prompt when stdin is not a TTY', async () => {
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

      const io = {
        prompt: vi.fn(async () => 'kirby@vura.dev'),
        promptPassword: vi.fn(async () => 'hunter2'),
      };

      const restore = withSilencedConsole();
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await loginCommand(['--api-url', 'https://api.test'], io);
      } finally {
        restore();
      }

      expect(process.exitCode).toBe(1);
      expect(io.prompt).not.toHaveBeenCalled();
      const messages = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(messages).toMatch(/requires a terminal/);
    });
  });
});
