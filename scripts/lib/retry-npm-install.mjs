// Shared retry-with-backoff for `npm install` calls made immediately after a
// fresh `npm publish` in scripts/verify-registry-install.mjs.
//
// The npm registry/CDN can take minutes to fully propagate a brand-new
// version — `npm install pkg@<version>` reliably 404s/ETARGETs during that
// window even though the publish itself already succeeded. Observed on the
// v0.5.3 release (run 28714991521, 2026-07-04): @celsian/vura-adapter-lambda
// still 404'd 2m07s after a confirmed-successful publish. This is
// propagation lag, not a real failure — retry with backoff instead of
// failing the whole release.
//
// Only errors that look like registry-lookup/propagation failures are
// retried by default (see isRetryableRegistryInstallError) — a genuine bug
// (bad checksum, auth failure, disk full, etc.) still fails fast rather than
// burning the full retry budget.

export function isRetryableRegistryInstallError(err) {
  const message = err instanceof Error ? err.message : String(err);
  return /E404|ETARGET|No matching version found|notarget|not found|404 Not Found/i.test(message);
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {(attempt: number) => any | Promise<any>} task - 1-based attempt number in.
 *   Throw to signal failure.
 * @param {object} [options]
 * @param {number} [options.attempts=20] - total attempts (>= 1) before giving up.
 * @param {number} [options.delayMs=15000] - fixed delay between retries.
 * @param {(error: unknown) => boolean} [options.isRetryable] - defaults to
 *   isRetryableRegistryInstallError. Non-retryable errors are thrown
 *   immediately without consuming the remaining attempt budget.
 * @param {(info: { attempt: number, attempts: number, status: 'passed' | 'failed', retryable?: boolean, error?: unknown }) => void} [options.onAttemptResult]
 *   called after every attempt (success or failure) — use for logging.
 * @param {(ms: number) => Promise<void>} [options.sleep] - injectable for tests.
 */
export async function retryNpmInstall(task, options = {}) {
  const attempts = options.attempts ?? 20;
  const delayMs = options.delayMs ?? 15_000;
  const isRetryable = options.isRetryable ?? isRetryableRegistryInstallError;
  const onAttemptResult = options.onAttemptResult ?? (() => {});
  const sleep = options.sleep ?? defaultSleep;

  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error(`retryNpmInstall: attempts must be a positive integer, got ${attempts}`);
  }

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await task(attempt);
      onAttemptResult({ attempt, attempts, status: 'passed' });
      return result;
    } catch (error) {
      const retryable = isRetryable(error);
      onAttemptResult({ attempt, attempts, status: 'failed', retryable, error });
      if (!retryable || attempt === attempts) throw error;
      await sleep(delayMs);
    }
  }
  // Unreachable: the loop above always returns or throws.
  throw new Error('retryNpmInstall: exhausted attempts without a result');
}
