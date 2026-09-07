import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const scriptPath = join(root, 'scripts/release-check.mjs');
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'vura-release-check-'));
  temporaryDirectories.push(dir);
  const bin = join(dir, 'bin');
  await mkdir(bin);
  const callsPath = join(dir, 'calls.jsonl');
  const preamble = `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ tool: process.argv[1].split('/').pop(), args, env: { VURA_PUBLISH_DRY_RUN: process.env.VURA_PUBLISH_DRY_RUN } }) + '\\n');
`;
  await writeFile(join(bin, 'pnpm'), `${preamble}
if (${JSON.stringify(options.failTool ?? '')} === 'pnpm' && args.join(' ') === ${JSON.stringify(options.failArgs?.join(' ') ?? '')}) {
  console.error('simulated pnpm failure');
  process.exit(27);
}
process.exit(0);
`, { mode: 0o755 });
  await writeFile(join(bin, 'node'), `${preamble}
if (${JSON.stringify(options.failTool ?? '')} === 'node' && args.join(' ') === ${JSON.stringify(options.failArgs?.join(' ') ?? '')}) {
  console.error('simulated node failure');
  process.exit(28);
}
process.exit(0);
`, { mode: 0o755 });

  return {
    calls: async () => (await readFile(callsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)),
    run: () => execFileAsync(process.execPath, [scriptPath], {
      cwd: dir,
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
        npm_execpath: '',
      },
    }),
  };
}

describe('release-check gate fanout', () => {
  it('runs release gates in order and caps only the full test worker fanout', async () => {
    const f = await fixture();

    const result = await f.run();

    expect(result.stdout).toContain('OK: release check passed');
    expect(await f.calls()).toEqual([
      { tool: 'pnpm', args: ['run', 'assert:release-private'], env: {} },
      { tool: 'pnpm', args: ['run', 'lint'], env: {} },
      { tool: 'pnpm', args: ['run', 'build'], env: {} },
      { tool: 'pnpm', args: ['run', 'test', '--', '--maxWorkers=2'], env: {} },
      { tool: 'pnpm', args: ['run', 'audit'], env: {} },
      { tool: 'pnpm', args: ['run', 'verify:publish'], env: {} },
      { tool: 'pnpm', args: ['run', 'package:size'], env: {} },
      { tool: 'node', args: ['scripts/publish-packages.mjs', '--dry-run'], env: { VURA_PUBLISH_DRY_RUN: '1' } },
      { tool: 'node', args: ['scripts/assert-clean-release-tree.mjs'], env: {} },
    ]);
  });

  it('propagates a failing gate and does not run later gates', async () => {
    const f = await fixture({ failTool: 'pnpm', failArgs: ['run', 'test', '--', '--maxWorkers=2'] });

    await expect(f.run()).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('simulated pnpm failure'),
    });

    expect(await f.calls()).toEqual([
      { tool: 'pnpm', args: ['run', 'assert:release-private'], env: {} },
      { tool: 'pnpm', args: ['run', 'lint'], env: {} },
      { tool: 'pnpm', args: ['run', 'build'], env: {} },
      { tool: 'pnpm', args: ['run', 'test', '--', '--maxWorkers=2'], env: {} },
    ]);
  });
});
