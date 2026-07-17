import { describe, expect, it } from 'vitest';
import { isColdFunction, normalizeRuntime, percentile, summarize, type TimingSample } from './metrics.js';

const sample = (totalMs: number, overrides: Partial<TimingSample> = {}): TimingSample => ({
  route: '/api/function',
  observedRuntime: 'function',
  totalMs,
  ttfbMs: totalMs - 1,
  wakeMs: null,
  bootAgeMs: 60_000,
  requestOrdinal: 2,
  status: 200,
  correlationId: `sample-${totalMs}`,
  timestamp: '2026-07-16T00:00:00.000Z',
  ...overrides,
});

describe('runtime lab metrics', () => {
  it('calculates nearest-rank percentiles without mutating samples', () => {
    const values = [80, 10, 40, 20];
    expect(percentile(values, 0.5)).toBe(20);
    expect(percentile(values, 0.95)).toBe(80);
    expect(values).toEqual([80, 10, 40, 20]);
  });

  it('summarizes latest, p50, p95, and count', () => {
    expect(summarize([sample(10), sample(20), sample(90)])).toEqual({
      count: 3,
      p50: 20,
      p95: 90,
      latest: 90,
    });
  });

  it('classifies cold function evidence from wake telemetry or a fresh boot', () => {
    expect(isColdFunction(sample(500, { wakeMs: 420 }))).toBe(true);
    expect(isColdFunction(sample(500, { requestOrdinal: 1, bootAgeMs: 4_000 }))).toBe(true);
    expect(isColdFunction(sample(20))).toBe(false);
    expect(isColdFunction(sample(20, { route: '/api/hot', wakeMs: 1 }))).toBe(false);
  });

  it('normalizes public runtime vocabulary', () => {
    expect(normalizeRuntime('serverless')).toBe('function');
    expect(normalizeRuntime('dedicated')).toBe('hot');
    expect(normalizeRuntime('HOT')).toBe('hot');
    expect(normalizeRuntime(null)).toBe('unknown');
  });
});
