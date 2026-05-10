import { describe, expect, it } from 'vitest';
import { isTaskAdminRequestAuthorized } from '../src/index.js';

describe('Vite task middleware authorization', () => {
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
    expect(isTaskAdminRequestAuthorized({}, '::1', { THEN_TASK_SECRET: '', NODE_ENV: 'development' })).toBe(true);
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
