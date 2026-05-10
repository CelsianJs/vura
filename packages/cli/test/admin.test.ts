import { describe, expect, it } from 'vitest';
import { isLocalAdminHost, parseAdminOptions } from '../src/commands/admin.js';

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
