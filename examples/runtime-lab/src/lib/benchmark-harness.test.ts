import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import {
  classifySample,
  invokeColdCleanup,
  invokeColdControl,
  installBestEffortCleanupSignalHandlers,
  measureDedicatedIdle,
  measureRoute,
  parsePositiveInteger,
  proveCold,
  proveDedicatedIdle,
  requestSample,
  runBenchmark,
  summarizeSamples,
} from '../../scripts/lib/runtime-benchmark.mjs';

const execFileAsync = promisify(execFile);
const runtimeLabRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function validSample(overrides: Record<string, unknown> = {}) {
  return {
    valid: true,
    status: 200,
    observedRuntime: 'function',
    correlationExact: true,
    bootId: 'boot-after',
    bootAgeMs: 100,
    requestOrdinal: 1,
    wakeMs: 25,
    totalMs: 40,
    classification: 'warm',
    ...overrides,
  };
}

function probeResponse(overrides: Record<string, unknown> = {}, responseOverrides: ResponseInit = {}) {
  const correlationId = String(overrides.correlationId ?? 'corr-1');
  const body = {
    ok: true,
    handlerVersion: 1,
    runtimeIntent: 'function',
    route: '/api/function',
    correlationId,
    requestId: 'request-1',
    bootId: 'boot-1',
    bootAgeMs: 50_000,
    requestOrdinal: 2,
    ...overrides,
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    ...responseOverrides,
    headers: {
      'content-type': 'application/json',
      'x-lab-correlation-id': correlationId,
      'x-vura-route-kind': String(body.runtimeIntent),
      ...responseOverrides.headers,
    },
  });
}

describe('runtime benchmark validation', () => {
  it('rejects zero, fractional, infinite, and non-numeric sample counts', () => {
    for (const value of [0, -1, 1.5, Number.POSITIVE_INFINITY, 'nope']) {
      expect(() => parsePositiveInteger(value, 'samples')).toThrow('positive finite integer');
    }
    expect(parsePositiveInteger('2', 'samples')).toBe(2);
  });

  it('classifies a normal first measured request as warm rather than cold by position', () => {
    expect(classifySample(validSample({ requestOrdinal: 8, bootAgeMs: 45_000, wakeMs: null }))).toBe('warm');
    expect(classifySample(validSample({ observedRuntime: 'hot', requestOrdinal: 8, bootAgeMs: 900_000, wakeMs: null })))
      .toBe('warm');
    expect(classifySample(validSample({ observedRuntime: 'hot', requestOrdinal: 1, bootAgeMs: 100, wakeMs: 25 })))
      .toBe('warm');
  });

  it('proves a configured Dedicated idle window only on the same boot', () => {
    const before = validSample({ observedRuntime: 'hot', bootId: 'hot-boot', bootAgeMs: 1_000, requestOrdinal: 4 });
    const after = validSample({ observedRuntime: 'hot', bootId: 'hot-boot', bootAgeMs: 11_000, requestOrdinal: 5 });
    expect(proveDedicatedIdle({ before, after, requestedIdleMs: 10_000 })).toMatchObject({
      proven: true,
      classification: 'idle',
      requestedIdleMs: 10_000,
    });
    expect(proveDedicatedIdle({
      before,
      after: { ...after, bootId: 'replacement' },
      requestedIdleMs: 10_000,
    }).reasons).toContain('boot_id_changed');
    expect(proveDedicatedIdle({
      before,
      after: { ...after, bootAgeMs: 10_999 },
      requestedIdleMs: 10_000,
    }).reasons).toContain('boot_age_did_not_cover_idle_window');
  });

  it('supports an explicit CLI idle-proof wait without classifying ordinary hot samples as idle', async () => {
    let call = 0;
    const sleepImpl = vi.fn(async () => undefined);
    const proof = await measureDedicatedIdle({
      baseUrl: 'https://lab.invalid',
      idleMs: 10_000,
      sleepImpl,
      correlationFactory: () => `corr-${call + 1}`,
      fetchImpl: async (_url: string, init: RequestInit) => {
        call += 1;
        const correlationId = new Headers(init.headers).get('x-lab-correlation-id') || '';
        return probeResponse({
          correlationId,
          runtimeIntent: 'hot',
          route: '/api/hot',
          bootId: 'hot-boot',
          bootAgeMs: call === 1 ? 1_000 : 11_000,
          requestOrdinal: call === 1 ? 7 : 8,
        });
      },
    });
    expect(sleepImpl).toHaveBeenCalledWith(10_000);
    expect(proof).toMatchObject({ proven: true, classification: 'idle' });
  });

  it('requires every authenticated cold-proof signal', () => {
    const before = validSample({ bootId: 'boot-before', requestOrdinal: 10 });
    const control = { configured: true, authenticated: true, success: true, status: 200 };
    expect(proveCold({ control, before, after: validSample() })).toMatchObject({ proven: true, classification: 'cold' });
    expect(proveCold({ control: { ...control, configured: false }, before, after: validSample() }).reasons)
      .toContain('cold_control_not_configured');
    expect(proveCold({ control: { ...control, authenticated: false }, before, after: validSample() }).reasons)
      .toContain('cold_control_not_authenticated');
    expect(proveCold({ control: { ...control, success: false }, before, after: validSample() }).reasons)
      .toContain('cold_control_not_successful');
    expect(proveCold({ control, before, after: validSample({ bootId: 'boot-before' }) }).reasons)
      .toContain('boot_id_did_not_change');
    expect(proveCold({ control, before, after: validSample({ requestOrdinal: 2 }) }).reasons)
      .toContain('request_ordinal_not_one');
    expect(proveCold({ control, before, after: validSample({ bootAgeMs: 29_999 }) })).toMatchObject({ proven: true });
    expect(proveCold({ control, before, after: validSample({ bootAgeMs: 30_001 }) }).reasons)
      .toContain('boot_age_outside_threshold');
  });

  it('does not leak the cold-control token and fails closed on rejected control', async () => {
    let authorization = '';
    const control = await invokeColdControl({
      fetchImpl: async (_url: string, init: RequestInit) => {
        authorization = new Headers(init.headers).get('authorization') || '';
        return new Response(JSON.stringify({ ok: false }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        });
      },
      coldControl: {
        url: 'https://lab.invalid/replace',
        token: 'super-secret',
        allowedHosts: ['lab.invalid'],
      },
      beforeBootId: 'boot-1',
      route: '/api/function',
    });
    expect(authorization).toBe('Bearer super-secret');
    expect(JSON.stringify(control)).not.toContain('super-secret');
    expect(control).toMatchObject({ authenticated: true, success: false, status: 403 });
  });

  it('requires HTTPS and an explicitly allowlisted control host before sending credentials', async () => {
    const fetchImpl = vi.fn();
    await expect(invokeColdControl({
      fetchImpl,
      coldControl: { url: 'http://lab.invalid/control', token: 'secret' },
      beforeBootId: 'boot-1',
      route: '/api/function',
    })).resolves.toMatchObject({ success: false, reason: 'cold_control_https_required' });
    await expect(invokeColdControl({
      fetchImpl,
      coldControl: { url: 'https://lab.invalid/control', token: 'secret' },
      beforeBootId: 'boot-1',
      route: '/api/function',
    })).resolves.toMatchObject({ success: false, reason: 'cold_control_host_not_allowed' });
    expect(fetchImpl).not.toHaveBeenCalled();

    fetchImpl.mockResolvedValue(new Response(JSON.stringify({
      schemaVersion: 1,
      ok: true,
      action: 'replace_function_runtime',
      operationId: 'op-1',
      leaseExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    await expect(invokeColdControl({
      fetchImpl,
      coldControl: {
        url: 'https://control.invalid/control',
        token: 'secret',
        allowedHosts: ['control.invalid'],
      },
      beforeBootId: 'boot-1',
      route: '/api/function',
    })).resolves.toMatchObject({ success: true, operationId: 'op-1' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL('https://control.invalid/control'),
      expect.objectContaining({ method: 'POST', redirect: 'error' }),
    );
  });

  it('blocks cold-control redirects at the fetch boundary', async () => {
    const fetchImpl = vi.fn(async (_url: URL, init: RequestInit) => {
      if (init.redirect !== 'error') throw new Error('redirects were not blocked');
      return new Response(JSON.stringify({
        schemaVersion: 1,
        ok: true,
        action: 'replace_function_runtime',
        operationId: 'op-redirect-safe',
        leaseExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    await expect(invokeColdControl({
      fetchImpl,
      coldControl: {
        url: 'https://control.invalid/control',
        token: 'secret',
        allowedHosts: ['control.invalid'],
      },
      beforeBootId: 'boot-1',
      route: '/api/function',
    })).resolves.toMatchObject({ success: true, operationId: 'op-redirect-safe' });
  });

  it('records a bounded request timeout as strict failed-sample evidence', async () => {
    const sample = await requestSample({
      fetchImpl: async (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
        const signal = init.signal as AbortSignal;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
      url: 'https://lab.invalid/api/function',
      routeName: 'function',
      routePath: '/api/function',
      expectedPlacement: 'function',
      correlationId: 'timeout-correlation',
      timeoutMs: 5,
    });
    expect(sample).toMatchObject({
      valid: false,
      timedOut: true,
      timeoutMs: 5,
      validationErrors: ['request_timeout'],
      failure: 'request timed out after 5ms',
    });
    await expect(requestSample({
      url: 'https://lab.invalid/api/function',
      routeName: 'function',
      routePath: '/api/function',
      expectedPlacement: 'function',
      correlationId: 'unbounded-timeout',
      timeoutMs: 300_001,
    })).rejects.toThrow('request timeout must be at most 300000ms');
  });

  it('aborts a timed-out cold-control request and emits a fail-closed reason', async () => {
    const control = await invokeColdControl({
      fetchImpl: async (_url: URL, init: RequestInit) => new Promise((_resolve, reject) => {
        const signal = init.signal as AbortSignal;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
      coldControl: {
        url: 'https://control.invalid/control',
        token: 'secret',
        allowedHosts: ['control.invalid'],
      },
      beforeBootId: 'boot-before',
      route: '/api/function',
      timeoutMs: 5,
    });
    expect(control).toMatchObject({
      success: false,
      timedOut: true,
      timeoutMs: 5,
      reason: 'control_request_timeout',
    });
  });

  it('emits cleanup proof only after the authenticated restore contract succeeds', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_url: URL, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as Record<string, unknown>;
      requests.push(request);
      return new Response(JSON.stringify(request.action === 'replace_function_runtime'
        ? {
            schemaVersion: 1,
            ok: true,
            action: 'replace_function_runtime',
            operationId: 'operation-1',
            leaseExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
          }
        : {
            schemaVersion: 1,
            ok: true,
            action: 'restore_function_runtime',
            operationId: 'operation-1',
            remaining: [],
          }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const coldControl = {
      url: 'https://control.invalid/control',
      token: 'secret',
      allowedHosts: ['control.invalid'],
    };
    const control = await invokeColdControl({
      fetchImpl,
      coldControl,
      beforeBootId: 'boot-before',
      route: '/api/function',
    });
    const cleanup = await invokeColdCleanup({
      fetchImpl,
      coldControl,
      control,
      beforeBootId: 'boot-before',
      afterBootId: 'boot-after',
      route: '/api/function',
    });
    expect(requests.map((request) => request.action)).toEqual([
      'replace_function_runtime',
      'restore_function_runtime',
    ]);
    expect(cleanup).toMatchObject({
      schemaVersion: 1,
      applicability: 'required',
      attempted: true,
      passed: true,
      remaining: [],
      operationId: 'operation-1',
    });

    const rejected = await invokeColdCleanup({
      fetchImpl: async () => new Response(JSON.stringify({
        schemaVersion: 1,
        ok: true,
        action: 'restore_function_runtime',
        operationId: 'operation-1',
        remaining: ['machine-1'],
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
      coldControl,
      control,
      beforeBootId: 'boot-before',
      afterBootId: 'boot-after',
      route: '/api/function',
    });
    expect(rejected).toMatchObject({
      applicability: 'required',
      attempted: true,
      passed: false,
      remaining: ['provider_cleanup_not_proven'],
      operationId: 'operation-1',
    });
    expect(JSON.stringify(rejected)).not.toContain('machine-1');

    const timedOut = await invokeColdCleanup({
      fetchImpl: async (_url: URL, init: RequestInit) => new Promise((_resolve, reject) => {
        const signal = init.signal as AbortSignal;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
      coldControl,
      control,
      beforeBootId: 'boot-before',
      afterBootId: 'boot-after',
      route: '/api/function',
      timeoutMs: 5,
    });
    expect(timedOut).toMatchObject({
      applicability: 'required',
      attempted: true,
      passed: false,
      remaining: ['provider_cleanup_not_proven'],
      reason: 'cleanup_request_timeout',
      timedOut: true,
      timeoutMs: 5,
    });
  });

  it('rejects a mutation lease that cannot guarantee automatic server-side expiry', async () => {
    const control = await invokeColdControl({
      fetchImpl: async () => new Response(JSON.stringify({
        schemaVersion: 1,
        ok: true,
        action: 'replace_function_runtime',
        operationId: 'operation-without-lease',
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
      coldControl: {
        url: 'https://control.invalid/control',
        token: 'secret',
        allowedHosts: ['control.invalid'],
      },
      beforeBootId: 'boot-before',
      route: '/api/function',
    });

    expect(control).toMatchObject({
      mutated: true,
      success: false,
      reason: 'cold_control_lease_invalid',
      leaseExpiresAt: null,
    });
  });

  it('runs best-effort cleanup once when termination arrives', async () => {
    const signalTarget = new EventEmitter() as EventEmitter & { exitCode?: number };
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const remove = installBestEffortCleanupSignalHandlers(cleanup, signalTarget);

    signalTarget.emit('SIGTERM');
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1));
    expect(signalTarget.exitCode).toBe(143);
    signalTarget.emit('SIGTERM');
    expect(cleanup).toHaveBeenCalledTimes(1);
    remove();
  });

  it('rejects a route placement mismatch and correlation mismatch', async () => {
    const sample = await requestSample({
      fetchImpl: async () => probeResponse({
        correlationId: 'wrong',
        route: '/api/other',
        runtimeIntent: 'hot',
      }),
      url: 'https://lab.invalid/api/function',
      routeName: 'function',
      routePath: '/api/function',
      expectedPlacement: 'function',
      correlationId: 'expected',
    });
    expect(sample.valid).toBe(false);
    expect(sample.validationErrors).toEqual(expect.arrayContaining([
      'route_mismatch',
      'runtime_placement_mismatch',
      'correlation_mismatch',
    ]));
  });

  it('records non-JSON and 5xx responses as failures instead of throwing', async () => {
    const nonJson = await requestSample({
      fetchImpl: async () => new Response('not json', { status: 200, headers: { 'content-type': 'text/plain' } }),
      url: 'https://lab.invalid/api/function',
      routeName: 'function',
      routePath: '/api/function',
      expectedPlacement: 'function',
      correlationId: 'corr-1',
    });
    expect(nonJson.validationErrors).toEqual(expect.arrayContaining(['content_type_not_json', 'invalid_json_body']));

    const failure = await requestSample({
      fetchImpl: async () => probeResponse({ correlationId: 'corr-1', ok: false }, { status: 503 }),
      url: 'https://lab.invalid/api/function',
      routeName: 'function',
      routePath: '/api/function',
      expectedPlacement: 'function',
      correlationId: 'corr-1',
    });
    expect(failure.validationErrors).toEqual(expect.arrayContaining(['unexpected_status:503', 'body_not_ok']));
  });

  it('reports distribution, variability, failures, boots, placements, and classifications', () => {
    const summary = summarizeSamples([
      validSample({ totalMs: 10, bootId: 'a', classification: 'warm' }),
      validSample({ totalMs: 20, bootId: 'a', classification: 'warm' }),
      validSample({ totalMs: 100, bootId: 'b', observedRuntime: 'hot', classification: 'idle' }),
      validSample({ valid: false, totalMs: 0, classification: 'not_proven', validationErrors: ['bad'] }),
    ]);
    expect(summary).toMatchObject({
      count: 4,
      validCount: 3,
      failureCount: 1,
      p50Ms: 20,
      p90Ms: 100,
      p95Ms: 100,
      medianAbsoluteDeviationMs: 10,
      bootIds: ['a', 'b'],
      classifications: { cold: 0, idle: 1, warm: 2, not_proven: 1 },
    });
    expect(summary.coefficientOfVariation).toBeGreaterThan(0);
    expect(() => summarizeSamples([])).toThrow('empty sample set');
  });

  it('prevents an empty measurement from passing', async () => {
    await expect(measureRoute({
      baseUrl: 'https://lab.invalid',
      routeName: 'function',
      expectedPlacement: 'function',
      count: 0,
    })).rejects.toThrow('positive finite integer');
  });

  it('keeps stdout empty when strict JSON output cannot be produced', async () => {
    const script = resolve(runtimeLabRoot, 'scripts/benchmark.mjs');
    await expect(execFileAsync(process.execPath, [script, '--url', 'https://lab.invalid', '--samples', '0', '--json'], {
      cwd: runtimeLabRoot,
    })).rejects.toMatchObject({ stdout: '' });
  });

  it('rejects removed cold-control URL and token flags so control configuration stays out of process arguments', async () => {
    const script = resolve(runtimeLabRoot, 'scripts/benchmark.mjs');
    for (const flag of ['--cold-control-token', '--cold-control-url']) {
      await expect(execFileAsync(process.execPath, [
        script,
        '--url', 'https://lab.invalid',
        flag, 'must-not-be-accepted',
        '--json',
      ], { cwd: runtimeLabRoot })).rejects.toMatchObject({
        stdout: '',
        stderr: expect.stringContaining(`unknown argument: ${flag}`),
      });
    }
  });

  it('fails the benchmark verdict when a configured Dedicated idle proof is not proven', async () => {
    let hotRequest = 0;
    const result = await runBenchmark({
      baseUrl: 'https://lab.invalid',
      sampleCount: 1,
      dedicatedIdleMs: 10_000,
      sleepImpl: vi.fn(async () => undefined),
      correlationFactory: () => crypto.randomUUID(),
      fetchImpl: async (input: string | URL | Request, init: RequestInit) => {
        const route = new URL(String(input)).pathname;
        const correlationId = new Headers(init.headers).get('x-lab-correlation-id') || '';
        const isHot = route === '/api/hot';
        if (isHot) hotRequest += 1;
        return probeResponse({
          correlationId,
          runtimeIntent: isHot ? 'hot' : 'function',
          route,
          bootId: isHot && hotRequest === 3 ? 'hot-replaced' : isHot ? 'hot-original' : 'function-boot',
          bootAgeMs: isHot ? hotRequest * 10_000 : 60_000,
          requestOrdinal: isHot ? hotRequest : 10,
        });
      },
    });
    expect(result.routes.function.ok).toBe(true);
    expect(result.routes.hot.ok).toBe(true);
    expect(result.routes.portable.ok).toBe(true);
    expect(result.dedicatedIdleProof).toMatchObject({ proven: false, classification: 'not_proven' });
    expect(result.dedicatedIdleProof.reasons).toContain('boot_id_changed');
    expect(result.ok).toBe(false);
  });

  it('fails the benchmark verdict unless a provider mutation has real empty cleanup proof', async () => {
    async function benchmarkWithCleanup(cleanupRemaining: string[]) {
      let functionProbe = 0;
      return runBenchmark({
        baseUrl: 'https://lab.invalid',
        sampleCount: 1,
        requireCold: true,
        coldControl: {
          url: 'https://control.invalid/control',
          token: 'secret',
          allowedHosts: ['control.invalid'],
        },
        fetchImpl: async (input: string | URL | Request, init: RequestInit) => {
          if (input instanceof URL) {
            const request = JSON.parse(String(init.body)) as Record<string, unknown>;
            const action = String(request.action);
            return new Response(JSON.stringify(action === 'replace_function_runtime'
              ? {
                  schemaVersion: 1,
                  ok: true,
                  action,
                  operationId: 'operation-1',
                  leaseExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
                }
              : {
                  schemaVersion: 1,
                  ok: true,
                  action,
                  operationId: 'operation-1',
                  remaining: cleanupRemaining,
                }), { status: 200, headers: { 'content-type': 'application/json' } });
          }
          const route = new URL(String(input)).pathname;
          const correlationId = new Headers(init.headers).get('x-lab-correlation-id') || '';
          const isHot = route === '/api/hot';
          if (route === '/api/function') functionProbe += 1;
          const isColdProbe = route === '/api/function' && functionProbe === 2;
          return probeResponse({
            correlationId,
            runtimeIntent: isHot ? 'hot' : 'function',
            route,
            bootId: isColdProbe
              ? 'boot-after'
              : route === '/api/function' && functionProbe === 1 ? 'boot-before' : 'steady-boot',
            bootAgeMs: isColdProbe ? 100 : 60_000,
            requestOrdinal: isColdProbe ? 1 : 10,
          }, {
            headers: isColdProbe ? { 'x-vura-function-wake-ms': '25' } : {},
          });
        },
      });
    }

    const cleaned = await benchmarkWithCleanup([]);
    expect(cleaned).toMatchObject({
      ok: true,
      cleanup: {
        applicability: 'required', attempted: true, passed: true, remaining: [], operationId: 'operation-1',
      },
    });
    const remaining = await benchmarkWithCleanup(['provider-machine']);
    expect(remaining).toMatchObject({
      ok: false,
      cleanup: {
        applicability: 'required',
        attempted: true,
        passed: false,
        remaining: ['provider_cleanup_not_proven'],
        operationId: 'operation-1',
      },
    });
  });

  it('uses a null cleanup operation ID when no provider mutation occurred', async () => {
    const result = await runBenchmark({
      baseUrl: 'https://lab.invalid',
      sampleCount: 1,
      fetchImpl: async (input: string | URL | Request, init: RequestInit) => {
        const route = new URL(String(input)).pathname;
        const correlationId = new Headers(init.headers).get('x-lab-correlation-id') || '';
        return probeResponse({
          correlationId,
          runtimeIntent: route === '/api/hot' ? 'hot' : 'function',
          route,
        });
      },
    });

    expect(result.cleanup).toMatchObject({ applicability: 'not_applicable', operationId: null });
  });

  it('cleans up an acknowledged mutation before refusing an invalid server lease', async () => {
    const controlActions: string[] = [];
    let functionProbes = 0;
    const result = await runBenchmark({
      baseUrl: 'https://lab.invalid',
      sampleCount: 1,
      requireCold: true,
      coldControl: {
        url: 'https://control.invalid/control',
        token: 'secret',
        allowedHosts: ['control.invalid'],
      },
      fetchImpl: async (input: string | URL | Request, init: RequestInit) => {
        if (input instanceof URL) {
          const action = String(JSON.parse(String(init.body)).action);
          controlActions.push(action);
          return new Response(JSON.stringify(action === 'replace_function_runtime'
            ? {
                schemaVersion: 1,
                ok: true,
                action,
                operationId: 'operation-invalid-lease',
              }
            : {
                schemaVersion: 1,
                ok: true,
                action,
                operationId: 'operation-invalid-lease',
                remaining: [],
              }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        const route = new URL(String(input)).pathname;
        const correlationId = new Headers(init.headers).get('x-lab-correlation-id') || '';
        const isHot = route === '/api/hot';
        if (route === '/api/function') functionProbes += 1;
        return probeResponse({
          correlationId,
          runtimeIntent: isHot ? 'hot' : 'function',
          route,
          bootId: `${isHot ? 'hot' : 'function'}-steady`,
          bootAgeMs: 60_000,
          requestOrdinal: 10,
        });
      },
    });

    expect(controlActions).toEqual(['replace_function_runtime', 'restore_function_runtime']);
    expect(functionProbes).toBe(2); // pre-control plus ordinary measured sample; cold-after was skipped
    expect(result).toMatchObject({
      ok: false,
      coldProof: {
        proven: false,
        control: { mutated: true, success: false, reason: 'cold_control_lease_invalid' },
      },
      cleanup: {
        applicability: 'required', attempted: true, passed: true, remaining: [], operationId: 'operation-invalid-lease',
      },
    });
  });

  it('emits valid JSON but exits nonzero when configured Dedicated idle proof fails', async () => {
    let hotRequest = 0;
    let ordinal = 0;
    const server = createServer((request, response) => {
      ordinal += 1;
      const route = request.url || '/';
      const correlationId = String(request.headers['x-lab-correlation-id'] || 'missing');
      const runtimeIntent = route === '/api/hot' ? 'hot' : 'function';
      if (runtimeIntent === 'hot') hotRequest += 1;
      response.writeHead(200, {
        'content-type': 'application/json',
        'x-lab-correlation-id': correlationId,
        'x-vura-route-kind': runtimeIntent,
      });
      response.end(JSON.stringify({
        ok: true,
        handlerVersion: 1,
        runtimeIntent,
        route,
        correlationId,
        requestId: `request-${ordinal}`,
        bootId: runtimeIntent === 'hot' && hotRequest === 3 ? 'hot-replaced' : `${runtimeIntent}-boot`,
        bootAgeMs: runtimeIntent === 'hot' ? hotRequest : 60_000 + ordinal,
        requestOrdinal: runtimeIntent === 'hot' ? hotRequest : ordinal,
      }));
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server failed to bind');
    const script = resolve(runtimeLabRoot, 'scripts/benchmark.mjs');
    try {
      await expect(execFileAsync(process.execPath, [
        script,
        '--url', `http://127.0.0.1:${address.port}`,
        '--samples', '1',
        '--dedicated-idle-ms', '1',
        '--json',
      ], { cwd: runtimeLabRoot })).rejects.toMatchObject({
        code: 2,
        stdout: expect.stringContaining('"dedicatedIdleProof"'),
      });
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
    }
  });

  it('emits valid JSON but exits nonzero when --require-cold cannot prove cold', async () => {
    let ordinal = 0;
    const server = createServer((request, response) => {
      ordinal += 1;
      const route = request.url || '/';
      const correlationId = String(request.headers['x-lab-correlation-id'] || 'missing');
      const runtimeIntent = route === '/api/hot' ? 'hot' : 'function';
      response.writeHead(200, {
        'content-type': 'application/json',
        'x-lab-correlation-id': correlationId,
        'x-vura-route-kind': runtimeIntent,
      });
      response.end(JSON.stringify({
        ok: true,
        handlerVersion: 1,
        runtimeIntent,
        route,
        correlationId,
        requestId: `request-${ordinal}`,
        bootId: 'same-boot',
        bootAgeMs: 60_000 + ordinal,
        requestOrdinal: ordinal,
      }));
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server failed to bind');
    const script = resolve(runtimeLabRoot, 'scripts/benchmark.mjs');
    try {
      await expect(execFileAsync(process.execPath, [
        script,
        '--url', `http://127.0.0.1:${address.port}`,
        '--samples', '1',
        '--require-cold',
        '--json',
      ], { cwd: runtimeLabRoot })).rejects.toMatchObject({
        code: 2,
        stdout: expect.stringContaining('"classification": "not_proven"'),
      });
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
    }
  });
});
