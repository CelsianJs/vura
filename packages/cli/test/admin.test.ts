import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { request as httpRequest } from 'node:http';
import {
  ADMIN_ENV_MAX_BODY_BYTES,
  adminApiHeaders,
  assertSafeAdminBindHost,
  isAllowedAdminRequest,
  isLocalAdminHost,
  parseAdminOptions,
  renderDashboardHtml,
  startAdminServer,
} from '../src/commands/admin.js';
import { deployCommand } from '../src/commands/deploy.js';

describe('CLI admin options', () => {
  it('binds to loopback by default', () => {
    expect(parseAdminOptions([], '/project')).toEqual({
      port: 4000,
      host: '127.0.0.1',
      projectRoot: '/project',
    });
  });

  it('accepts an explicit host and port', () => {
    expect(parseAdminOptions(['--host', '0.0.0.0', '--port', '9000'], '/project')).toEqual({
      port: 9000,
      host: '0.0.0.0',
      projectRoot: '/project',
    });
  });

  it('refuses non-loopback binds because the dashboard manages secrets', () => {
    expect(() => assertSafeAdminBindHost('127.0.0.1')).not.toThrow();
    expect(() => assertSafeAdminBindHost('0.0.0.0')).toThrow('Refusing unsafe host');
    expect(() => assertSafeAdminBindHost('192.168.1.10')).toThrow('Refusing unsafe host');
  });

  it('classifies non-local admin hosts as unsafe to bind silently', () => {
    expect(isLocalAdminHost('127.0.0.1')).toBe(true);
    expect(isLocalAdminHost('localhost')).toBe(true);
    expect(isLocalAdminHost('::1')).toBe(true);
    expect(isLocalAdminHost('0.0.0.0')).toBe(false);
    expect(isLocalAdminHost('192.168.1.10')).toBe(false);
  });
});

describe('CLI admin dashboard rendering', () => {
  it('uses tokenized fetch with JSON headers for env saves', () => {
    const html = renderDashboardHtml('test-token');
    expect(html).toContain("'X-Then-Admin-Token': ADMIN_TOKEN");
    expect(html).toContain("headers: { 'Content-Type': 'application/json' }");
    expect(html).toContain('if (!response.ok)');
    expect(html).toContain('function quoteEnvValue(value)');
    expect(html).not.toContain('headers: apiHeaders');
  });

  it('escapes dynamic HTML before injecting admin state into templates', () => {
    const html = renderDashboardHtml('test-token');
    expect(html).toContain('function h(value)');
    expect(html).toContain('${h(p.name)}');
    expect(html).toContain('${h(d.label)}');
    expect(html).toContain('value="${h(v.value)}"');
  });
});

describe('CLI admin API browser boundary', () => {
  it('limits admin env save bodies to a small local payload', () => {
    expect(ADMIN_ENV_MAX_BODY_BYTES).toBe(128 * 1024);
  });

  it('allows same-origin localhost API requests', () => {
    expect(isAllowedAdminRequest({ host: '127.0.0.1:4000' }, '127.0.0.1', 4000)).toBe(true);
    expect(isAllowedAdminRequest({ host: 'localhost:4000', origin: 'http://localhost:4000' }, '127.0.0.1', 4000)).toBe(true);
  });

  it('rejects cross-origin localhost requests from arbitrary websites', () => {
    expect(isAllowedAdminRequest({ host: '127.0.0.1:4000', origin: 'https://evil.example' }, '127.0.0.1', 4000)).toBe(false);
  });

  it('rejects host header confusion against the local admin port', () => {
    expect(isAllowedAdminRequest({ host: 'evil.example:4000' }, '127.0.0.1', 4000)).toBe(false);
    expect(isAllowedAdminRequest({ host: '127.0.0.1:9999' }, '127.0.0.1', 4000)).toBe(false);
  });

  it('rejects unsafe bind hosts even if the Host header matches', () => {
    expect(isAllowedAdminRequest({ host: '0.0.0.0:4000' }, '0.0.0.0', 4000)).toBe(false);
    expect(isAllowedAdminRequest({ host: '192.168.1.10:4000' }, '192.168.1.10', 4000)).toBe(false);
  });

  it('does not emit wildcard CORS headers for secret-bearing admin APIs', () => {
    expect(adminApiHeaders()).toEqual({
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    expect(adminApiHeaders('text/html; charset=utf-8')).toEqual({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    expect(adminApiHeaders()).not.toHaveProperty('Access-Control-Allow-Origin');
  });
});

describe('CLI deploy command', () => {
  it('fails closed (exit 1) when no credentials are present, without leaking marketing copy', async () => {
    const error = console.error;
    const log = console.log;
    const messages: string[] = [];
    console.error = (message?: unknown) => { messages.push(String(message)); };
    console.log = () => {};
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;

    // Ensure no ambient credentials/env so the auth gate trips deterministically.
    const savedToken = process.env.VURA_TOKEN;
    const savedHome = process.env.HOME;
    const savedUserProfile = process.env.USERPROFILE;
    delete process.env.VURA_TOKEN;
    // Point HOME at a dir with no ~/.vura/credentials so the file read misses.
    process.env.HOME = process.env.USERPROFILE = '/nonexistent-vura-home';

    try {
      await deployCommand([]);
      expect(process.exitCode).toBe(1);
      expect(messages.join('\n')).toMatch(/authenticat/i);
      expect(messages.join('\n')).not.toContain('thenjs.dev');
      expect(messages.join('\n')).not.toContain('celsian.dev');
      expect(messages.join('\n')).not.toContain('Cloudflare');
    } finally {
      console.error = error;
      console.log = log;
      process.exitCode = previousExitCode;
      if (savedToken === undefined) delete process.env.VURA_TOKEN; else process.env.VURA_TOKEN = savedToken;
      if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
      if (savedUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedUserProfile;
    }
  });
});

describe('CLI admin server on an OS-assigned port', () => {
  // `isAllowedAdminRequest` is unit-tested above and was always correct. The
  // bug was in its caller: `vura admin --port 0` built the allowlist from the
  // *requested* port, so it held `localhost:0` while the browser sent the real
  // one, and every API request was refused as cross-origin even with a valid
  // token. Only a real server can catch that, so this boots one.
  let admin: Awaited<ReturnType<typeof startAdminServer>>;

  beforeAll(async () => {
    admin = await startAdminServer({
      port: 0,
      host: '127.0.0.1',
      projectRoot: process.cwd(),
    } as any);
  }, 30_000);

  afterAll(async () => {
    await admin?.close();
  });

  // Raw http, not fetch: `Host` is a forbidden header name, so undici silently
  // replaces whatever you pass with the real authority. A fetch-based version
  // of the spoofed-Host case below returned 200 and proved nothing.
  const api = (headers: Record<string, string>): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port: admin.port, path: '/__admin/api/manifest', method: 'GET', headers },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { body += c; });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on('error', reject);
      req.end();
    });

  it('binds a real port rather than reporting the requested 0', () => {
    expect(admin.port).toBeGreaterThan(0);
  });

  it('serves the admin API to a same-origin request carrying the token', async () => {
    const res = await api({
      host: `localhost:${admin.port}`,
      'x-then-admin-token': admin.token,
    });
    expect(res.status).toBe(200);
    expect(() => JSON.parse(res.body)).not.toThrow();
  }, 30_000);

  it('still refuses a request with no token', async () => {
    const res = await api({ host: `localhost:${admin.port}` });
    expect(res.status).toBe(403);
  }, 30_000);

  it('still refuses a spoofed Host header', async () => {
    const res = await api({
      host: `evil.example:${admin.port}`,
      'x-then-admin-token': admin.token,
    });
    expect(res.status).toBe(403);
  }, 30_000);
});
