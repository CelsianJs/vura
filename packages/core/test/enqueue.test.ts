/**
 * Vura Tasks Phase 1 — enqueue() client helper.
 *
 * Covers:
 *   - Platform path: POSTs to VURA_TASK_ENQUEUE_URL with a Bearer token and the
 *     { task, payload, delaySeconds, idempotencyKey } body; returns the parsed
 *     response; propagates non-2xx and network errors as HttpError (no swallow).
 *   - Local fallback: POSTs the raw payload to the local /__tasks/<name> endpoint
 *     with the THEN_TASK_SECRET bearer; maps { id } → { runId }.
 *   - delaySeconds: platform passthrough; local best-effort setTimeout returns
 *     { status: 'scheduled' } and eventually dispatches.
 *   - idempotencyKey passthrough.
 *
 * fetch is stubbed via vi.stubGlobal so no live server is needed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { enqueue } from '../src/enqueue.js';
import { HttpError } from '../src/errors.js';

const PLATFORM_URL = 'https://platform.vura.test/enqueue';

interface Captured {
  url: string;
  init: RequestInit;
}

function jsonResponse(body: unknown, init: { status?: number; ok?: boolean } = {}): Response {
  const status = init.status ?? 200;
  return {
    ok: init.ok ?? (status >= 200 && status < 300),
    status,
    statusText: `HTTP ${status}`,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

let captured: Captured[];

function stubFetch(impl: (url: string, init: RequestInit) => Response | Promise<Response>): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    captured.push({ url, init });
    return impl(url, init);
  }));
}

beforeEach(() => {
  captured = [];
  delete process.env.VURA_TASK_ENQUEUE_URL;
  delete process.env.VURA_TASK_ENQUEUE_TOKEN;
  delete process.env.THEN_TASK_SECRET;
  delete process.env.VURA_LOCAL_TASK_URL;
  delete process.env.PORT;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ─── Platform path ───────────────────────────────────────────────────────────

describe('enqueue — platform path', () => {
  beforeEach(() => {
    process.env.VURA_TASK_ENQUEUE_URL = PLATFORM_URL;
    process.env.VURA_TASK_ENQUEUE_TOKEN = 'plat-token';
  });

  it('POSTs to the broker with Bearer auth and the documented body', async () => {
    stubFetch(() => jsonResponse({ runId: 'run_123', status: 'queued' }));

    const result = await enqueue('tasks.cleanup', { userId: 7 }, {
      delaySeconds: 30,
      idempotencyKey: 'idem-1',
    });

    expect(result).toEqual({ runId: 'run_123', status: 'queued' });
    expect(captured).toHaveLength(1);
    const { url, init } = captured[0];
    expect(url).toBe(PLATFORM_URL);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer plat-token');
    expect(JSON.parse(init.body as string)).toEqual({
      task: 'tasks.cleanup',
      payload: { userId: 7 },
      delaySeconds: 30,
      idempotencyKey: 'idem-1',
    });
  });

  it('omits delaySeconds/idempotencyKey when not provided', async () => {
    stubFetch(() => jsonResponse({ runId: 'r', status: 'queued' }));
    await enqueue('tasks.ping');
    const body = JSON.parse(captured[0].init.body as string);
    expect(body).toEqual({ task: 'tasks.ping', payload: undefined });
    expect('delaySeconds' in body).toBe(false);
    expect('idempotencyKey' in body).toBe(false);
  });

  it('tolerates unknown fields in the broker response', async () => {
    stubFetch(() => jsonResponse({ runId: 'r', status: 'queued', extra: { nested: true } }));
    const result = await enqueue('tasks.x', {});
    expect(result.extra).toEqual({ nested: true });
  });

  it('throws HttpError on a non-2xx response (no silent swallow)', async () => {
    stubFetch(() => jsonResponse({ error: 'over quota' }, { status: 429 }));
    await expect(enqueue('tasks.x', {})).rejects.toMatchObject({
      name: 'HttpError',
      statusCode: 429,
    });
    await expect(enqueue('tasks.x', {})).rejects.toThrow(/over quota/);
  });

  it('throws HttpError on a network failure', async () => {
    stubFetch(() => { throw new Error('ECONNREFUSED'); });
    const err = await enqueue('tasks.x', {}).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).statusCode).toBe(502);
    expect((err as HttpError).message).toMatch(/ECONNREFUSED/);
  });
});

// ─── Local fallback path ─────────────────────────────────────────────────────

describe('enqueue — local fallback', () => {
  it('POSTs the raw payload to the local /__tasks/<name> endpoint with the secret', async () => {
    process.env.THEN_TASK_SECRET = 'dev-secret';
    process.env.PORT = '4321';
    stubFetch(() => jsonResponse({ id: 'job-9', status: 'running' }));

    const result = await enqueue('tasks.cleanup', { a: 1 });

    expect(captured[0].url).toBe('http://127.0.0.1:4321/__tasks/tasks.cleanup');
    const headers = captured[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer dev-secret');
    expect(JSON.parse(captured[0].init.body as string)).toEqual({ a: 1 });
    // { id } is normalised to { runId } while preserving original fields.
    expect(result).toEqual({ id: 'job-9', status: 'running', runId: 'job-9' });
  });

  it('sends no auth header when THEN_TASK_SECRET is unset (loopback dev)', async () => {
    stubFetch(() => jsonResponse({ id: 'j', status: 'running' }));
    await enqueue('tasks.x', { b: 2 });
    const headers = captured[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
    expect(captured[0].url).toBe('http://127.0.0.1:3000/__tasks/tasks.x');
  });

  it('honours VURA_LOCAL_TASK_URL as the base', async () => {
    process.env.VURA_LOCAL_TASK_URL = 'http://localhost:9999/';
    stubFetch(() => jsonResponse({ id: 'j' }));
    await enqueue('tasks.x');
    expect(captured[0].url).toBe('http://localhost:9999/__tasks/tasks.x');
  });

  it('throws HttpError when the local endpoint rejects', async () => {
    stubFetch(() => jsonResponse({ error: 'Task not found: tasks.nope' }, { status: 404 }));
    await expect(enqueue('tasks.nope')).rejects.toMatchObject({ name: 'HttpError', statusCode: 404 });
  });

  it('delaySeconds schedules a best-effort local dispatch and returns scheduled', async () => {
    vi.useFakeTimers();
    stubFetch(() => jsonResponse({ id: 'later', status: 'running' }));

    const result = await enqueue('tasks.later', { x: 1 }, { delaySeconds: 5 });
    expect(result).toEqual({ status: 'scheduled' });
    // Not dispatched yet.
    expect(captured).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(5000);
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toContain('/__tasks/tasks.later');
  });
});
