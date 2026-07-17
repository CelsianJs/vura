export const DEFAULT_COLD_BOOT_THRESHOLD_MS = 30_000;

export function parsePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive finite integer`);
  }
  return parsed;
}

export function normalizeRuntime(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'serverless' || normalized === 'cold') return 'function';
  if (normalized === 'dedicated' || normalized === 'pool') return 'hot';
  return normalized || 'unknown';
}

export function percentile(values, quantile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return sorted[index] ?? null;
}

export function medianAbsoluteDeviation(values) {
  const median = percentile(values, 0.5);
  if (median == null) return null;
  return percentile(values.map((value) => Math.abs(value - median)), 0.5);
}

export function coefficientOfVariation(values) {
  if (values.length === 0) return null;
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  if (mean === 0) return 0;
  const variance = values.reduce((total, value) => total + ((value - mean) ** 2), 0) / values.length;
  return Math.sqrt(variance) / mean;
}

export function classifySample(sample, options = {}) {
  if (!sample?.valid) return 'not_proven';
  if (options.coldProven === true) return 'cold';

  const coldThresholdMs = options.coldBootThresholdMs ?? DEFAULT_COLD_BOOT_THRESHOLD_MS;
  if (sample.observedRuntime === 'function'
    && ((sample.wakeMs ?? 0) > 0 || (sample.requestOrdinal === 1 && sample.bootAgeMs <= coldThresholdMs))) {
    return 'not_proven';
  }
  return 'warm';
}

export function proveDedicatedIdle({ before, after, requestedIdleMs }) {
  const reasons = [];
  if (!before?.valid) reasons.push('pre_idle_sample_invalid');
  if (!after?.valid) reasons.push('post_idle_sample_invalid');
  if (before?.observedRuntime !== 'hot' || after?.observedRuntime !== 'hot') {
    reasons.push('runtime_not_dedicated');
  }
  if (!before?.bootId || !after?.bootId || before.bootId !== after.bootId) {
    reasons.push('boot_id_changed');
  }
  if (!Number.isFinite(before?.bootAgeMs) || !Number.isFinite(after?.bootAgeMs)
    || after.bootAgeMs - before.bootAgeMs < requestedIdleMs) {
    reasons.push('boot_age_did_not_cover_idle_window');
  }
  if (!Number.isInteger(before?.requestOrdinal) || !Number.isInteger(after?.requestOrdinal)
    || after.requestOrdinal <= before.requestOrdinal) {
    reasons.push('request_ordinal_did_not_advance');
  }
  if (!after?.correlationExact) reasons.push('correlation_not_exact');

  return {
    configured: true,
    classification: reasons.length === 0 ? 'idle' : 'not_proven',
    proven: reasons.length === 0,
    requestedIdleMs,
    reasons,
    beforeBootId: before?.bootId ?? null,
    afterBootId: after?.bootId ?? null,
    beforeRequestOrdinal: before?.requestOrdinal ?? null,
    afterRequestOrdinal: after?.requestOrdinal ?? null,
    sample: after ?? null,
  };
}

export function proveCold({ control, before, after, coldBootThresholdMs = DEFAULT_COLD_BOOT_THRESHOLD_MS }) {
  const reasons = [];
  if (control?.configured !== true) reasons.push('cold_control_not_configured');
  if (control?.authenticated !== true) reasons.push('cold_control_not_authenticated');
  if (control?.success !== true) reasons.push('cold_control_not_successful');
  if (!before?.valid) reasons.push('pre_control_sample_invalid');
  if (!after?.valid) reasons.push('post_control_sample_invalid');
  if (after?.status !== 200) reasons.push('post_control_status_not_200');
  if (after?.observedRuntime !== 'function') reasons.push('post_control_runtime_not_function');
  if (!before?.bootId || !after?.bootId || before.bootId === after.bootId) reasons.push('boot_id_did_not_change');
  if (after?.requestOrdinal !== 1) reasons.push('request_ordinal_not_one');
  if (!Number.isFinite(after?.bootAgeMs) || after.bootAgeMs < 0 || after.bootAgeMs > coldBootThresholdMs) {
    reasons.push('boot_age_outside_threshold');
  }
  if (!Number.isFinite(after?.wakeMs) || after.wakeMs <= 0) reasons.push('positive_wake_work_not_observed');
  if (!after?.correlationExact) reasons.push('correlation_not_exact');

  return {
    classification: reasons.length === 0 ? 'cold' : 'not_proven',
    proven: reasons.length === 0,
    reasons,
    control: sanitizeControl(control),
    beforeBootId: before?.bootId ?? null,
    afterBootId: after?.bootId ?? null,
    sample: after ?? null,
  };
}

export function summarizeSamples(samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error('cannot summarize an empty sample set');
  }
  const validSamples = samples.filter((sample) => sample.valid);
  const values = validSamples.map((sample) => sample.totalMs);
  const classifications = { cold: 0, idle: 0, warm: 0, not_proven: 0 };
  for (const sample of samples) classifications[sample.classification || 'not_proven'] += 1;
  return {
    count: samples.length,
    validCount: validSamples.length,
    failureCount: samples.length - validSamples.length,
    ok: validSamples.length === samples.length,
    p50Ms: percentile(values, 0.5),
    p90Ms: percentile(values, 0.9),
    p95Ms: percentile(values, 0.95),
    medianAbsoluteDeviationMs: medianAbsoluteDeviation(values),
    coefficientOfVariation: coefficientOfVariation(values),
    minMs: values.length === 0 ? null : Math.min(...values),
    maxMs: values.length === 0 ? null : Math.max(...values),
    bootIds: [...new Set(validSamples.map((sample) => sample.bootId).filter(Boolean))],
    placements: [...new Set(samples.map((sample) => sample.observedRuntime))],
    classifications,
    failures: samples.filter((sample) => !sample.valid).map((sample) => ({
      correlationId: sample.correlationId,
      status: sample.status,
      errors: sample.validationErrors,
      failure: sample.failure,
    })),
    samples,
  };
}

function sanitizeControl(control) {
  if (!control) return null;
  return {
    configured: control.configured === true,
    authenticated: control.authenticated === true,
    mutated: control.mutated === true,
    success: control.success === true,
    status: control.status ?? null,
    reason: control.reason ?? null,
    operationId: control.operationId ?? null,
    leaseExpiresAt: control.leaseExpiresAt ?? null,
    failure: control.failure ?? null,
    timedOut: control.timedOut === true,
    timeoutMs: Number.isFinite(control.timeoutMs) ? control.timeoutMs : null,
  };
}
