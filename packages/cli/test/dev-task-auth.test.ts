import { describe, expect, it } from 'vitest';
import { isLanDevHost, isTaskAdminRequestAuthorized, parseDevOptions } from '../src/commands/dev.js';

describe('CLI dev task admin authorization', () => {
  it('does not trust X-Forwarded-For for localhost authorization', () => {
    expect(isTaskAdminRequestAuthorized(
      { authorization: undefined, 'x-forwarded-for': '127.0.0.1' } as any,
      '203.0.113.10',
      { THEN_TASK_SECRET: '', NODE_ENV: 'development' },
    )).toBe(false);
  });

  it('requires THEN_TASK_SECRET for localhost task admin in production', () => {
    expect(isTaskAdminRequestAuthorized({}, '127.0.0.1', { THEN_TASK_SECRET: '', NODE_ENV: 'production' })).toBe(false);
  });

  it('allows true socket-local requests in development and correct bearer tokens in production', () => {
    expect(isTaskAdminRequestAuthorized({}, '::ffff:127.0.0.1', { THEN_TASK_SECRET: '', NODE_ENV: 'development' })).toBe(true);
    expect(isTaskAdminRequestAuthorized(
      { authorization: 'Bearer correct-secret' },
      '203.0.113.10',
      { THEN_TASK_SECRET: 'correct-secret', NODE_ENV: 'production' },
    )).toBe(true);
    expect(isTaskAdminRequestAuthorized(
      { authorization: 'Bearer wrong-secret' },
      '203.0.113.10',
      { THEN_TASK_SECRET: 'correct-secret', NODE_ENV: 'production' },
    )).toBe(false);
  });
});

describe('CLI dev host options', () => {
  it('binds to loopback by default', () => {
    expect(parseDevOptions([], '/project')).toEqual({
      port: 3000,
      host: '127.0.0.1',
      projectRoot: '/project',
    });
  });

  it('requires explicit host selection for LAN exposure', () => {
    expect(parseDevOptions(['--host', '0.0.0.0', '--port', '5173'], '/project')).toEqual({
      port: 5173,
      host: '0.0.0.0',
      projectRoot: '/project',
    });
    expect(isLanDevHost('127.0.0.1')).toBe(false);
    expect(isLanDevHost('localhost')).toBe(false);
    expect(isLanDevHost('0.0.0.0')).toBe(true);
    expect(isLanDevHost('192.168.1.10')).toBe(true);
  });
});
