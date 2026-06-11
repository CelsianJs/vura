/**
 * Tests for `vura tasks list` and `vura tasks run <name>`.
 *
 * Fixture: a tmp directory containing two task routes —
 *   src/api/report.ts   — no schedule, retries:0, timeout:5000
 *   src/api/digest.ts   — with schedule '0 * * * *'
 *
 * Exit-code seam: tasksCommand sets process.exitCode (not process.exit) so
 * vitest keeps running. Each test that expects a failure asserts process.exitCode
 * and resets it in afterEach.
 *
 * NOTE: tests pass fixtureRoot explicitly to tasksCommand rather than using
 * process.chdir() — chdir is process-global and causes races when vitest runs
 * multiple test files in the same process via worker_threads.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tasksCommand, taskNameFromPattern } from '../src/commands/tasks.js';

// ─── Fixture setup ───────────────────────────────────────────────────────────

let fixtureRoot: string;
let previousExitCode: number | undefined;

/** Capture stdout lines printed by a command invocation. */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return lines.join('\n');
}

/** Capture stderr lines printed by a command invocation. */
async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.join(' ')); };
  try {
    await fn();
  } finally {
    console.error = orig;
  }
  return lines.join('\n');
}

beforeEach(() => {
  // Create a fresh fixture project
  fixtureRoot = mkdtempSync(join(tmpdir(), 'vura-tasks-cmd-'));
  mkdirSync(join(fixtureRoot, 'src', 'api'), { recursive: true });
  writeFileSync(join(fixtureRoot, 'package.json'), JSON.stringify({ type: 'module' }) + '\n');

  // Task 1: report — no schedule, retries:0, timeout:5000
  writeFileSync(
    join(fixtureRoot, 'src', 'api', 'report.ts'),
    `export const route = { kind: 'task', retries: 0, timeout: 5000 };
export async function POST(job) {
  return { ran: true, input: job.input };
}
`,
  );

  // Task 2: digest — has a cron schedule
  writeFileSync(
    join(fixtureRoot, 'src', 'api', 'digest.ts'),
    `export const route = { kind: 'task', retries: 1, timeout: 10000 };
export const schedule = '0 * * * *';
export async function POST(job) {
  return { digest: true };
}
`,
  );

  // Save and reset process.exitCode before each test
  previousExitCode = process.exitCode as number | undefined;
  process.exitCode = undefined;
});

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
  process.exitCode = previousExitCode;
});

// ─── taskNameFromPattern unit tests ──────────────────────────────────────────

describe('taskNameFromPattern', () => {
  it('strips /api/ prefix and converts slashes to dots', () => {
    expect(taskNameFromPattern('/api/report')).toBe('report');
    expect(taskNameFromPattern('/api/jobs/notify')).toBe('jobs.notify');
    expect(taskNameFromPattern('/api/a/b/c')).toBe('a.b.c');
  });
});

// ─── vura tasks list ─────────────────────────────────────────────────────────

describe('vura tasks list', () => {
  it('prints task names', async () => {
    const out = await captureStdout(() => tasksCommand(['list'], fixtureRoot));
    expect(out).toContain('report');
    expect(out).toContain('digest');
    expect(process.exitCode).toBeUndefined();
  }, 15000);

  it('prints the cron schedule for scheduled tasks', async () => {
    const out = await captureStdout(() => tasksCommand(['list'], fixtureRoot));
    expect(out).toMatch(/digest.*cron: 0 \* \* \* \*/);
  }, 15000);

  it('does not print a cron suffix for unscheduled tasks', async () => {
    const out = await captureStdout(() => tasksCommand(['list'], fixtureRoot));
    // "report" line should not contain "(cron:"
    const reportLine = out.split('\n').find((l) => l.includes('report') && !l.includes('digest'));
    expect(reportLine).toBeDefined();
    expect(reportLine).not.toContain('cron:');
  }, 15000);
});

// ─── vura tasks run ──────────────────────────────────────────────────────────

describe('vura tasks run <name> --input', () => {
  it('runs a task and prints completed status with handler result', async () => {
    const out = await captureStdout(() =>
      tasksCommand(['run', 'report', '--input', '{"day":"mon"}'], fixtureRoot),
    );
    const parsed = JSON.parse(out.trim());
    expect(parsed.status).toBe('completed');
    expect(parsed.result).toMatchObject({ ran: true, input: { day: 'mon' } });
    expect(process.exitCode).toBeUndefined();
  }, 15000);

  it('echoes back the parsed input in the result', async () => {
    const out = await captureStdout(() =>
      tasksCommand(['run', 'report', '--input', '{"x":42}'], fixtureRoot),
    );
    const parsed = JSON.parse(out.trim());
    expect(parsed.result.input).toEqual({ x: 42 });
  }, 15000);

  it('runs a task without --input (input is undefined)', async () => {
    const out = await captureStdout(() => tasksCommand(['run', 'report'], fixtureRoot));
    const parsed = JSON.parse(out.trim());
    expect(parsed.status).toBe('completed');
    expect(parsed.result.ran).toBe(true);
  }, 15000);
});

// ─── Unknown task ────────────────────────────────────────────────────────────

describe('vura tasks run <unknown>', () => {
  it('prints an error and exits with code 1 for an unknown task name', async () => {
    const err = await captureStderr(() => tasksCommand(['run', 'nope'], fixtureRoot));
    expect(err).toContain('Unknown task');
    expect(err).toContain('report');   // available names listed
    expect(err).toContain('digest');
    expect(process.exitCode).toBe(1);
  }, 15000);
});

// ─── Failed task ─────────────────────────────────────────────────────────────

describe('vura tasks run — failed task', () => {
  it('prints the result with status failed and sets exitCode 1', async () => {
    // Write a task whose handler always throws
    writeFileSync(
      join(fixtureRoot, 'src', 'api', 'broken.ts'),
      `export const route = { kind: 'task', retries: 0, timeout: 5000 };
export async function POST(_job) {
  throw new Error('boom');
}
`,
    );

    const out = await captureStdout(() => tasksCommand(['run', 'broken'], fixtureRoot));
    const parsed = JSON.parse(out.trim());
    expect(parsed.status).toBe('failed');
    expect(parsed.error).toContain('boom');
    expect(process.exitCode).toBe(1);
  }, 15000);
});

// ─── Bad --input JSON ────────────────────────────────────────────────────────

describe('vura tasks run — malformed --input', () => {
  it('prints a clear error and sets exitCode 1 instead of a stack trace', async () => {
    const err = await captureStderr(() =>
      tasksCommand(['run', 'report', '--input', 'not-json{{'], fixtureRoot),
    );
    expect(err).toContain('Invalid JSON');
    expect(process.exitCode).toBe(1);
  }, 15000);

  it('errors clearly when --input is given without a value', async () => {
    const err = await captureStderr(() =>
      tasksCommand(['run', 'report', '--input'], fixtureRoot),
    );
    expect(err).toContain('--input requires a JSON value');
    expect(process.exitCode).toBe(1);
  }, 15000);
});

// ─── Unknown subcommand ──────────────────────────────────────────────────────

describe('vura tasks <unknown-subcommand>', () => {
  it('prints usage and sets exitCode 1', async () => {
    const err = await captureStderr(() => tasksCommand(['bogus'], fixtureRoot));
    expect(err).toContain('Unknown subcommand');
    expect(err).toContain('vura tasks list');
    expect(err).toContain('vura tasks run');
    expect(process.exitCode).toBe(1);
  }, 15000);

  it('prints usage when no subcommand is given', async () => {
    const err = await captureStderr(() => tasksCommand([], fixtureRoot));
    expect(err).toContain('Unknown subcommand');
    expect(process.exitCode).toBe(1);
  }, 15000);
});
