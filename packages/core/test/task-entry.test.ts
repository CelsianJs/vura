/**
 * Integration test: the generated serverless task entry (dist/functions/task_*)
 * delegates to core runTaskOnce — the same executor as the hot server.
 *
 * Regression for the Phase-2 E2E prod bug where the WfP wrapper hand-rolled its
 * own executor: handlers got no `step`/`runId`/`steps` (crashing any step.*
 * task with "Cannot read properties of undefined"), input schemas were never
 * validated on serverless, and framework retries didn't run.
 *
 * Builds a real fixture project, then imports the esbuild-bundled index.js and
 * drives its Worker-style fetch() with platform-protocol Requests.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { build } from '../src/build.js';
import type { RouteManifest } from '../src/manifest.js';
import type { ThenConfig } from '../src/config.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

let projectRoot: string;
let entry: { fetch(request: Request): Promise<Response> };

function dispatchRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://tasks.test/api/tasks/flow', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  projectRoot = mkdtempSync(join(tmpdir(), 'vura-task-entry-'));
  const tasksDir = join(projectRoot, 'src', 'api', 'tasks');
  mkdirSync(tasksDir, { recursive: true });

  // A step-using task with an input schema. `prepCalls` proves step.run
  // memoization: a replay must NOT re-run the step body.
  writeFileSync(
    join(tasksDir, 'flow.ts'),
    `let prepCalls = 0;

export const input = {
  safeParse(value: any) {
    return value && typeof value.text === 'string'
      ? { success: true, data: value }
      : { success: false, error: { issues: [{ path: ['text'], message: 'Required', code: 'invalid_type' }] } };
  },
};

export const route = { kind: 'task', retries: 0, timeout: 5000 };

export async function POST(job: any) {
  const prep = await job.step.run('prep', () => ({ calls: ++prepCalls }));
  const gate = await job.step.waitForToken('gate', { timeoutSeconds: 60 });
  return { prep, gate, runId: job.runId, input: job.input };
}
`,
  );

  const manifest: RouteManifest = {
    api: [
      {
        filePath: 'src/api/tasks/flow.ts',
        urlPattern: '/api/tasks/flow',
        methods: ['POST'],
        kind: 'task',
        config: { retries: 0, timeout: 5000 },
      },
    ],
    pages: [],
    layouts: [],
    timestamp: new Date().toISOString(),
  };

  await build(manifest, {} as ThenConfig, projectRoot);

  const entryPath = join(projectRoot, 'dist', 'functions', 'task_api_tasks_flow', 'index.js');
  expect(existsSync(entryPath)).toBe(true);
  entry = (await import(pathToFileURL(entryPath).href)).default;
});

afterAll(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('generated task entry — run engine v2', () => {
  it('suspends on an unmemoized wait step and reports completed steps (dispatch v2)', async () => {
    const res = await entry.fetch(
      dispatchRequest(
        { taskId: 't-1', runId: 'run-1', input: { text: 'hi' }, attempt: 1, steps: {} },
        { 'x-vura-task-id': 't-1' },
      ),
    );
    expect(res.status).toBe(200);
    const envelope = await res.json();
    expect(envelope.ok).toBe(true);
    expect(envelope.taskName).toBe('tasks.flow');
    expect(envelope.suspended).toEqual({
      stepKey: 'gate',
      waitpoint: { kind: 'TOKEN', timeoutSeconds: 60 },
    });
    expect(envelope.steps.prep).toEqual({ status: 'completed', output: { calls: 1 } });
  });

  it('replays memoized steps on resume without re-running them, and threads runId', async () => {
    const res = await entry.fetch(
      dispatchRequest(
        {
          taskId: 't-1',
          runId: 'run-1',
          input: { text: 'hi' },
          attempt: 1,
          steps: {
            prep: { status: 'completed', output: { calls: 1 } },
            gate: { status: 'completed', output: { payload: { approved: true } } },
          },
        },
        { 'x-vura-task-id': 't-1' },
      ),
    );
    expect(res.status).toBe(200);
    const envelope = await res.json();
    expect(envelope.ok).toBe(true);
    expect(envelope.suspended).toBeUndefined();
    // prep replayed from the steps map — the step body did NOT run again.
    expect(envelope.result.prep).toEqual({ calls: 1 });
    expect(envelope.result.gate).toEqual({ payload: { approved: true } });
    expect(envelope.result.runId).toBe('run-1');
    expect(envelope.result.input).toEqual({ text: 'hi' });
    expect(Array.isArray(envelope.attempts)).toBe(true);
    expect(envelope.attempts.length).toBe(1);
  });

  it('rejects an invalid payload with 400 before any attempt (schema enforced on serverless)', async () => {
    const res = await entry.fetch(
      dispatchRequest(
        { taskId: 't-2', input: { wrong: true }, attempt: 1, steps: {} },
        { 'x-vura-task-id': 't-2' },
      ),
    );
    expect(res.status).toBe(400);
  });

  it('skips input validation on cron/synthetic dispatches (X-Vura-Cron)', async () => {
    const res = await entry.fetch(
      dispatchRequest(
        { taskId: 't-3', runId: 'run-3', input: { _cron: true }, attempt: 1, steps: { prep: { status: 'completed', output: { calls: 0 } }, gate: { status: 'completed', output: { payload: null } } } },
        { 'x-vura-task-id': 't-3', 'x-vura-cron': 'true' },
      ),
    );
    expect(res.status).toBe(200);
    const envelope = await res.json();
    expect(envelope.ok).toBe(true);
  });

  it('rejects non-POST with 405 and oversized bodies with 413', async () => {
    const res405 = await entry.fetch(new Request('https://tasks.test/api/tasks/flow', { method: 'GET' }));
    expect(res405.status).toBe(405);

    const big = JSON.stringify({ input: { text: 'x'.repeat(70 * 1024) } });
    const res413 = await entry.fetch(
      new Request('https://tasks.test/api/tasks/flow', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-vura-task-id': 't-4' },
        body: big,
      }),
    );
    expect(res413.status).toBe(413);
  });
});
