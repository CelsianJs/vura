import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

async function makeFakeNpmBin() {
  const dir = await mkdtemp(join(tmpdir(), 'vura-fake-npm-'));
  const callsPath = join(dir, 'npm-calls.jsonl');
  const npmPath = join(dir, 'npm');
  await writeFile(npmPath, `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const callsPath = ${JSON.stringify(callsPath)};
const args = process.argv.slice(2);
appendFileSync(callsPath, JSON.stringify(args) + '\\n');
if (args[0] === 'whoami') {
  console.log('scope-tester');
  process.exit(0);
}
if (args.join(' ') === 'access list packages @celsian --json') {
  console.error('403 Forbidden - simulated @celsian scope denial');
  process.exit(1);
}
console.error('unexpected npm command: ' + args.join(' '));
process.exit(99);
`, { mode: 0o755 });
  return { dir, callsPath };
}

describe('publish-packages npm scope preflight', () => {
  it('uses the current npm access list packages command and fails before publish when scope access is denied', async () => {
    const fakeNpm = await makeFakeNpmBin();

    await expect(execFileAsync(process.execPath, ['scripts/publish-packages.mjs'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${fakeNpm.dir}${delimiter}${process.env.PATH ?? ''}`,
      },
    })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('does not have confirmed access to @celsian'),
    });

    const calls = (await readFile(fakeNpm.callsPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

    expect(calls).toEqual([
      ['whoami'],
      ['access', 'list', 'packages', '@celsian', '--json'],
    ]);
    // Generous, because this spawns a Node subprocess that itself spawns two
    // more, and it runs alongside the self-host audit's real `npm install` and
    // `vura build`. The work is well under a second when the machine is idle;
    // under that load it has been measured between 5s and past the old 30s
    // ceiling, which turned a passing assertion into a red CI run.
  }, 120_000);
});
