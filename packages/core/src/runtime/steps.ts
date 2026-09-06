/**
 * Vura Tasks Phase 2 — durable-execution `step` API (Inngest-shaped).
 *
 * A task handler receives a `step` object on its context. Each `step.*` call is
 * keyed and memoized: on the first invocation the work runs and its output is
 * recorded; on a later re-invocation of the SAME run (a "replay") the recorded
 * output is returned WITHOUT re-running the work. This is how Vura gives durable
 * execution over HTTP re-invocation without holding a live process (no CRIU):
 * the platform persists completed steps and re-dispatches the same `runId` with
 * the accumulated `steps` map; the handler re-runs from the top and each
 * `step.*` call replays its memoized result until execution reaches the point
 * that must suspend and wait.
 *
 * Suspension is signalled by throwing a {@link SuspendSignal} from a wait step.
 * `runTaskOnce` catches it, returns the suspend envelope, and — critically —
 * treats it as neither a failure nor a consumed retry attempt.
 *
 * Local dev (no platform): waits cannot be durable, so they resolve best-effort
 * in-process (`sleep` = a real timer, `waitForTask` = a direct local dispatch of
 * the child, `waitForToken` = a bounded timeout that resolves `{ timedOut: true }`)
 * with a one-time note that durable semantics require the platform.
 */

// ─── Waitpoint + suspension ──────────────────────────────────────────────────

export type WaitpointKind = 'RUN' | 'DATETIME' | 'TOKEN';

/**
 * A request to suspend the run until an external condition is met. Carried in
 * the run envelope's `suspended` field; the platform creates the durable
 * waitpoint and re-dispatches the run when it completes.
 */
export interface Waitpoint {
  kind: WaitpointKind;
  /** RUN: the child task the platform must enqueue and link to this run. */
  child?: { task: string; payload?: unknown };
  /** DATETIME: ISO-8601 instant to wake the run at. */
  wakeAt?: string;
  /** TOKEN: seconds until the token times out; the platform mints the token. */
  timeoutSeconds?: number;
}

/**
 * Internal control-flow signal thrown by a wait step to unwind the handler.
 * Not an `Error` subclass on purpose — it must never be mistaken for a task
 * failure by generic `catch (err instanceof Error)` handling.
 */
export class SuspendSignal {
  /** Brand for cross-realm-safe identification (`instanceof` can fail across bundles). */
  readonly __vuraSuspend = true as const;
  constructor(
    readonly stepKey: string,
    readonly waitpoint: Waitpoint,
  ) {}
}

/** True for a {@link SuspendSignal} regardless of realm/bundle identity. */
export function isSuspendSignal(err: unknown): err is SuspendSignal {
  return (
    err instanceof SuspendSignal ||
    (typeof err === 'object' && err !== null && (err as { __vuraSuspend?: unknown }).__vuraSuspend === true)
  );
}

/** Thrown when the same step key is used twice in a single top-to-bottom pass. */
export class DuplicateStepKeyError extends Error {
  constructor(key: string) {
    super(
      `Duplicate step key "${key}" used twice in one task invocation. ` +
        'Every step.* call must use a unique key so replays stay deterministic.',
    );
    this.name = 'DuplicateStepKeyError';
  }
}

// ─── Step record + context ───────────────────────────────────────────────────

/** A persisted step outcome, as carried in the dispatch `steps` map. */
export interface StepRecord {
  status: 'completed' | 'timed_out';
  output?: unknown;
}

export interface StepEnqueueOptions {
  delaySeconds?: number;
  idempotencyKey?: string;
}

/** The enqueue client shape `step.enqueue` delegates to (defaults to `enqueue()`). */
export type EnqueueFn = (
  task: string,
  payload?: unknown,
  opts?: StepEnqueueOptions,
) => Promise<{ runId?: string; [key: string]: unknown }>;

/** Child-run result surfaced by `step.waitForTask`. */
export interface ChildRunResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** Local-dev child dispatcher: run a task by name and await its terminal result. */
export type LocalChildDispatch = (task: string, payload?: unknown) => Promise<ChildRunResult>;

export interface StepFactoryContext {
  /** Steps already resolved (dispatch `steps` + earlier internal-retry passes). */
  completed: Record<string, StepRecord>;
  /** Newly-resolved steps this invocation — the envelope's `steps` accumulator. */
  newSteps: Record<string, StepRecord>;
  /** Whether a durable platform is present. When false, waits resolve locally. */
  hasPlatform: boolean;
  /** Enqueue client for `step.enqueue`. */
  enqueueFn: EnqueueFn;
  /** Optional local child dispatcher for `step.waitForTask` off-platform. */
  localChildDispatch?: LocalChildDispatch;
}

// ─── Public step interface ───────────────────────────────────────────────────

export interface TaskStep {
  /**
   * Run `fn` and memoize its output under `key`. A replay with the recorded
   * checkpoint returns that output without calling `fn` again. A crash before
   * the checkpoint is persisted can repeat `fn`; external side effects require
   * stable idempotency keys or transactions. Local checkpoints are in-process.
   */
  run<T>(key: string, fn: () => T | Promise<T>): Promise<T>;
  /** Enqueue a task (memoized), returning `{ runId }`. Fire-and-forget. */
  enqueue(key: string, task: string, payload?: unknown, opts?: StepEnqueueOptions): Promise<{ runId?: string }>;
  /**
   * Enqueue a child task and wait for its terminal result ("triggerAndWait").
   * On the platform this suspends the run; on replay it returns the child's
   * `{ ok, result?, error? }` — a child failure is returned, never thrown.
   */
  waitForTask(key: string, task: string, payload?: unknown, opts?: StepEnqueueOptions): Promise<ChildRunResult>;
  /** Sleep for `seconds`, durably on the platform (a DATETIME waitpoint). */
  sleep(key: string, seconds: number): Promise<void>;
  /** Sleep until an absolute instant, durably on the platform. */
  sleepUntil(key: string, date: Date | string): Promise<void>;
  /**
   * Wait for an externally-completed token (a TOKEN waitpoint). Resolves to the
   * token's completion `{ payload }`, or `{ timedOut: true }` if it timed out.
   */
  waitForToken<T = unknown>(key: string, opts?: { timeoutSeconds?: number }): Promise<{ payload?: T } | { timedOut: true }>;
}

// ─── One-time local-dev durability note ──────────────────────────────────────

let localDurableNoticeShown = false;
function noteLocalDurable(): void {
  if (localDurableNoticeShown) return;
  localDurableNoticeShown = true;
  console.warn(
    '[vura] step.*: durable waits (sleep/waitForTask/waitForToken) resolve ' +
      'best-effort in-process without the platform. Deploy on Vura for durable ' +
      'suspend/resume across restarts.',
  );
}

/** Test-only reset of the one-time local-dev notice flag. */
export function _resetLocalDurableNotice(): void {
  localDurableNoticeShown = false;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, Math.max(0, ms));
    if (typeof t.unref === 'function') t.unref();
  });
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Build a {@link TaskStep} bound to one handler pass.
 *
 * `completed`/`newSteps` are shared across a run's internal retry passes so a
 * mid-handler failure does not redo already-completed steps; the duplicate-key
 * guard (`seen`) is per-pass so a replay of the same key is fine but two calls
 * with the same key in one linear pass throw.
 */
export function createTaskStep(ctx: StepFactoryContext): TaskStep {
  const seen = new Set<string>();

  function markSeen(key: string): void {
    if (seen.has(key)) throw new DuplicateStepKeyError(key);
    seen.add(key);
  }

  function lookup(key: string): { found: boolean; output?: unknown } {
    const local = ctx.newSteps[key];
    if (local) return { found: true, output: local.output };
    const persisted = ctx.completed[key];
    if (persisted) {
      if (persisted.status === 'timed_out') {
        return { found: true, output: persisted.output ?? { timedOut: true } };
      }
      return { found: true, output: persisted.output };
    }
    return { found: false };
  }

  function record(key: string, output: unknown): void {
    ctx.newSteps[key] = { status: 'completed', output };
  }

  return {
    async run<T>(key: string, fn: () => T | Promise<T>): Promise<T> {
      markSeen(key);
      const hit = lookup(key);
      if (hit.found) return hit.output as T;
      const output = await fn();
      record(key, output);
      return output;
    },

    async enqueue(key, task, payload, opts) {
      markSeen(key);
      const hit = lookup(key);
      if (hit.found) return hit.output as { runId?: string };
      const res = await ctx.enqueueFn(task, payload, opts);
      const out = { runId: res.runId };
      record(key, out);
      return out;
    },

    async waitForTask(key, task, payload, opts) {
      markSeen(key);
      const hit = lookup(key);
      if (hit.found) return hit.output as ChildRunResult;
      if (!ctx.hasPlatform) {
        noteLocalDurable();
        let out: ChildRunResult;
        if (ctx.localChildDispatch) {
          out = await ctx.localChildDispatch(task, payload);
        } else {
          // No in-process resolver: fire the child best-effort and continue.
          await ctx.enqueueFn(task, payload, opts).catch(() => undefined);
          out = { ok: true };
        }
        record(key, out);
        return out;
      }
      // Platform enqueues + links the child — never enqueue framework-side here,
      // or a replay would double-enqueue.
      throw new SuspendSignal(key, { kind: 'RUN', child: { task, payload } });
    },

    async sleep(key, seconds) {
      markSeen(key);
      if (lookup(key).found) return;
      if (!ctx.hasPlatform) {
        noteLocalDurable();
        await delay(seconds * 1000);
        record(key, null);
        return;
      }
      throw new SuspendSignal(key, {
        kind: 'DATETIME',
        wakeAt: new Date(Date.now() + seconds * 1000).toISOString(),
      });
    },

    async sleepUntil(key, date) {
      markSeen(key);
      if (lookup(key).found) return;
      const wakeAtMs = date instanceof Date ? date.getTime() : Date.parse(date);
      if (Number.isNaN(wakeAtMs)) {
        throw new Error(`step.sleepUntil("${key}"): invalid date "${String(date)}"`);
      }
      if (!ctx.hasPlatform) {
        noteLocalDurable();
        await delay(wakeAtMs - Date.now());
        record(key, null);
        return;
      }
      throw new SuspendSignal(key, { kind: 'DATETIME', wakeAt: new Date(wakeAtMs).toISOString() });
    },

    async waitForToken<T = unknown>(
      key: string,
      opts?: { timeoutSeconds?: number },
    ): Promise<{ payload?: T } | { timedOut: true }> {
      markSeen(key);
      const hit = lookup(key);
      if (hit.found) return hit.output as { payload?: T } | { timedOut: true };
      if (!ctx.hasPlatform) {
        noteLocalDurable();
        // Bounded local wait, capped at 60s, then a definite timeout.
        const secs = Math.min(opts?.timeoutSeconds ?? 60, 60);
        await delay(secs * 1000);
        const out = { timedOut: true as const };
        record(key, out);
        return out;
      }
      throw new SuspendSignal(key, { kind: 'TOKEN', timeoutSeconds: opts?.timeoutSeconds });
    },
  };
}
