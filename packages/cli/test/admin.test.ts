import { describe, expect, it } from 'vitest';
import {
  adminApiHeaders,
  assertSafeAdminBindHost,
  isAllowedAdminRequest,
  isLocalAdminHost,
  parseAdminOptions,
  renderDashboardHtml,
} from '../src/commands/admin.js';

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
    expect(adminApiHeaders()).not.toHaveProperty('Access-Control-Allow-Origin');
  });
});
