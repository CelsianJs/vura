import { describe, expect, it, vi } from 'vitest';

import { isRetryableRegistryInstallError, retryNpmInstall } from './retry-npm-install.mjs';

function fakeSleep(record) {
  return async (ms) => {
    record.push(ms);
  };
}

describe('isRetryableRegistryInstallError', () => {
  it('matches the npm error shapes seen during registry propagation lag', () => {
    expect(isRetryableRegistryInstallError(new Error('npm error code ETARGET'))).toBe(true);
    expect(
      isRetryableRegistryInstallError(
        new Error('npm error notarget No matching version found for @celsian/vura-adapter-lambda@0.5.3.'),
      ),
    ).toBe(true);
    expect(isRetryableRegistryInstallError(new Error('404 Not Found - GET https://registry.npmjs.org/foo'))).toBe(true);
    expect(isRetryableRegistryInstallError(new Error('E404'))).toBe(true);
  });

  it('does not match unrelated failures', () => {
    expect(isRetryableRegistryInstallError(new Error('EACCES: permission denied'))).toBe(false);
    expect(isRetryableRegistryInstallError(new Error('npm error 401 Unauthorized'))).toBe(false);
    expect(isRetryableRegistryInstallError(new Error('ENOSPC: no space left on device'))).toBe(false);
  });
});

describe('retryNpmInstall', () => {
  it('returns the result on first success without sleeping', async () => {
    const sleeps = [];
    const results = [];
    const value = await retryNpmInstall(
      async (attempt) => {
        expect(attempt).toBe(1);
        return 'ok';
      },
      { sleep: fakeSleep(sleeps), onAttemptResult: (info) => results.push(info) },
    );
    expect(value).toBe('ok');
    expect(sleeps).toEqual([]);
    expect(results).toEqual([{ attempt: 1, attempts: 20, status: 'passed' }]);
  });

  it('retries retryable failures with the configured delay and eventually succeeds', async () => {
    const sleeps = [];
    let calls = 0;
    const value = await retryNpmInstall(
      async (attempt) => {
        calls += 1;
        if (attempt < 3) throw new Error('npm error code ETARGET');
        return 'recovered';
      },
      { attempts: 5, delayMs: 15_000, sleep: fakeSleep(sleeps) },
    );
    expect(value).toBe('recovered');
    expect(calls).toBe(3);
    expect(sleeps).toEqual([15_000, 15_000]);
  });

  it('throws immediately on a non-retryable error without sleeping or retrying', async () => {
    const sleeps = [];
    let calls = 0;
    await expect(
      retryNpmInstall(
        async () => {
          calls += 1;
          throw new Error('EACCES: permission denied');
        },
        { attempts: 5, sleep: fakeSleep(sleeps) },
      ),
    ).rejects.toThrow('EACCES');
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('throws the final error after exhausting all attempts on a retryable failure', async () => {
    const sleeps = [];
    let calls = 0;
    await expect(
      retryNpmInstall(
        async () => {
          calls += 1;
          throw new Error(`notarget attempt ${calls}`);
        },
        { attempts: 3, delayMs: 5, sleep: fakeSleep(sleeps) },
      ),
    ).rejects.toThrow('notarget attempt 3');
    expect(calls).toBe(3);
    expect(sleeps).toEqual([5, 5]);
  });

  it('reports retryable status and the error on each failed attempt via onAttemptResult', async () => {
    const results = [];
    await expect(
      retryNpmInstall(
        async () => {
          throw new Error('ETARGET boom');
        },
        {
          attempts: 2,
          delayMs: 0,
          sleep: vi.fn(async () => {}),
          onAttemptResult: (info) => results.push(info),
        },
      ),
    ).rejects.toThrow('ETARGET boom');
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ attempt: 1, attempts: 2, status: 'failed', retryable: true });
    expect(results[1]).toMatchObject({ attempt: 2, attempts: 2, status: 'failed', retryable: true });
  });

  it('rejects a non-positive-integer attempts option', async () => {
    await expect(retryNpmInstall(async () => 'unreachable', { attempts: 0 })).rejects.toThrow(
      'attempts must be a positive integer',
    );
  });
});
