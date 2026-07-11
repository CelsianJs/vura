/**
 * Vura task runner — runTaskOnce, result store, auth helper, cron wiring,
 * and admin route registration.
 *
 * Extracted from server.ts (Task 12) to keep server.ts focused on HTTP/WS
 * plumbing. Zero behaviour change beyond the fixes listed below.
 *
 * Fixes applied here:
 *   #1  runTaskOnce: wrap handler in Promise.resolve().then() so sync handlers work.
 *   #2  Cron failures: record runs in taskStore + console.error on failed.
 *   #4  Overlap guard: running Set<string> — skip cron tick if same task still running.
 *   #5  Backoff: Math.min(100 * 2 ** (attempt - 1), 30_000).
 *   #6  Clamp attempts: Math.max(1, 1 + (config.retries ?? 0)).
 *   #7  Non-Error throw serialization: Error→message, string→itself, else JSON fallback.
 *   #8  /__tasks prefix exact-match guard (=== or startsWith('/__tasks/')).
 *   #9  Timing-safe bearer compare via sha256 + crypto.timingSafeEqual.
 *   #10 Eviction: forward scan of insertion-ordered Map (no full sort).
 *   #11 Manual trigger reads optional JSON body (size-capped 64 KB, malformed→400).
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { CelsianApp } from '@celsian/core';
import { validateTaskInput } from '../validation.js';
import { enqueue } from '../enqueue.js';
import {
  createTaskStep,
  isSuspendSignal,
  type EnqueueFn,
  type LocalChildDispatch,
  type StepRecord,
  type TaskStep,
  type Waitpoint,
} from './steps.js';
import type { RuntimeApiRoute } from './api-app.js';

// ─── Public types ───────────────────────────────────────────────────────────

/**
 * Metadata for a single execution attempt of a task.
 * Collected by runTaskOnce and surfaced in the task run envelope so callers
 * (the platform, the CLI, the /__tasks admin surface) can see the retry history.
 */
export interface TaskAttempt {
  /** 1-based attempt number. */
  index: number;
  /** ISO timestamp when the attempt started. */
  startedAt: string;
  /** Wall-clock duration of the attempt in milliseconds. */
  durationMs: number;
  /** Safe error message (message only, never a stack) when the attempt failed. */
  error?: string;
}

export interface TaskRunResult {
  status: 'completed' | 'failed' | 'suspended';
  result?: unknown;
  error?: string;
  /** Number of attempts made (= attemptRecords.length). Kept for compatibility. */
  attempts: number;
  /** Per-attempt metadata (added Phase 1). Empty on a validation failure. */
  attemptRecords: TaskAttempt[];
  /**
   * Present when the payload failed `input` schema validation. Carries the
   * standard validation kit error body and a 400 status. When set, no handler
   * attempt was made and `attempts` is 0.
   */
  validationError?: { statusCode: 400; body: unknown };
  /**
   * Present when `status === 'suspended'` (Phase 2): the step that suspended the
   * run and the waitpoint the platform must create. Suspension is not a failure
   * and consumes no retry attempt.
   */
  suspended?: { stepKey: string; waitpoint: Waitpoint };
  /**
   * Steps newly completed during THIS invocation (Phase 2). Surfaced on every
   * terminal outcome so the platform can persist them for replay. Absent/empty
   * when the handler used no steps.
   */
  steps?: Record<string, StepRecord>;
}

/**
 * The additive, backward-compatible envelope surfaced from a task execution.
 * Shape is locked against the platform's run-recording contract:
 *   Phase 1: { ok, taskName, attempts: TaskAttempt[], result? }
 *   Phase 2: additionally { suspended?, steps? } — `ok` is true when suspended.
 */
export interface TaskRunEnvelope {
  ok: boolean;
  taskName: string;
  attempts: TaskAttempt[];
  result?: unknown;
  /** Terminal failure message (mirrors TaskRunResult.error). Failed runs only. */
  error?: string;
  /**
   * Present when the handler suspended on a waitpoint (Phase 2). `ok` stays
   * true — the run is waiting, not failed; the platform must NOT record failure.
   */
  suspended?: { stepKey: string; waitpoint: Waitpoint };
  /** Steps newly completed this invocation (Phase 2). Omitted when empty. */
  steps?: Record<string, StepRecord>;
}

/**
 * The context object passed to a task's POST handler.
 *
 * Phase 2 adds `runId` and `step` additively — a handler that only reads
 * `{ attempt, input }` keeps working unchanged.
 */
export interface TaskHandlerContext {
  attempt: number;
  input: unknown;
  /** The platform run id when dispatched as part of a durable run (Phase 2). */
  runId?: string;
  /** Durable-execution step API (Phase 2). */
  step: TaskStep;
}

export interface TaskRunDefinition {
  name: string;
  config: { retries?: number; timeout?: number };
  handler: (ctx: TaskHandlerContext) => unknown;
  /**
   * Optional `input` schema exported by the task file. When provided, the
   * payload is validated before the first attempt; a failure short-circuits
   * with a 400 (via TaskRunResult.validationError) and consumes no attempts.
   */
  inputSchema?: unknown;
}

/** Options for {@link runTaskOnce}. Only `input` is required (Phase 1 compat). */
export interface RunTaskOnceOptions {
  input: unknown;
  /** Persisted steps from the dispatch (Phase 2). Missing = `{}` (first run). */
  steps?: Record<string, StepRecord>;
  /** Platform run id threaded onto the handler ctx (Phase 2). */
  runId?: string;
  /**
   * Whether a durable platform is present. When true, wait steps suspend; when
   * false, they resolve best-effort in-process. Defaults to detecting the
   * platform enqueue env (`VURA_TASK_ENQUEUE_URL` + `VURA_TASK_ENQUEUE_TOKEN`).
   */
  hasPlatform?: boolean;
  /** Enqueue client for `step.enqueue`/`step.waitForTask`. Defaults to `enqueue`. */
  enqueueFn?: EnqueueFn;
  /** Local child dispatcher for off-platform `step.waitForTask`. */
  localChildDispatch?: LocalChildDispatch;
}

/**
 * Build the additive task run envelope from a TaskRunResult.
 * `result` is included only on success; `suspended` only when waiting.
 * `ok` is true for both completed and suspended runs — only a real failure is
 * `ok: false` (the platform keys failure-recording off this).
 */
export function buildTaskEnvelope(taskName: string, result: TaskRunResult): TaskRunEnvelope {
  const envelope: TaskRunEnvelope = {
    ok: result.status !== 'failed',
    taskName,
    attempts: result.attemptRecords,
  };
  if (result.status === 'completed') {
    envelope.result = result.result;
  }
  if (result.status === 'failed' && typeof result.error === 'string') {
    envelope.error = result.error;
  }
  if (result.status === 'suspended' && result.suspended) {
    envelope.suspended = result.suspended;
  }
  if (result.steps && Object.keys(result.steps).length > 0) {
    envelope.steps = result.steps;
  }
  return envelope;
}

// ─── runTaskOnce ─────────────────────────────────────────────────────────────

/**
 * Run a task once with retry and per-attempt timeout.
 *
 * Attempts = Math.max(1, 1 + retries).
 * Between attempts: exponential backoff capped at 30 s: 100 * 2^(attempt-1) ms.
 * Each attempt races a timeout Promise that rejects after `timeoutMs` ms.
 *
 * Sync handlers are supported: the handler return value is wrapped with
 * Promise.resolve() so `.then` is always available regardless of whether
 * the handler is async or sync.
 */
export async function runTaskOnce(
  def: TaskRunDefinition,
  opts: RunTaskOnceOptions,
): Promise<TaskRunResult> {
  // ── Input-schema validation (Phase 1) ──
  // Runs before any attempt so a bad payload short-circuits with a 400 and
  // consumes no retries. Skipped when the task exports no `input` schema.
  let input = opts.input;
  if (def.inputSchema) {
    const validation = validateTaskInput(input, def.inputSchema);
    if (!validation.ok) {
      return {
        status: 'failed',
        error: validation.body.error,
        attempts: 0,
        attemptRecords: [],
        validationError: { statusCode: 400, body: validation.body },
      };
    }
    input = validation.value;
  }

  // ── Durable-step state (Phase 2) ──
  // `dispatchSteps` = steps persisted by the platform (replayed, read-only).
  // `newSteps` accumulates steps completed THIS invocation — shared across the
  // internal retry passes below so a mid-handler failure never redoes a step.
  const dispatchSteps: Record<string, StepRecord> = opts.steps ?? {};
  const newSteps: Record<string, StepRecord> = {};
  const hasPlatform = opts.hasPlatform ??
    Boolean((process.env.VURA_TASK_ENQUEUE_URL ?? '').trim() && (process.env.VURA_TASK_ENQUEUE_TOKEN ?? '').trim());
  const enqueueFn: EnqueueFn = opts.enqueueFn ?? enqueue;
  const stepsOut = (): Record<string, StepRecord> | undefined =>
    Object.keys(newSteps).length > 0 ? newSteps : undefined;

  const maxAttempts = Math.max(1, 1 + (def.config.retries ?? 0));
  const timeoutMs = def.config.timeout ?? 30_000;
  let lastError = '';
  const attemptRecords: TaskAttempt[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Backoff before retry (not before first attempt), capped at 30 s
    if (attempt > 1) {
      const backoffMs = Math.min(100 * 2 ** (attempt - 1), 30_000);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, backoffMs);
        if (typeof t.unref === 'function') t.unref();
      });
    }

    // Fresh step per pass: shares the memo (`dispatchSteps`/`newSteps`) but keeps
    // its own duplicate-key guard, so a replay of the same key is fine.
    const step = createTaskStep({
      completed: dispatchSteps,
      newSteps,
      hasPlatform,
      enqueueFn,
      localChildDispatch: opts.localChildDispatch,
    });

    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        // Fix #1: wrap with Promise.resolve().then() so sync handlers work.
        Promise.resolve().then(() => def.handler({ attempt, input, runId: opts.runId, step })).then((r) => {
          clearTimeout(timeoutHandle);
          return r;
        }),
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error(`Task timeout after ${timeoutMs}ms`)),
            timeoutMs,
          );
          if (typeof timeoutHandle.unref === 'function') timeoutHandle.unref();
        }),
      ]);
      attemptRecords.push({ index: attempt, startedAt, durationMs: Date.now() - startedAtMs });
      return { status: 'completed', result, attempts: attempt, attemptRecords, steps: stepsOut() };
    } catch (err: unknown) {
      clearTimeout(timeoutHandle);
      // Phase 2: a suspend is not a failure and consumes no attempt — return the
      // waitpoint + any steps completed before the suspend, without recording
      // this pass as an attempt.
      if (isSuspendSignal(err)) {
        return {
          status: 'suspended',
          attempts: attemptRecords.length,
          attemptRecords,
          suspended: { stepKey: err.stepKey, waitpoint: err.waitpoint },
          steps: stepsOut(),
        };
      }
      // Fix #7: serialize non-Error throws correctly (message only — never a stack)
      if (err instanceof Error) {
        lastError = err.message;
      } else if (typeof err === 'string') {
        lastError = err;
      } else {
        try {
          lastError = JSON.stringify(err);
        } catch {
          lastError = String(err);
        }
      }
      attemptRecords.push({ index: attempt, startedAt, durationMs: Date.now() - startedAtMs, error: lastError });
    }
  }

  return { status: 'failed', error: lastError, attempts: maxAttempts, attemptRecords, steps: stepsOut() };
}

// ─── Task result store ───────────────────────────────────────────────────────

export interface TaskAdminJob {
  id: string;
  taskName: string;
  status: 'running' | 'completed' | 'failed' | 'suspended';
  result?: unknown;
  error?: string;
  startedAt: number;
  completedAt?: number;
  /** true once a run completed successfully OR suspended (added Phase 1/2). */
  ok?: boolean;
  /** Per-attempt metadata once the run resolved (added Phase 1). */
  attempts?: TaskAttempt[];
  /** Waitpoint the run is blocked on when `status === 'suspended'` (Phase 2). */
  suspended?: { stepKey: string; waitpoint: Waitpoint };
  /** Steps completed during the invocation (Phase 2). */
  steps?: Record<string, StepRecord>;
}

const MAX_TASK_RESULTS = 10_000;

export interface TaskResultStore {
  results: Map<string, TaskAdminJob>;
  nextId(): string;
  add(job: TaskAdminJob): void;
}

export function createTaskResultStore(): TaskResultStore {
  const results = new Map<string, TaskAdminJob>();
  let counter = 0;

  function nextId(): string {
    return String(++counter);
  }

  function add(job: TaskAdminJob): void {
    results.set(job.id, job);
    // Fix #10: forward scan of insertion-ordered Map — no full sort needed
    if (results.size > MAX_TASK_RESULTS) {
      for (const [key, j] of results) {
        if (j.status !== 'running') {
          results.delete(key);
          if (results.size <= MAX_TASK_RESULTS) break;
        }
      }
    }
  }

  return { results, nextId, add };
}

// ─── Auth helper ─────────────────────────────────────────────────────────────

/**
 * Fix #9: timing-safe bearer comparison.
 * Both sides are hashed with sha256 before timingSafeEqual so the lengths are
 * always equal (avoiding the length-leak that a direct buffer compare would
 * introduce when the lengths differ).
 */
function sha256Hex(s: string): Buffer {
  return createHash('sha256').update(s).digest();
}

export function isTaskAdminAuthorized(
  headers: Headers,
  remoteAddress: string,
): boolean {
  const taskSecret = (process.env.THEN_TASK_SECRET ?? '').trim();
  if (taskSecret) {
    const auth = headers.get('authorization') ?? '';
    const prefix = 'Bearer ';
    if (!auth.startsWith(prefix)) return false;
    const provided = auth.slice(prefix.length);
    const expectedBuf = sha256Hex(taskSecret);
    const providedBuf = sha256Hex(provided);
    return timingSafeEqual(expectedBuf, providedBuf);
  }
  // No secret: allow localhost in dev/test
  const nodeEnv = (process.env.NODE_ENV ?? '').toLowerCase();
  const isNonProd = nodeEnv === 'development' || nodeEnv === 'dev' || nodeEnv === 'test';
  const isLocal = remoteAddress === '127.0.0.1' || remoteAddress === '::1';
  return isNonProd && isLocal;
}

// ─── Cron wiring ─────────────────────────────────────────────────────────────

/**
 * Register task cron jobs and admin routes on the Celsian app.
 *
 * Fix #2: cron failures are recorded in the task store and logged via console.error.
 * Fix #4: a `running` Set<string> skips a cron tick when the same task is already
 *   running (prevents overlap). Manual POST triggers bypass this guard (it's explicit).
 *
 * @param app            The Celsian app created by createApiApp.
 * @param taskRoutes     Route entries with kind === 'task'.
 * @param taskStore      The shared result store.
 * @param taskNameFromPattern  Fn to derive task name from urlPattern.
 * @returns registeredTasks array (name + optional schedule) for GET /__tasks.
 */
export function registerTaskCrons(
  app: CelsianApp,
  taskRoutes: RuntimeApiRoute[],
  taskStore: TaskResultStore,
  taskNameFromPattern: (p: string) => string,
): { name: string; schedule?: string }[] {
  const registeredTasks: { name: string; schedule?: string }[] = [];

  /** Fix #4: guard against concurrent cron overlap per task name. */
  const running = new Set<string>();

  for (const route of taskRoutes) {
    const schedule = (route.config.schedule as string | undefined) ??
      (typeof (route.module as any).schedule === 'string' ? (route.module as any).schedule : undefined);
    const handler = (route.module as any).POST as ((ctx: { attempt: number; input: unknown }) => unknown) | undefined;
    const taskName = taskNameFromPattern(route.urlPattern);

    registeredTasks.push({ name: taskName, schedule });

    if (schedule && typeof handler === 'function') {
      const def: TaskRunDefinition = {
        name: taskName,
        config: {
          retries: typeof route.config.retries === 'number' ? route.config.retries : 0,
          timeout: typeof route.config.timeout === 'number' ? route.config.timeout : 30_000,
        },
        handler,
      };

      /**
       * Fix #2 + #4: cron callback records a job entry in the store and logs on failure.
       * Fix #4: skip if already running (log a line); manual POST is still allowed.
       */
      app.cron(taskName, schedule, () => {
        if (running.has(taskName)) {
          console.warn(`[vura] scheduled task "${taskName}" skipped — still running from previous tick`);
          return;
        }

        const jobId = taskStore.nextId();
        const job: TaskAdminJob = {
          id: jobId,
          taskName,
          status: 'running',
          startedAt: Date.now(),
        };
        taskStore.add(job);
        running.add(taskName);

        runTaskOnce(def, { input: { _cron: true } }).then((runResult) => {
          job.status = runResult.status;
          job.result = runResult.result;
          job.error = runResult.error;
          job.ok = runResult.status !== 'failed';
          job.attempts = runResult.attemptRecords;
          job.suspended = runResult.suspended;
          job.steps = runResult.steps;
          job.completedAt = Date.now();
          if (runResult.status === 'failed') {
            console.error(
              `[vura] scheduled task "${taskName}" failed after ${runResult.attempts} attempt(s): ${runResult.error}`,
            );
          }
        }).catch((err: unknown) => {
          job.status = 'failed';
          job.error = err instanceof Error ? err.message : String(err);
          job.completedAt = Date.now();
          console.error(`[vura] scheduled task "${taskName}" unexpected error: ${job.error}`);
        }).finally(() => {
          running.delete(taskName);
        });
      });
    }
  }

  return registeredTasks;
}

/**
 * Read an optional JSON body from a Node.js IncomingMessage.
 * Size-capped at `maxBytes` (default 64 KB). Resolves to:
 *   - parsed JSON value if Content-Type includes 'json' and body is present
 *   - null if no body / non-JSON content-type
 * Rejects with { status: 400, message } on malformed JSON or oversized body.
 *
 * Used by POST /__tasks/:name to pass optional input to the handler.
 * Cron triggers always use { _cron: true } and do not go through this.
 *
 * Fix #11.
 */
export async function readOptionalJsonBody(
  nodeReq: import('node:http').IncomingMessage,
  maxBytes = 65_536,
): Promise<{ ok: true; value: unknown } | { ok: false; status: 400; message: string }> {
  const ct = (nodeReq.headers['content-type'] ?? '').toLowerCase();
  if (!ct.includes('json')) return { ok: true, value: null };

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;

    nodeReq.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        nodeReq.destroy();
        resolve({ ok: false, status: 400, message: 'Request body too large (max 64 KB)' });
      } else {
        chunks.push(chunk);
      }
    });

    nodeReq.on('end', () => {
      if (chunks.length === 0) {
        resolve({ ok: true, value: null });
        return;
      }
      try {
        resolve({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf-8')) });
      } catch {
        resolve({ ok: false, status: 400, message: 'Malformed JSON body' });
      }
    });

    nodeReq.on('error', () => {
      resolve({ ok: false, status: 400, message: 'Error reading request body' });
    });
  });
}
