/**
 * Vura task enqueue client — `enqueue(taskName, payload?, opts?)`.
 *
 * Fire-and-forget dispatch of a task by its dot-form name (`tasks.cleanup`).
 * Two modes, selected by environment:
 *
 *   1. Platform mode — when both VURA_TASK_ENQUEUE_URL and VURA_TASK_ENQUEUE_TOKEN
 *      are set (the platform injects these into deployed apps). POSTs the job to
 *      the platform's durable enqueue broker and returns its `{ runId, status }`
 *      response verbatim (unknown fields tolerated).
 *
 *   2. Local fallback — no platform env. POSTs directly to the app's own
 *      `/__tasks/<name>` run endpoint over HTTP, authorised with THEN_TASK_SECRET
 *      (or plain localhost in dev/test, mirroring isTaskAdminAuthorized). This has
 *      NO durable queue: `delaySeconds` is a best-effort setTimeout and is logged
 *      once as a reminder that durable scheduling requires the platform.
 *
 * Errors are never swallowed: a non-2xx response or a network failure throws an
 * HttpError so the caller can react.
 */

import { HttpError, ErrorCode } from './errors.js';

// ─── Types ───

export interface EnqueueOptions {
  /** Delay before the task should run, in seconds. Durable only on the platform. */
  delaySeconds?: number;
  /** Caller-supplied key for de-duplicating enqueues. Honoured by the platform. */
  idempotencyKey?: string;
}

/**
 * The enqueue broker's response. `runId`/`status` are the documented shape;
 * unknown fields are preserved so future broker fields flow through untouched.
 */
export interface EnqueueResult {
  runId?: string;
  status?: string;
  [key: string]: unknown;
}

// ─── One-time local-fallback delay notice ───

let localDelayNoticeShown = false;
function noteLocalDelay(): void {
  if (localDelayNoticeShown) return;
  localDelayNoticeShown = true;
  console.warn(
    '[vura] enqueue(): delaySeconds is a best-effort local timer without the ' +
      'platform. Deploy on Vura for durable, at-least-once scheduled delivery.',
  );
}

// ─── Public API ───

/**
 * Enqueue a task for asynchronous execution.
 *
 * @param taskName  Dot-form task name, e.g. `tasks.cleanup` (matches the
 *                  framework's task-name derivation).
 * @param payload   Optional JSON-serialisable payload passed to the task handler
 *                  as its `input`.
 * @param opts      `{ delaySeconds?, idempotencyKey? }`.
 * @returns         The broker/run response (`{ runId, status }` shape).
 * @throws HttpError on a non-2xx response or a network/transport failure.
 */
export async function enqueue(
  taskName: string,
  payload?: unknown,
  opts: EnqueueOptions = {},
): Promise<EnqueueResult> {
  const url = (process.env.VURA_TASK_ENQUEUE_URL ?? '').trim();
  const token = (process.env.VURA_TASK_ENQUEUE_TOKEN ?? '').trim();

  if (url && token) {
    return enqueueViaPlatform(url, token, taskName, payload, opts);
  }
  return enqueueLocalFallback(taskName, payload, opts);
}

// ─── Platform broker path ───

async function enqueueViaPlatform(
  url: string,
  token: string,
  taskName: string,
  payload: unknown,
  opts: EnqueueOptions,
): Promise<EnqueueResult> {
  const body: Record<string, unknown> = { task: taskName, payload };
  if (opts.delaySeconds !== undefined) body.delaySeconds = opts.delaySeconds;
  if (opts.idempotencyKey !== undefined) body.idempotencyKey = opts.idempotencyKey;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new HttpError(
      502,
      ErrorCode.BAD_GATEWAY,
      `enqueue(${taskName}) failed to reach the enqueue broker: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return parseEnqueueResponse(res, taskName);
}

// ─── Local (no-platform) fallback path ───

async function enqueueLocalFallback(
  taskName: string,
  payload: unknown,
  opts: EnqueueOptions,
): Promise<EnqueueResult> {
  const delayMs = Math.max(0, (opts.delaySeconds ?? 0) * 1000);

  if (delayMs > 0) {
    // Best-effort local delay: schedule the dispatch and return immediately.
    noteLocalDelay();
    const timer = setTimeout(() => {
      dispatchLocal(taskName, payload).catch((err: unknown) => {
        console.error(
          `[vura] enqueue(${taskName}) delayed dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, delayMs);
    if (typeof timer.unref === 'function') timer.unref();
    return { status: 'scheduled' };
  }

  return dispatchLocal(taskName, payload);
}

/**
 * POST the payload to the local server's /__tasks/<name> run endpoint.
 * Uses THEN_TASK_SECRET as a bearer when set; otherwise relies on the
 * loopback-in-dev allowance in isTaskAdminAuthorized.
 */
async function dispatchLocal(taskName: string, payload: unknown): Promise<EnqueueResult> {
  const base = localTaskBaseUrl();
  const target = `${base.replace(/\/$/, '')}/__tasks/${taskName}`;
  const secret = (process.env.THEN_TASK_SECRET ?? '').trim();

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (secret) headers.authorization = `Bearer ${secret}`;

  let res: Response;
  try {
    res = await fetch(target, {
      method: 'POST',
      headers,
      // The standalone server treats the whole body as the task `input`.
      body: JSON.stringify(payload ?? null),
    });
  } catch (err) {
    throw new HttpError(
      502,
      ErrorCode.BAD_GATEWAY,
      `enqueue(${taskName}) failed to reach the local task endpoint at ${target}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return parseEnqueueResponse(res, taskName);
}

/** Resolve the base URL of the local app for the enqueue fallback. */
function localTaskBaseUrl(): string {
  const override = (process.env.VURA_LOCAL_TASK_URL ?? '').trim();
  if (override) return override;
  const port = (process.env.PORT ?? '').trim() || '3000';
  return `http://127.0.0.1:${port}`;
}

// ─── Shared response handling ───

async function parseEnqueueResponse(res: Response, taskName: string): Promise<EnqueueResult> {
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
  }

  if (!res.ok) {
    const detail =
      parsed && typeof parsed === 'object' && 'error' in (parsed as Record<string, unknown>)
        ? String((parsed as Record<string, unknown>).error)
        : text || res.statusText;
    throw new HttpError(
      res.status,
      ErrorCode.BAD_GATEWAY,
      `enqueue(${taskName}) rejected with ${res.status}: ${detail}`,
      parsed,
    );
  }

  if (parsed && typeof parsed === 'object') {
    // Normalise the local endpoint's { id } to { runId } while preserving all fields.
    const obj = parsed as Record<string, unknown>;
    if (obj.runId === undefined && typeof obj.id === 'string') {
      return { ...obj, runId: obj.id } as EnqueueResult;
    }
    return obj as EnqueueResult;
  }
  return {};
}
