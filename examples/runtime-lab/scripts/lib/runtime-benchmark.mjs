import {
  classifySample,
  DEFAULT_COLD_BOOT_THRESHOLD_MS,
  normalizeRuntime,
  parsePositiveInteger,
  proveCold,
  proveDedicatedIdle,
  summarizeSamples,
} from './benchmark-metrics.mjs';

export {
  classifySample,
  DEFAULT_COLD_BOOT_THRESHOLD_MS,
  normalizeRuntime,
  parsePositiveInteger,
  proveCold,
  proveDedicatedIdle,
  summarizeSamples,
} from './benchmark-metrics.mjs';

const DEFAULT_ROUTES = Object.freeze({
  function: '/api/function',
  hot: '/api/hot',
  portable: '/api/portable',
});

const DEFAULT_EXPECTED_PLACEMENT = Object.freeze({
  function: 'function',
  hot: 'hot',
  portable: 'function',
});

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_COLD_CONTROL_TIMEOUT_MS = 30_000;
export const MAX_NETWORK_TIMEOUT_MS = 5 * 60 * 1000;
export const MAX_COLD_CONTROL_LEASE_MS = 15 * 60 * 1000;

export async function measureRoute({
  fetchImpl = fetch,
  baseUrl,
  routeName,
  routePath = DEFAULT_ROUTES[routeName],
  expectedPlacement = DEFAULT_EXPECTED_PLACEMENT[routeName],
  count,
  correlationFactory = () => crypto.randomUUID(),
  onProgress = () => {},
  coldBootThresholdMs = DEFAULT_COLD_BOOT_THRESHOLD_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
}) {
  const sampleCount = parsePositiveInteger(count, 'sample count');
  const samples = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const correlationId = `bench-${routeName}-${correlationFactory()}`;
    const sample = await requestSample({
      fetchImpl,
      url: `${baseUrl}${routePath}`,
      routeName,
      routePath,
      expectedPlacement,
      correlationId,
      timeoutMs: requestTimeoutMs,
    });
    sample.classification = classifySample(sample, { coldBootThresholdMs });
    samples.push(sample);
    onProgress({ routeName, completed: index + 1, total: sampleCount, valid: sample.valid });
  }
  return samples;
}

export async function requestSample({
  fetchImpl = fetch,
  url,
  routeName,
  routePath,
  expectedPlacement,
  correlationId,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
}) {
  const boundedTimeoutMs = parseNetworkTimeout(timeoutMs, 'request timeout');
  const signal = AbortSignal.timeout(boundedTimeoutMs);
  const startedAt = performance.now();
  try {
    const response = await awaitWithAbort(fetchImpl(url, {
      cache: 'no-store',
      headers: { 'x-lab-correlation-id': correlationId },
      signal,
    }), signal);
    const ttfbMs = performance.now() - startedAt;
    const contentType = response.headers.get('content-type') || '';
    let body = null;
    let bodyError = null;
    try {
      body = await awaitWithAbort(response.json(), signal);
    } catch (error) {
      if (signal.aborted) throw error;
      bodyError = error instanceof Error ? error.message : String(error);
    }
    const totalMs = performance.now() - startedAt;
    const observedRuntime = normalizeRuntime(
      response.headers.get('x-vura-route-kind')
      || response.headers.get('x-vura-runtime')
      || body?.runtimeIntent,
    );
    const correlationHeader = response.headers.get('x-lab-correlation-id');
    const correlationExact = correlationHeader === correlationId && body?.correlationId === correlationId;
    const wakeHeader = response.headers.get('x-vura-function-wake-ms');
    const wakeMs = wakeHeader == null ? null : Number(wakeHeader);
    const validationErrors = [];
    if (response.status !== 200) validationErrors.push(`unexpected_status:${response.status}`);
    if (!contentType.toLowerCase().includes('application/json')) validationErrors.push('content_type_not_json');
    if (bodyError || !body || typeof body !== 'object' || Array.isArray(body)) validationErrors.push('invalid_json_body');
    if (body?.ok !== true) validationErrors.push('body_not_ok');
    if (body?.handlerVersion !== 1) validationErrors.push('handler_version_mismatch');
    if (body?.route !== routePath) validationErrors.push('route_mismatch');
    if (normalizeRuntime(expectedPlacement) !== observedRuntime) validationErrors.push('runtime_placement_mismatch');
    if (!correlationExact) validationErrors.push('correlation_mismatch');
    if (typeof body?.bootId !== 'string' || body.bootId.length === 0) validationErrors.push('boot_id_missing');
    if (!isNonNegativeFinite(body?.bootAgeMs)) validationErrors.push('boot_age_invalid');
    if (!isPositiveFiniteInteger(body?.requestOrdinal)) validationErrors.push('request_ordinal_invalid');
    if (wakeHeader != null && !isNonNegativeFinite(wakeMs)) validationErrors.push('wake_ms_invalid');

    return {
      routeName,
      route: routePath,
      expectedPlacement: normalizeRuntime(expectedPlacement),
      observedRuntime,
      status: response.status,
      totalMs,
      ttfbMs,
      wakeMs,
      correlationId,
      correlationExact,
      requestId: response.headers.get('x-vura-request-id') || body?.requestId || null,
      bootId: typeof body?.bootId === 'string' ? body.bootId : null,
      bootAgeMs: isNonNegativeFinite(body?.bootAgeMs) ? body.bootAgeMs : null,
      requestOrdinal: isPositiveFiniteInteger(body?.requestOrdinal) ? body.requestOrdinal : null,
      handlerVersion: body?.handlerVersion ?? null,
      valid: validationErrors.length === 0,
      validationErrors,
      failure: bodyError,
      timedOut: false,
      timeoutMs: boundedTimeoutMs,
    };
  } catch (error) {
    const timedOut = signal.aborted;
    return failedSample({
      routeName,
      routePath,
      expectedPlacement,
      correlationId,
      totalMs: performance.now() - startedAt,
      failure: timedOut
        ? `request timed out after ${boundedTimeoutMs}ms`
        : error instanceof Error ? error.message : String(error),
      timedOut,
      timeoutMs: boundedTimeoutMs,
    });
  }
}

export async function runBenchmark(options) {
  const sampleCount = parsePositiveInteger(options.sampleCount, 'sample count');
  const baseUrl = String(options.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl) throw new Error('benchmark URL is required');
  const coldBootThresholdMs = parsePositiveInteger(
    options.coldBootThresholdMs ?? DEFAULT_COLD_BOOT_THRESHOLD_MS,
    'cold boot threshold',
  );
  const fetchImpl = options.fetchImpl ?? fetch;
  const requestTimeoutMs = parseNetworkTimeout(
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    'request timeout',
  );
  const coldControlTimeoutMs = parseNetworkTimeout(
    options.coldControl?.timeoutMs ?? DEFAULT_COLD_CONTROL_TIMEOUT_MS,
    'cold control timeout',
  );
  const onProgress = options.onProgress ?? (() => {});
  const correlationFactory = options.correlationFactory ?? (() => crypto.randomUUID());
  let sequence = 0;
  const nextCorrelation = (label) => `bench-${label}-${correlationFactory()}-${sequence += 1}`;

  const before = await requestSample({
    fetchImpl,
    url: `${baseUrl}${DEFAULT_ROUTES.function}`,
    routeName: 'function',
    routePath: DEFAULT_ROUTES.function,
    expectedPlacement: 'function',
    correlationId: nextCorrelation('cold-before'),
    timeoutMs: requestTimeoutMs,
  });
  const control = await invokeColdControl({
    fetchImpl,
    coldControl: options.coldControl,
    beforeBootId: before.bootId,
    route: DEFAULT_ROUTES.function,
    timeoutMs: coldControlTimeoutMs,
  });
  let after = null;
  let cleanup = notApplicableCleanup('cold_control_did_not_mutate_provider');
  let cleanupPromise = null;
  const ensureCleanup = () => {
    cleanupPromise ??= invokeColdCleanup({
      fetchImpl,
      coldControl: options.coldControl,
      control,
      beforeBootId: before.bootId,
      afterBootId: after?.bootId ?? null,
      route: DEFAULT_ROUTES.function,
      timeoutMs: coldControlTimeoutMs,
    });
    return cleanupPromise;
  };
  const removeSignalHandlers = control.mutated === true
    ? installBestEffortCleanupSignalHandlers(ensureCleanup, options.signalTarget)
    : () => {};
  try {
    if (control.mutated === true && control.success !== true) {
      after = failedSample({
        routeName: 'function',
        routePath: DEFAULT_ROUTES.function,
        expectedPlacement: 'function',
        correlationId: nextCorrelation('cold-after-skipped'),
        totalMs: 0,
        failure: 'post-mutation probe skipped because the server-side cleanup lease was invalid',
        timeoutMs: requestTimeoutMs,
      });
      after.validationErrors = [control.reason || 'cold_control_lease_invalid'];
    } else {
      after = await requestSample({
        fetchImpl,
        url: `${baseUrl}${DEFAULT_ROUTES.function}`,
        routeName: 'function',
        routePath: DEFAULT_ROUTES.function,
        expectedPlacement: 'function',
        correlationId: nextCorrelation('cold-after'),
        timeoutMs: requestTimeoutMs,
      });
    }
  } finally {
    cleanup = await ensureCleanup();
    removeSignalHandlers();
  }
  const coldProof = proveCold({ control, before, after, coldBootThresholdMs });
  after.classification = coldProof.classification;
  onProgress({ routeName: 'cold-proof', completed: 1, total: 1, valid: coldProof.proven });

  const measure = (routeName, expectedPlacement) => measureRoute({
    fetchImpl,
    baseUrl,
    routeName,
    expectedPlacement,
    count: sampleCount,
    correlationFactory,
    onProgress,
    coldBootThresholdMs,
    requestTimeoutMs,
  });
  const functionSamples = await measure('function', 'function');
  const hotSamples = await measure('hot', 'hot');
  const dedicatedIdleProof = options.dedicatedIdleMs == null
    ? { configured: false, classification: 'not_proven', proven: false, reason: 'dedicated_idle_not_configured' }
    : await measureDedicatedIdle({
        fetchImpl,
        baseUrl,
        idleMs: options.dedicatedIdleMs,
        correlationFactory,
        sleepImpl: options.sleepImpl,
        onProgress,
        requestTimeoutMs,
      });
  const portableSamples = await measure('portable', options.portablePlacement ?? 'function');

  const result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    target: { baseUrl, sampleCount, portablePlacement: normalizeRuntime(options.portablePlacement ?? 'function') },
    thresholds: { coldBootThresholdMs, requestTimeoutMs, coldControlTimeoutMs },
    coldProof,
    cleanup,
    dedicatedIdleProof,
    routes: {
      function: summarizeSamples(functionSamples),
      hot: summarizeSamples(hotSamples),
      portable: summarizeSamples(portableSamples),
    },
  };
  result.ok = Object.values(result.routes).every((summary) => summary.ok)
    && (coldProof.proven || options.requireCold !== true)
    && (options.dedicatedIdleMs == null || dedicatedIdleProof.proven)
    && cleanupPassed(control, cleanup);
  result.requireCold = options.requireCold === true;
  return result;
}

export async function invokeColdControl({
  fetchImpl = fetch,
  coldControl,
  beforeBootId,
  route,
  timeoutMs = DEFAULT_COLD_CONTROL_TIMEOUT_MS,
}) {
  if (!coldControl?.url) {
    return { configured: false, authenticated: false, success: false, reason: 'cold_control_not_configured' };
  }
  if (!coldControl.token) {
    return { configured: true, authenticated: false, success: false, reason: 'cold_control_token_missing' };
  }
  let controlUrl;
  try {
    controlUrl = new URL(coldControl.url);
  } catch {
    return { configured: true, authenticated: false, success: false, reason: 'cold_control_url_invalid' };
  }
  if (controlUrl.protocol !== 'https:') {
    return { configured: true, authenticated: false, success: false, reason: 'cold_control_https_required' };
  }
  const allowedHosts = new Set(
    (coldControl.allowedHosts ?? []).map((host) => String(host).trim().toLowerCase()).filter(Boolean),
  );
  if (!allowedHosts.has(controlUrl.host.toLowerCase())) {
    return { configured: true, authenticated: false, success: false, reason: 'cold_control_host_not_allowed' };
  }
  const boundedTimeoutMs = parseNetworkTimeout(timeoutMs, 'cold control timeout');
  const signal = AbortSignal.timeout(boundedTimeoutMs);
  try {
    const response = await awaitWithAbort(fetchImpl(controlUrl, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        authorization: `Bearer ${coldControl.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ schemaVersion: 1, action: 'replace_function_runtime', route, beforeBootId }),
    }), signal);
    let body = null;
    try {
      body = await awaitWithAbort(response.json(), signal);
    } catch (error) {
      if (signal.aborted) throw error;
      return { configured: true, authenticated: true, success: false, status: response.status, reason: 'control_response_not_json' };
    }
    const operationId = typeof body?.operationId === 'string' && body.operationId.length > 0
      ? body.operationId
      : null;
    const mutated = response.ok
      && body?.schemaVersion === 1
      && body?.ok === true
      && body?.action === 'replace_function_runtime'
      && operationId !== null;
    const leaseExpiresAt = validColdControlLease(body?.leaseExpiresAt, boundedTimeoutMs);
    const success = mutated && leaseExpiresAt !== null;
    return {
      configured: true,
      authenticated: true,
      mutated,
      success,
      status: response.status,
      reason: success ? null : mutated ? 'cold_control_lease_invalid' : 'control_contract_rejected',
      operationId,
      leaseExpiresAt,
      timedOut: false,
      timeoutMs: boundedTimeoutMs,
    };
  } catch (error) {
    return {
      configured: true,
      authenticated: true,
      success: false,
      reason: signal.aborted ? 'control_request_timeout' : 'control_request_failed',
      failure: signal.aborted
        ? `cold control timed out after ${boundedTimeoutMs}ms`
        : error instanceof Error ? error.message : String(error),
      timedOut: signal.aborted,
      timeoutMs: boundedTimeoutMs,
    };
  }
}

export async function invokeColdCleanup({
  fetchImpl = fetch,
  coldControl,
  control,
  beforeBootId,
  afterBootId,
  route,
  timeoutMs = DEFAULT_COLD_CONTROL_TIMEOUT_MS,
}) {
  if (control?.mutated !== true) return notApplicableCleanup('cold_control_did_not_mutate_provider');
  const base = {
    schemaVersion: 1,
    applicability: 'required',
    attempted: true,
    passed: false,
    remaining: ['provider_cleanup_not_proven'],
    operationId: control.operationId,
  };
  if (!coldControl?.url || !coldControl?.token) {
    return { ...base, reason: 'cleanup_control_configuration_missing' };
  }
  let controlUrl;
  try {
    controlUrl = new URL(coldControl.url);
  } catch {
    return { ...base, reason: 'cleanup_control_url_invalid' };
  }
  if (controlUrl.protocol !== 'https:') return { ...base, reason: 'cleanup_control_https_required' };
  const allowedHosts = new Set(
    (coldControl.allowedHosts ?? []).map((host) => String(host).trim().toLowerCase()).filter(Boolean),
  );
  if (!allowedHosts.has(controlUrl.host.toLowerCase())) {
    return { ...base, reason: 'cleanup_control_host_not_allowed' };
  }
  const boundedTimeoutMs = parseNetworkTimeout(timeoutMs, 'cold control timeout');
  const signal = AbortSignal.timeout(boundedTimeoutMs);
  try {
    const response = await awaitWithAbort(fetchImpl(controlUrl, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        authorization: `Bearer ${coldControl.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        schemaVersion: 1,
        action: 'restore_function_runtime',
        operationId: control.operationId,
        route,
        beforeBootId,
        afterBootId,
      }),
    }), signal);
    let body = null;
    try {
      body = await awaitWithAbort(response.json(), signal);
    } catch (error) {
      if (signal.aborted) throw error;
      return { ...base, status: response.status, reason: 'cleanup_response_not_json' };
    }
    const remaining = Array.isArray(body?.remaining) ? body.remaining : null;
    const passed = response.ok
      && body?.schemaVersion === 1
      && body?.ok === true
      && body?.action === 'restore_function_runtime'
      && body?.operationId === control.operationId
      && remaining !== null
      && remaining.length === 0;
    return {
      ...base,
      passed,
      remaining: passed ? [] : ['provider_cleanup_not_proven'],
      status: response.status,
      reason: passed ? null : 'cleanup_contract_rejected',
      timedOut: false,
      timeoutMs: boundedTimeoutMs,
    };
  } catch (error) {
    return {
      ...base,
      reason: signal.aborted ? 'cleanup_request_timeout' : 'cleanup_request_failed',
      failure: signal.aborted
        ? `cold cleanup timed out after ${boundedTimeoutMs}ms`
        : error instanceof Error ? error.message : String(error),
      timedOut: signal.aborted,
      timeoutMs: boundedTimeoutMs,
    };
  }
}

export async function measureDedicatedIdle({
  fetchImpl = fetch,
  baseUrl,
  idleMs,
  correlationFactory = () => crypto.randomUUID(),
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onProgress = () => {},
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
}) {
  const requestedIdleMs = parsePositiveInteger(idleMs, 'dedicated idle duration');
  const makeCorrelation = (stage) => `bench-hot-idle-${stage}-${correlationFactory()}`;
  const before = await requestSample({
    fetchImpl,
    url: `${baseUrl}${DEFAULT_ROUTES.hot}`,
    routeName: 'hot',
    routePath: DEFAULT_ROUTES.hot,
    expectedPlacement: 'hot',
    correlationId: makeCorrelation('before'),
    timeoutMs: requestTimeoutMs,
  });
  await sleepImpl(requestedIdleMs);
  const after = await requestSample({
    fetchImpl,
    url: `${baseUrl}${DEFAULT_ROUTES.hot}`,
    routeName: 'hot',
    routePath: DEFAULT_ROUTES.hot,
    expectedPlacement: 'hot',
    correlationId: makeCorrelation('after'),
    timeoutMs: requestTimeoutMs,
  });
  const proof = proveDedicatedIdle({ before, after, requestedIdleMs });
  after.classification = proof.classification;
  onProgress({ routeName: 'dedicated-idle-proof', completed: 1, total: 1, valid: proof.proven });
  return proof;
}

function failedSample({
  routeName,
  routePath,
  expectedPlacement,
  correlationId,
  totalMs,
  failure,
  timedOut = false,
  timeoutMs = null,
}) {
  return {
    routeName,
    route: routePath,
    expectedPlacement: normalizeRuntime(expectedPlacement),
    observedRuntime: 'unknown',
    status: null,
    totalMs,
    ttfbMs: null,
    wakeMs: null,
    correlationId,
    correlationExact: false,
    requestId: null,
    bootId: null,
    bootAgeMs: null,
    requestOrdinal: null,
    handlerVersion: null,
    valid: false,
    validationErrors: [timedOut ? 'request_timeout' : 'request_failed'],
    failure,
    timedOut,
    timeoutMs,
    classification: 'not_proven',
  };
}

function cleanupPassed(control, cleanup) {
  if (control?.mutated !== true) return true;
  return cleanup?.schemaVersion === 1
    && cleanup?.applicability === 'required'
    && cleanup?.attempted === true
    && cleanup?.passed === true
    && cleanup?.operationId === control.operationId
    && Array.isArray(cleanup?.remaining)
    && cleanup.remaining.length === 0;
}

export function installBestEffortCleanupSignalHandlers(cleanup, signalTarget = process) {
  let handling = false;
  const handlers = new Map();
  const remove = () => {
    for (const [signal, handler] of handlers) signalTarget.removeListener(signal, handler);
    handlers.clear();
  };
  for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    const handler = () => {
      if (handling) return;
      handling = true;
      Promise.resolve()
        .then(cleanup)
        .catch((error) => {
          if (signalTarget === process) {
            process.stderr.write(`[runtime-benchmark] signal cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
          }
        })
        .finally(() => {
          remove();
          signalTarget.exitCode = exitCode;
        });
    };
    handlers.set(signal, handler);
    signalTarget.once(signal, handler);
  }
  return remove;
}

function validColdControlLease(value, controlTimeoutMs, nowMs = Date.now()) {
  if (typeof value !== 'string' || !value) return null;
  const expiresAtMs = Date.parse(value);
  const minimumExpiryMs = nowMs + (controlTimeoutMs * 2);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs < minimumExpiryMs) return null;
  if (expiresAtMs > nowMs + MAX_COLD_CONTROL_LEASE_MS) return null;
  return new Date(expiresAtMs).toISOString();
}

function notApplicableCleanup(reason) {
  return {
    schemaVersion: 1,
    applicability: 'not_applicable',
    attempted: false,
    passed: true,
    remaining: [],
    operationId: null,
    reason,
  };
}

function awaitWithAbort(value, signal) {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('request aborted'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('request aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(value).then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

function parseNetworkTimeout(value, label) {
  const parsed = parsePositiveInteger(value, label);
  if (parsed > MAX_NETWORK_TIMEOUT_MS) {
    throw new Error(`${label} must be at most ${MAX_NETWORK_TIMEOUT_MS}ms`);
  }
  return parsed;
}

function isNonNegativeFinite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isPositiveFiniteInteger(value) {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value > 0;
}
