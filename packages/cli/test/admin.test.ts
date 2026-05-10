import { describe, expect, it } from 'vitest';
import { adminApiHeaders, isAllowedAdminRequest, isLocalAdminHost, parseAdminOptions } from '../src/commands/admin.js';

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

  it('classifies non-local admin hosts as unsafe to bind silently', () => {
    expect(isLocalAdminHost('127.0.0.1')).toBe(true);
    expect(isLocalAdminHost('localhost')).toBe(true);
    expect(isLocalAdminHost('::1')).toBe(true);
    expect(isLocalAdminHost('0.0.0.0')).toBe(false);
    expect(isLocalAdminHost('192.168.1.10')).toBe(false);
  });
});

describe('CLI admin API browser boundary', () => {
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

  it('does not emit wildcard CORS headers for secret-bearing admin APIs', () => {
    expect(adminApiHeaders()).toEqual({
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    expect(adminApiHeaders()).not.toHaveProperty('Access-Control-Allow-Origin');
  });
});
