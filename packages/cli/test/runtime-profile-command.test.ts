import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { routesCommand } from '../src/commands/routes.js';
import { runtimeCommand } from '../src/commands/runtime.js';

let fixtureRoot: string;
let previousExitCode: number | undefined;

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
  fixtureRoot = mkdtempSync(join(tmpdir(), 'vura-runtime-profile-'));
  mkdirSync(join(fixtureRoot, 'src', 'api', 'tasks'), { recursive: true });
  mkdirSync(join(fixtureRoot, 'src', 'pages'), { recursive: true });
  writeFileSync(join(fixtureRoot, 'package.json'), JSON.stringify({ type: 'module' }) + '\n');

  writeFileSync(
    join(fixtureRoot, 'src', 'pages', 'index.tsx'),
    `export const page = { mode: 'static', title: 'Home' };
export default function Home() { return null; }
`,
  );
  writeFileSync(
    join(fixtureRoot, 'src', 'pages', 'dashboard.tsx'),
    `export const page = { mode: 'client', title: 'Dashboard' };
export default function Dashboard() { return null; }
`,
  );
  writeFileSync(
    join(fixtureRoot, 'src', 'pages', 'admin.tsx'),
    `export const page = { mode: 'server', title: 'Admin' };
export default function Admin() { return null; }
`,
  );

  writeFileSync(
    join(fixtureRoot, 'src', 'api', 'hello.ts'),
    `export const route = { kind: 'serverless' };
export function GET() { return new Response('ok'); }
`,
  );
  writeFileSync(
    join(fixtureRoot, 'src', 'api', 'ws.ts'),
    `export const route = { kind: 'hot' };
export function GET() { return new Response('ok'); }
export function websocket() {}
`,
  );
  writeFileSync(
    join(fixtureRoot, 'src', 'api', 'tasks', 'send.ts'),
    `export const route = { kind: 'task', retries: 2, timeout: 30000 };
export function POST() { return Response.json({ ok: true }); }
`,
  );
  writeFileSync(
    join(fixtureRoot, 'src', 'api', 'tasks', 'nightly.ts'),
    `export const route = { kind: 'task', schedule: '17 2 * * *', retries: 3, timeout: 120000 };
export function POST() { return Response.json({ ok: true }); }
`,
  );

  previousExitCode = process.exitCode as number | undefined;
  process.exitCode = undefined;
});

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
  process.exitCode = previousExitCode;
});

describe('vura routes inspect', () => {
  it('prints agent-readable runtime placement JSON', async () => {
    const out = await captureStdout(() => routesCommand(['inspect', '--json'], fixtureRoot));
    const parsed = JSON.parse(out);

    expect(parsed.totals).toMatchObject({
      static: 2,
      cold: 1,
      hot: 2,
      'task-cold': 2,
      'cron-cold': 1,
    });

    expect(parsed.routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pattern: '/api/hello', effectiveProfile: 'cold', sourceIntent: 'kind:serverless' }),
        expect.objectContaining({ pattern: '/api/ws', effectiveProfile: 'hot', hasWebsocket: true }),
        expect.objectContaining({ pattern: '/api/tasks/send', effectiveProfile: 'task-cold' }),
        expect.objectContaining({
          pattern: '/api/tasks/send',
          effectiveProfile: 'task-cold',
          nextCommand: 'vura tasks run tasks.send',
        }),
        expect.objectContaining({
          pattern: '/api/tasks/nightly',
          effectiveProfile: 'cron-cold',
          schedule: '17 2 * * *',
          nextCommand: 'vura tasks list',
        }),
        expect.objectContaining({ pattern: '/admin', effectiveProfile: 'hot', sourceIntent: 'mode:server' }),
      ]),
    );
    expect(process.exitCode).toBeUndefined();
  }, 15000);

  it('prints usage and sets exitCode for unknown subcommands', async () => {
    const err = await captureStderr(() => routesCommand(['promote'], fixtureRoot));
    expect(err).toContain('vura routes inspect');
    expect(process.exitCode).toBe(1);
  }, 15000);
});

describe('vura runtime advise', () => {
  it('returns deterministic runtime advice without mutating infrastructure', async () => {
    const out = await captureStdout(() => runtimeCommand(['advise', '--json'], fixtureRoot));
    const parsed = JSON.parse(out);

    expect(parsed.advice).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pattern: '/admin', recommendation: 'hot', severity: 'info' }),
        expect.objectContaining({ pattern: '/api/ws', recommendation: 'hot', severity: 'info' }),
        expect.objectContaining({
          pattern: '/api/tasks/send',
          recommendation: 'task-cold',
          severity: 'info',
          nextCommand: 'vura tasks run tasks.send',
        }),
        expect.objectContaining({
          pattern: '/api/tasks/nightly',
          recommendation: 'cron-cold',
          severity: 'info',
          nextCommand: 'vura tasks list',
        }),
        expect.objectContaining({ pattern: '/api/tasks/nightly', recommendation: 'task-hot', severity: 'warn' }),
      ]),
    );
    expect(JSON.stringify(parsed)).not.toContain('tasks inspect');
    expect(JSON.stringify(parsed)).not.toContain('routes promote');
    expect(process.exitCode).toBeUndefined();
  }, 15000);

  it('prints usage and sets exitCode for unknown subcommands', async () => {
    const err = await captureStderr(() => runtimeCommand(['mutate'], fixtureRoot));
    expect(err).toContain('vura runtime advise');
    expect(process.exitCode).toBe(1);
  }, 15000);
});
