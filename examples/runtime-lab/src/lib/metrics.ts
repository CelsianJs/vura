export interface TimingSample {
  route: string;
  observedRuntime: string;
  totalMs: number;
  ttfbMs: number;
  wakeMs: number | null;
  bootAgeMs: number;
  requestOrdinal: number;
  status: number;
  correlationId: string;
  requestId: string;
  timestamp: string;
}

export interface TimingSummary {
  count: number;
  p50: number | null;
  p95: number | null;
  latest: number | null;
}

export function percentile(values: number[], quantile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return sorted[index] ?? null;
}

export function summarize(samples: TimingSample[]): TimingSummary {
  const values = samples.map((sample) => sample.totalMs);
  return {
    count: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    latest: values.at(-1) ?? null,
  };
}

export function isColdFunction(sample: TimingSample): boolean {
  return sample.route === '/api/function'
    && ((sample.wakeMs ?? 0) > 0 || (sample.requestOrdinal === 1 && sample.bootAgeMs < 30_000));
}

export function normalizeRuntime(value: string | null | undefined): string {
  const normalized = (value || '').toLowerCase();
  if (normalized === 'serverless' || normalized === 'cold') return 'function';
  if (normalized === 'dedicated' || normalized === 'pool') return 'hot';
  return normalized || 'unknown';
}
