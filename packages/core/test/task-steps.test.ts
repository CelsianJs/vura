/**
 * Vura Tasks Phase 2 — durable-execution `step` API.
 *
 * Covers:
 *   - step.run memoization: fn runs once, replays from the dispatch steps map,
 *     newly-completed steps surface in the envelope (and only those).
 *   - suspend envelopes for every waitpoint kind (RUN/DATETIME/TOKEN) + that a
 *     suspension consumes no retry attempt and is not a failure.
 *   - resume: dispatch steps memoize the waited step; waitForTask returns a child
 *     FAILURE without throwing.
 *   - determinism guard: duplicate step key throws a clear, named error.
 *   - step.enqueue memoization (enqueue client called once, replayed after).
 *   - local-dev fallbacks (no platform): sleep/waitForToken resolve in-process,
 *     waitForTask resolves via the injected local child dispatcher.
 *   - buildTaskEnvelope suspend shape (ok stays true).
 *   - server /__tasks: a platform dispatch that suspends surfaces on the polled
 *     job; dispatch-v2 steps injection drives replay to completion.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { runTaskOnce, buildTaskEnvelope, type TaskRunResult } from '../src/runtime/tasks.js';
import type { TaskHandlerContext } from '../src/runtime/tasks.js';
import type { StepRecord, EnqueueFn, LocalChildDispatch } from '../src/runtime/steps.js';
import { startVuraServer, type VuraServer } from '../src/runtime/server.js';

let srv: VuraServer | undefined;
afterEach(async () => { await srv?.close(); srv = undefined; });

// ─── step.run memoization ────────────────────────────────────────────────────

describe('step.run memoization', () => {
  it('runs fn once, then replays from the dispatch steps map (fn not re-run)', async () => {
    let calls = 0;
    const handler = async ({ step }: TaskHandlerContext) => {
      const a = await step.run('a', async () => { calls++; return 'A'; });
      return { a };
    };

    const r1 = await runTaskOnce({ name: 't', config: {}, handler }, { input: null, hasPlatform: true });
    expect(r1.status).toBe('completed');
    expect(calls).toBe(1);
    expect(r1.result).toEqual({ a: 'A' });
    // The newly-completed step is surfaced for the platform to persist.
    expect(r1.steps).toEqual({ a: { status: 'completed', output: 'A' } });

    // Replay: the platform re-dispatches with the persisted step.
    const r2 = await runTaskOnce(
      { name: 't', config: {}, handler },
      { input: null, hasPlatform: true, steps: { a: { status: 'completed', output: 'A' } } },
    );
    expect(r2.status).toBe('completed');
    expect(calls).toBe(1); // fn was NOT called again
    expect(r2.result).toEqual({ a: 'A' });
    // Nothing NEW completed this pass → no steps in the envelope.
    expect(r2.steps).toBeUndefined();
  });

  it('does not redo a completed step across an internal retry after a later failure', async () => {
    let stepRuns = 0;
    let attempts = 0;
    const handler = async ({ attempt, step }: TaskHandlerContext) => {
      await step.run('once', async () => { stepRuns++; return 1; });
      attempts = attempt;
      if (attempt < 2) throw new Error('after-step boom');
      return 'ok';
    };
    const r = await runTaskOnce({ name: 't', config: { retries: 1 }, handler }, { input: null, hasPlatform: true });
    expect(r.status).toBe('completed');
    expect(attempts).toBe(2);
    // Step completed on attempt 1 and was memoized on the retry.
    expect(stepRuns).toBe(1);
  });
});

// ─── Suspend envelopes ───────────────────────────────────────────────────────

describe('suspend envelopes (platform)', () => {
  it('waitForTask → RUN waitpoint; carries pre-wait steps; consumes no attempt', async () => {
    const handler = async ({ step }: TaskHandlerContext) => {
      await step.run('prep', async () => 'ready');
      await step.waitForTask('child', 'tasks.child', { x: 1 });
      return 'unreachable';
    };
    const r = await runTaskOnce({ name: 't', config: { retries: 2 }, handler }, { input: null, hasPlatform: true });
    expect(r.status).toBe('suspended');
    expect(r.suspended).toEqual({
      stepKey: 'child',
      waitpoint: { kind: 'RUN', child: { task: 'tasks.child', payload: { x: 1 } } },
    });
    expect(r.steps).toEqual({ prep: { status: 'completed', output: 'ready' } });
    // Suspension is neither a failure nor a consumed attempt.
    expect(r.attempts).toBe(0);
    expect(r.attemptRecords).toEqual([]);
    expect(r.error).toBeUndefined();
  });

  it('sleep → DATETIME waitpoint with a future wakeAt', async () => {
    const before = Date.now();
    const handler = async ({ step }: TaskHandlerContext) => { await step.sleep('nap', 30); };
    const r = await runTaskOnce({ name: 't', config: {}, handler }, { input: null, hasPlatform: true });
    expect(r.status).toBe('suspended');
    expect(r.suspended?.waitpoint.kind).toBe('DATETIME');
    const wakeAt = Date.parse(r.suspended!.waitpoint.wakeAt!);
    expect(wakeAt).toBeGreaterThan(before + 29_000);
  });

  it('sleepUntil → DATETIME waitpoint at the exact instant', async () => {
    const when = new Date(Date.now() + 60_000);
    const handler = async ({ step }: TaskHandlerContext) => { await step.sleepUntil('until', when); };
    const r = await runTaskOnce({ name: 't', config: {}, handler }, { input: null, hasPlatform: true });
    expect(r.suspended?.waitpoint).toEqual({ kind: 'DATETIME', wakeAt: when.toISOString() });
  });

  it('waitForToken → TOKEN waitpoint carrying the timeout', async () => {
    const handler = async ({ step }: TaskHandlerContext) => { await step.waitForToken('approval', { timeoutSeconds: 3600 }); };
    const r = await runTaskOnce({ name: 't', config: {}, handler }, { input: null, hasPlatform: true });
    expect(r.suspended).toEqual({ stepKey: 'approval', waitpoint: { kind: 'TOKEN', timeoutSeconds: 3600 } });
  });
});

// ─── Resume ──────────────────────────────────────────────────────────────────

describe('resume via injected steps', () => {
  it('waitForTask returns the memoized child result on replay', async () => {
    const handler = async ({ step }: TaskHandlerContext) => {
      const child = await step.waitForTask('child', 'tasks.child', { x: 1 });
      return { child };
    };
    const r = await runTaskOnce(
      { name: 't', config: {}, handler },
      { input: null, hasPlatform: true, steps: { child: { status: 'completed', output: { ok: true, result: { done: true } } } } },
    );
    expect(r.status).toBe('completed');
    expect(r.result).toEqual({ child: { ok: true, result: { done: true } } });
  });

  it('waitForTask returns a child FAILURE output without throwing', async () => {
    const handler = async ({ step }: TaskHandlerContext) => {
      const child = await step.waitForTask('child', 'tasks.child');
      return { failed: !child.ok, err: child.error };
    };
    const r = await runTaskOnce(
      { name: 't', config: {}, handler },
      { input: null, hasPlatform: true, steps: { child: { status: 'completed', output: { ok: false, error: 'child boom' } } } },
    );
    expect(r.status).toBe('completed');
    expect(r.result).toEqual({ failed: true, err: 'child boom' });
  });

  it('waitForToken resolves a timed_out dispatch step to { timedOut: true }', async () => {
    const handler = async ({ step }: TaskHandlerContext) => step.waitForToken('tok');
    const r = await runTaskOnce(
      { name: 't', config: {}, handler },
      { input: null, hasPlatform: true, steps: { tok: { status: 'timed_out' } } },
    );
    expect(r.status).toBe('completed');
    expect(r.result).toEqual({ timedOut: true });
  });
});

// ─── Determinism guard ───────────────────────────────────────────────────────

describe('duplicate step key', () => {
  it('throws a clear error naming the key (surfaces as a failed run)', async () => {
    const handler = async ({ step }: TaskHandlerContext) => {
      await step.run('dup', () => 1);
      await step.run('dup', () => 2);
    };
    const r = await runTaskOnce({ name: 't', config: { retries: 0 }, handler }, { input: null, hasPlatform: true });
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/Duplicate step key "dup"/);
  });
});

// ─── step.enqueue ────────────────────────────────────────────────────────────

describe('step.enqueue memoization', () => {
  it('calls the enqueue client once and replays the runId', async () => {
    let enqCalls = 0;
    const enqueueFn: EnqueueFn = async () => { enqCalls++; return { runId: 'run-123', status: 'queued' }; };
    const handler = async ({ step }: TaskHandlerContext) => step.enqueue('e', 'tasks.other', { hi: true });

    const r1 = await runTaskOnce({ name: 't', config: {}, handler }, { input: null, hasPlatform: true, enqueueFn });
    expect(enqCalls).toBe(1);
    expect(r1.result).toEqual({ runId: 'run-123' });
    expect(r1.steps).toEqual({ e: { status: 'completed', output: { runId: 'run-123' } } });

    const r2 = await runTaskOnce(
      { name: 't', config: {}, handler },
      { input: null, hasPlatform: true, enqueueFn, steps: { e: { status: 'completed', output: { runId: 'run-123' } } } },
    );
    expect(enqCalls).toBe(1); // replayed, not re-enqueued
    expect(r2.result).toEqual({ runId: 'run-123' });
  });
});

// ─── Local-dev fallbacks (no platform) ───────────────────────────────────────

describe('local-dev fallbacks (no platform)', () => {
  it('sleep resolves in-process and records the step', async () => {
    const handler = async ({ step }: TaskHandlerContext) => { await step.sleep('s', 0.01); return 'done'; };
    const r = await runTaskOnce({ name: 't', config: {}, handler }, { input: null, hasPlatform: false });
    expect(r.status).toBe('completed');
    expect(r.result).toBe('done');
    expect(r.steps).toEqual({ s: { status: 'completed', output: null } });
  });

  it('waitForToken resolves { timedOut: true } after the (capped) timeout', async () => {
    const handler = async ({ step }: TaskHandlerContext) => step.waitForToken('t', { timeoutSeconds: 0.01 });
    const r = await runTaskOnce({ name: 't', config: {}, handler }, { input: null, hasPlatform: false });
    expect(r.status).toBe('completed');
    expect(r.result).toEqual({ timedOut: true });
  });

  it('waitForTask resolves via the injected local child dispatcher', async () => {
    const localChildDispatch: LocalChildDispatch = async (task, payload) => ({ ok: true, result: { task, echoed: payload } });
    const handler = async ({ step }: TaskHandlerContext) => step.waitForTask('c', 'tasks.child', { n: 5 });
    const r = await runTaskOnce({ name: 't', config: {}, handler }, { input: null, hasPlatform: false, localChildDispatch });
    expect(r.status).toBe('completed');
    expect(r.result).toEqual({ ok: true, result: { task: 'tasks.child', echoed: { n: 5 } } });
  });
});

// ─── buildTaskEnvelope ───────────────────────────────────────────────────────

describe('buildTaskEnvelope (suspend)', () => {
  it('ok stays true and carries suspended + steps', () => {
    const suspended: TaskRunResult = {
      status: 'suspended',
      attempts: 0,
      attemptRecords: [],
      suspended: { stepKey: 'child', waitpoint: { kind: 'RUN', child: { task: 'tasks.child' } } },
      steps: { prep: { status: 'completed', output: 'ready' } },
    };
    const env = buildTaskEnvelope('t', suspended);
    expect(env.ok).toBe(true);
    expect(env.result).toBeUndefined();
    expect(env.suspended).toEqual(suspended.suspended);
    expect(env.steps).toEqual(suspended.steps);
  });
});

// ─── Server /__tasks integration ─────────────────────────────────────────────

const waitTaskModule = {
  POST: async ({ step }: TaskHandlerContext) => {
    await step.run('log', async () => 'logged');
    await step.waitForToken('approval', { timeoutSeconds: 3600 });
    return 'done';
  },
};

async function pollJob(port: number, id: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 2000;
  let job: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    const r = await fetch(`http://127.0.0.1:${port}/__tasks/${id}`);
    job = await r.json() as Record<string, unknown>;
    if (job.status !== 'running') break;
    await new Promise((res) => setTimeout(res, 20));
  }
  return job;
}

describe('server /__tasks — Phase 2 dispatch', () => {
  const route = {
    urlPattern: '/api/wait', methods: ['POST'], kind: 'task' as const, filePath: 'src/api/wait.ts',
    config: { retries: 0, timeout: 5000 },
    module: waitTaskModule,
  };

  it('a suspending platform dispatch surfaces the waitpoint on the polled job', async () => {
    srv = await startVuraServer({ port: 0, pages: [], apiRoutes: [route] });
    const res = await fetch(`http://127.0.0.1:${srv.port}/__tasks/wait`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-vura-task-id': 'run-1' },
      body: JSON.stringify({ input: {}, runId: 'run-1', steps: {} }),
    });
    expect(res.status).toBe(202);
    const { id } = await res.json() as { id: string };

    const job = await pollJob(srv.port, id);
    expect(job.status).toBe('suspended');
    expect(job.ok).toBe(true);
    expect(job.suspended).toEqual({ stepKey: 'approval', waitpoint: { kind: 'TOKEN', timeoutSeconds: 3600 } });
    expect(job.steps).toEqual({ log: { status: 'completed', output: 'logged' } });
  });

  it('a resume dispatch with the merged steps map runs to completion', async () => {
    srv = await startVuraServer({ port: 0, pages: [], apiRoutes: [route] });
    const res = await fetch(`http://127.0.0.1:${srv.port}/__tasks/wait`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-vura-task-id': 'run-1' },
      body: JSON.stringify({
        input: {},
        runId: 'run-1',
        steps: {
          log: { status: 'completed', output: 'logged' },
          approval: { status: 'completed', output: { payload: { approved: true } } },
        },
      }),
    });
    const { id } = await res.json() as { id: string };
    const job = await pollJob(srv.port, id);
    expect(job.status).toBe('completed');
    expect(job.result).toBe('done');
  });
});
