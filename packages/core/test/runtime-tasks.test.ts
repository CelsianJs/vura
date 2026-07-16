/**
 * Task-runner unit + integration tests.
 *
 * Tests cover:
 *   - runTaskOnce: sync handlers, retry, timeout, error serialization, backoff clamp
 *   - Admin lifecycle: POST /__tasks/:name → 202+id; poll GET → completed; 404s; 403
 *   - Cron wiring: getCronJobs() wired, skip-if-running guard, store recording
 */

import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { shouldStartInProcessTaskCron, startVuraServer, type VuraServer } from '../src/runtime/server.js';
import { runTaskOnce, isTaskAdminAuthorized, createTaskResultStore } from '../src/runtime/tasks.js';

let srv: VuraServer | undefined;
afterEach(async () => { await srv?.close(); srv = undefined; });

// ─── runTaskOnce unit tests ──────────────────────────────────────────────────

describe('runTaskOnce', () => {
  it('sync handler completes (fix #1 — no .then crash)', async () => {
    const result = await runTaskOnce({
      name: 'sync', config: {},
      handler: () => ({ done: true }),
    }, { input: null });
    expect(result.status).toBe('completed');
    expect(result.result).toEqual({ done: true });
    expect(result.attempts).toBe(1);
  });

  it('async handler completes', async () => {
    const result = await runTaskOnce({
      name: 'async', config: {},
      handler: async () => 42,
    }, { input: null });
    expect(result.status).toBe('completed');
    expect(result.result).toBe(42);
  });

  it('enforces retry + timeout config', async () => {
    let attempts = 0;
    const result = await runTaskOnce({
      name: 'flaky', config: { retries: 2, timeout: 1000 },
      handler: async ({ attempt }) => { attempts++; if (attempt < 2) throw new Error('boom'); return { ok: true }; },
    }, { input: null });
    expect(attempts).toBe(2);
    expect(result.status).toBe('completed');

    const timedOut = await runTaskOnce({
      name: 'slow', config: { retries: 0, timeout: 50 },
      handler: () => new Promise((r) => setTimeout(() => r('late'), 5000)),
    }, { input: null });
    expect(timedOut.status).toBe('failed');
    expect(timedOut.error).toMatch(/timeout/i);
  });

  it('clamps attempts to at least 1 when retries is 0 or negative (fix #6)', async () => {
    const r = await runTaskOnce({ name: 't', config: { retries: 0 }, handler: () => 'ok' }, { input: null });
    expect(r.attempts).toBe(1);
  });

  it('serializes non-Error throws correctly (fix #7)', async () => {
    const rStr = await runTaskOnce({
      name: 't', config: {}, handler: () => { throw 'string-error'; },
    }, { input: null });
    expect(rStr.error).toBe('string-error');

    const rObj = await runTaskOnce({
      name: 't', config: {}, handler: () => { throw { code: 42 }; },
    }, { input: null });
    expect(rObj.error).toContain('42');
  });
});

// ─── isTaskAdminAuthorized unit tests ────────────────────────────────────────

describe('isTaskAdminAuthorized', () => {
  beforeEach(() => {
    delete process.env.THEN_TASK_SECRET;
  });
  afterEach(() => {
    delete process.env.THEN_TASK_SECRET;
  });

  it('allows localhost without secret in test env', () => {
    expect(isTaskAdminAuthorized(new Headers(), '127.0.0.1')).toBe(true);
    expect(isTaskAdminAuthorized(new Headers(), '::1')).toBe(true);
  });

  it('rejects remote without secret', () => {
    expect(isTaskAdminAuthorized(new Headers(), '10.0.0.1')).toBe(false);
  });

  it('accepts correct bearer token (timing-safe)', () => {
    process.env.THEN_TASK_SECRET = 'supersecret';
    const h = new Headers({ authorization: 'Bearer supersecret' });
    expect(isTaskAdminAuthorized(h, '10.0.0.1')).toBe(true);
  });

  it('rejects wrong bearer token (fix #9)', () => {
    process.env.THEN_TASK_SECRET = 'supersecret';
    const h = new Headers({ authorization: 'Bearer wrongtoken' });
    expect(isTaskAdminAuthorized(h, '10.0.0.1')).toBe(false);
  });
});

// ─── Admin lifecycle integration tests ──────────────────────────────────────

describe('task admin lifecycle', () => {
  describe('VURA_TASK_SYNC function-runtime dispatch', () => {
    let previousTaskSync: string | undefined;
    let previousTaskSecret: string | undefined;

    beforeEach(() => {
      previousTaskSync = process.env.VURA_TASK_SYNC;
      previousTaskSecret = process.env.THEN_TASK_SECRET;
      process.env.VURA_TASK_SYNC = '1';
      process.env.THEN_TASK_SECRET = 'sync-task-secret';
    });

    afterEach(() => {
      if (previousTaskSync === undefined) delete process.env.VURA_TASK_SYNC;
      else process.env.VURA_TASK_SYNC = previousTaskSync;
      if (previousTaskSecret === undefined) delete process.env.THEN_TASK_SECRET;
      else process.env.THEN_TASK_SECRET = previousTaskSecret;
    });

    it('executes a function task synchronously and returns its success envelope', async () => {
      srv = await startVuraServer({
        port: 0, pages: [],
        apiRoutes: [{
          urlPattern: '/api/sync-success', methods: ['POST'], kind: 'task', filePath: 'src/api/sync-success.ts',
          config: { retries: 0, timeout: 5000 },
          module: { POST: ({ input }: { input: unknown }) => ({ echoed: input }) },
        }],
      });

      const response = await fetch(`http://127.0.0.1:${srv.port}/__tasks/sync-success`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer sync-task-secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ message: 'hello' }),
      });

      expect(response.status).toBe(200);
      const envelope = await response.json() as Record<string, unknown>;
      expect(envelope).toMatchObject({
        ok: true,
        taskName: 'sync-success',
        result: { echoed: { message: 'hello' } },
      });
      expect(envelope).not.toHaveProperty('id');
      expect(envelope.attempts).toEqual([
        expect.objectContaining({ index: 1 }),
      ]);
    });

    it('executes a function task synchronously and returns its failure envelope', async () => {
      srv = await startVuraServer({
        port: 0, pages: [],
        apiRoutes: [{
          urlPattern: '/api/sync-failure', methods: ['POST'], kind: 'task', filePath: 'src/api/sync-failure.ts',
          config: { retries: 0, timeout: 5000 },
          module: { POST: () => { throw new Error('sync task failed'); } },
        }],
      });

      const response = await fetch(`http://127.0.0.1:${srv.port}/__tasks/sync-failure`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer sync-task-secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(500);
      const envelope = await response.json() as Record<string, unknown>;
      expect(envelope).toMatchObject({
        ok: false,
        taskName: 'sync-failure',
        error: 'sync task failed',
      });
      expect(envelope).not.toHaveProperty('id');
      expect(envelope.attempts).toEqual([
        expect.objectContaining({ index: 1, error: 'sync task failed' }),
      ]);
    });

    it('keeps the dedicated runtime on 202 + polling when sync mode is not enabled', async () => {
      delete process.env.VURA_TASK_SYNC;
      srv = await startVuraServer({
        port: 0, pages: [],
        apiRoutes: [{
          urlPattern: '/api/dedicated', methods: ['POST'], kind: 'task', filePath: 'src/api/dedicated.ts',
          config: { retries: 0, timeout: 5000 },
          module: { POST: () => ({ done: true }) },
        }],
      });

      const response = await fetch(`http://127.0.0.1:${srv.port}/__tasks/dedicated`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer sync-task-secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ id: expect.any(String), status: 'running' });
    });
  });

  it('POST /__tasks/:name → 202 + id; poll GET /__tasks/:id → completed with result', async () => {
    srv = await startVuraServer({
      port: 0, pages: [],
      apiRoutes: [{
        urlPattern: '/api/echo', methods: ['POST'], kind: 'task', filePath: 'src/api/echo.ts',
        config: { retries: 0, timeout: 5000 },
        module: { POST: ({ input }: { input: unknown }) => ({ echoed: input }) },
      }],
    });

    const triggerRes = await fetch(`http://127.0.0.1:${srv.port}/__tasks/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msg: 'hello' }),
    });
    expect(triggerRes.status).toBe(202);
    const { id } = await triggerRes.json() as { id: string };
    expect(typeof id).toBe('string');

    // Poll until completed (up to 2 s)
    let job: any;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const r = await fetch(`http://127.0.0.1:${srv.port}/__tasks/${id}`);
      job = await r.json();
      if (job.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(job.status).toBe('completed');
    expect(job.result).toEqual({ echoed: { msg: 'hello' } });
  });

  it('records per-attempt metadata + ok on the completed job (Phase 1)', async () => {
    srv = await startVuraServer({
      port: 0, pages: [],
      apiRoutes: [{
        urlPattern: '/api/retry', methods: ['POST'], kind: 'task', filePath: 'src/api/retry.ts',
        config: { retries: 1, timeout: 5000 },
        module: {
          POST: ({ attempt }: { attempt: number }) => { if (attempt < 2) throw new Error('flaky'); return { done: true }; },
        },
      }],
    });

    const triggerRes = await fetch(`http://127.0.0.1:${srv.port}/__tasks/retry`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    const { id } = await triggerRes.json() as { id: string };

    let job: any;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const r = await fetch(`http://127.0.0.1:${srv.port}/__tasks/${id}`);
      job = await r.json();
      if (job.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(job.status).toBe('completed');
    expect(job.ok).toBe(true);
    expect(Array.isArray(job.attempts)).toBe(true);
    expect(job.attempts).toHaveLength(2);
    expect(job.attempts[0].index).toBe(1);
    expect(job.attempts[0].error).toBe('flaky');
    expect(job.attempts[1].error).toBeUndefined();
    expect(job.attempts[1].startedAt).toBe(new Date(job.attempts[1].startedAt).toISOString());
  });

  it('rejects an invalid payload with 400 before creating a job (Phase 1 input schema)', async () => {
    // Zod-like schema requiring a string `name`.
    const nameSchema = {
      parse(d: unknown) { return d; },
      safeParse(d: unknown) {
        const obj = (d ?? {}) as Record<string, unknown>;
        return typeof obj.name === 'string'
          ? { success: true, data: obj }
          : { success: false, error: { issues: [{ path: ['name'], message: 'name is required', code: 'invalid_type' }] } };
      },
    };

    let handlerCalls = 0;
    srv = await startVuraServer({
      port: 0, pages: [],
      apiRoutes: [{
        urlPattern: '/api/needsname', methods: ['POST'], kind: 'task', filePath: 'src/api/needsname.ts',
        config: { retries: 0, timeout: 5000 },
        module: { input: nameSchema, POST: () => { handlerCalls++; return 'ok'; } },
      }],
    });

    const res = await fetch(`http://127.0.0.1:${srv.port}/__tasks/needsname`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ notName: 1 }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { code: string; details: unknown };
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(body.details)).toContain('name is required');
    // Give any (erroneously) scheduled run a tick — handler must never fire.
    await new Promise((r) => setTimeout(r, 30));
    expect(handlerCalls).toBe(0);
  });

  // Platform control-plane dispatch header protocol (X-Vura-Task-Id / X-Vura-Cron).
  describe('platform dispatch header protocol', () => {
    // Zod-like schema requiring a string `name`.
    const nameSchema = {
      parse(d: unknown) { return d; },
      safeParse(d: unknown) {
        const obj = (d ?? {}) as Record<string, unknown>;
        return typeof obj.name === 'string'
          ? { success: true, data: obj }
          : { success: false, error: { issues: [{ path: ['name'], message: 'name is required', code: 'invalid_type' }] } };
      },
    };

    async function pollJob(port: number, id: string): Promise<any> {
      let job: any;
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const r = await fetch(`http://127.0.0.1:${port}/__tasks/${id}`);
        job = await r.json();
        if (job.status !== 'running') break;
        await new Promise((r) => setTimeout(r, 20));
      }
      return job;
    }

    it('(a) platform cron dispatch (wrapper + both headers) is accepted without input validation', async () => {
      let seen: unknown;
      srv = await startVuraServer({
        port: 0, pages: [],
        apiRoutes: [{
          urlPattern: '/api/nightly', methods: ['POST'], kind: 'task', filePath: 'src/api/nightly.ts',
          config: { retries: 0, timeout: 5000 },
          module: { schedule: '0 3 * * *', input: nameSchema, POST: ({ input }: { input: unknown }) => { seen = input; return { ran: true }; } },
        }],
      });

      // Platform cron POSTs the wrapper body with BOTH headers; the synthetic
      // input has no `name`, which would fail the schema if validated.
      const res = await fetch(`http://127.0.0.1:${srv.port}/__tasks/nightly`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-vura-task-id': 'run-1', 'x-vura-cron': 'true' },
        body: JSON.stringify({ taskId: 'run-1', input: { _cron: true, _schedule: '0 3 * * *' }, attempt: 1 }),
      });
      expect(res.status).toBe(202);
      const { id } = await res.json() as { id: string };
      const job = await pollJob(srv.port, id);
      expect(job.status).toBe('completed');
      // Handler ran with the UNWRAPPED synthetic input (not the wrapper).
      expect(seen).toEqual({ _cron: true, _schedule: '0 3 * * *' });
    });

    it('(b) platform enqueue dispatch (wrapper + task-id only, valid payload) validates the UNWRAPPED payload', async () => {
      let seen: unknown;
      srv = await startVuraServer({
        port: 0, pages: [],
        apiRoutes: [{
          urlPattern: '/api/greet', methods: ['POST'], kind: 'task', filePath: 'src/api/greet.ts',
          config: { retries: 0, timeout: 5000 },
          module: { input: nameSchema, POST: ({ input }: { input: unknown }) => { seen = input; return { ok: true }; } },
        }],
      });

      const res = await fetch(`http://127.0.0.1:${srv.port}/__tasks/greet`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-vura-task-id': 'run-2' },
        body: JSON.stringify({ taskId: 'run-2', input: { name: 'ada' }, attempt: 1 }),
      });
      expect(res.status).toBe(202);
      const { id } = await res.json() as { id: string };
      const job = await pollJob(srv.port, id);
      expect(job.status).toBe('completed');
      // Handler received the unwrapped, validated payload — not the wrapper.
      expect(seen).toEqual({ name: 'ada' });
    });

    it('(c) platform enqueue dispatch with an INVALID unwrapped payload → 400, no job created', async () => {
      let calls = 0;
      srv = await startVuraServer({
        port: 0, pages: [],
        apiRoutes: [{
          urlPattern: '/api/greet2', methods: ['POST'], kind: 'task', filePath: 'src/api/greet2.ts',
          config: { retries: 0, timeout: 5000 },
          module: { input: nameSchema, POST: () => { calls++; return 'ok'; } },
        }],
      });

      const res = await fetch(`http://127.0.0.1:${srv.port}/__tasks/greet2`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-vura-task-id': 'run-3' },
        body: JSON.stringify({ taskId: 'run-3', input: { notName: 1 }, attempt: 1 }),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { code: string; details: unknown };
      expect(body.code).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(body.details)).toContain('name is required');
      await new Promise((r) => setTimeout(r, 30));
      expect(calls).toBe(0);
    });
  });

  it('POST unknown task name → 404', async () => {
    srv = await startVuraServer({ port: 0, pages: [], apiRoutes: [] });
    const r = await fetch(`http://127.0.0.1:${srv.port}/__tasks/nonexistent`, { method: 'POST' });
    expect(r.status).toBe(404);
  });

  it('GET unknown job id → 404', async () => {
    srv = await startVuraServer({ port: 0, pages: [], apiRoutes: [] });
    const r = await fetch(`http://127.0.0.1:${srv.port}/__tasks/99999`);
    expect(r.status).toBe(404);
  });

  it('wrong bearer → 403', async () => {
    const old = process.env.THEN_TASK_SECRET;
    process.env.THEN_TASK_SECRET = 'mySecret';
    try {
      srv = await startVuraServer({ port: 0, pages: [], apiRoutes: [] });
      const r = await fetch(`http://127.0.0.1:${srv.port}/__tasks`, {
        headers: { authorization: 'Bearer wrongSecret' },
      });
      expect(r.status).toBe(403);
    } finally {
      if (old === undefined) delete process.env.THEN_TASK_SECRET;
      else process.env.THEN_TASK_SECRET = old;
    }
  });
});

// ─── Cron wiring tests ───────────────────────────────────────────────────────

describe('cron wiring', () => {
  it('can disable in-process cron when the platform scheduler owns dispatch', () => {
    const tasks = [{ schedule: '0 3 * * *' }];
    expect([
      shouldStartInProcessTaskCron(tasks, {}),
      shouldStartInProcessTaskCron(tasks, { VURA_DISABLE_IN_PROCESS_CRON: '1' }),
      shouldStartInProcessTaskCron(tasks, { VURA_DISABLE_IN_PROCESS_CRON: 'true' }),
    ]).toEqual([true, false, false]);
  });

  it('registered task schedule export appears in getCronJobs()', async () => {
    // We can't easily access the internal `app` from VuraServer, but we can
    // verify indirectly: GET /__tasks lists the task with its schedule.
    srv = await startVuraServer({
      port: 0, pages: [],
      apiRoutes: [{
        urlPattern: '/api/cleanup', methods: ['POST'], kind: 'task', filePath: 'src/api/cleanup.ts',
        config: { retries: 1, timeout: 5000 },
        module: { schedule: '0 3 * * *', POST: async () => ({ cleaned: true }) },
      }],
    });
    const res = await fetch(`http://127.0.0.1:${srv.port}/__tasks`);
    const body = await res.json() as { tasks: { name: string; schedule?: string }[] };
    expect(body.tasks).toEqual([{ name: 'cleanup', schedule: '0 3 * * *' }]);
  });

  it('skip-if-running guard: cron store records first run and skips second concurrent invocation (fix #4)', async () => {
    // Test the guard directly via createTaskResultStore + runTaskOnce
    // without needing to invoke a real cron tick (deterministic, no timer races).
    const store = createTaskResultStore();
    const running = new Set<string>();
    const taskName = 'guarded';

    let resolveSlowHandler!: () => void;
    const slowHandlerStarted = new Promise<void>((r) => {
      resolveSlowHandler = r;
    });
    let slowHandlerDone = false;
    const slowHandlerFinished = new Promise<void>((done) => {
      // Simulate the cron callback pattern
      if (running.has(taskName)) return; // skip
      const jobId = store.nextId();
      const job = { id: jobId, taskName, status: 'running' as const, startedAt: Date.now() };
      store.add(job);
      running.add(taskName);
      runTaskOnce({
        name: taskName, config: {},
        handler: async () => {
          resolveSlowHandler();
          await new Promise<void>((r) => setTimeout(r, 50));
          slowHandlerDone = true;
        },
      }, { input: { _cron: true } }).then((result) => {
        Object.assign(job, { status: result.status, completedAt: Date.now() });
        running.delete(taskName);
        done();
      });
    });

    // Wait until slow handler is running
    await slowHandlerStarted;

    // Simulate second cron tick — should be skipped
    let skipped = false;
    if (running.has(taskName)) skipped = true;
    else {
      // Would proceed — guard failed
    }
    expect(skipped).toBe(true);
    expect(store.results.size).toBe(1); // only one run recorded

    // Let the first run finish
    await slowHandlerFinished;
    expect(slowHandlerDone).toBe(true);
    expect(store.results.get('1')?.status).toBe('completed');
    // Now guard is cleared
    expect(running.has(taskName)).toBe(false);
  });
});
