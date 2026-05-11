import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const scriptPath = resolve('scripts/assert-clean-release-tree.mjs');

async function git(cwd, args) {
  return execFileAsync('git', args, { cwd });
}

async function makeRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'vura-clean-tree-'));
  await git(dir, ['init']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'Test User']);
  await writeFile(join(dir, 'README.md'), '# temp\n');
  await git(dir, ['add', 'README.md']);
  await git(dir, ['commit', '-m', 'init']);
  return dir;
}

describe('assert-clean-release-tree', () => {
  it('passes for a committed clean git tree', async () => {
    const repo = await makeRepo();
    const result = await execFileAsync(process.execPath, [scriptPath], { cwd: repo });
    expect(result.stdout).toContain('OK: release tree is clean');
  });

  it('fails when untracked files are present', async () => {
    const repo = await makeRepo();
    await writeFile(join(repo, 'UNTRACKED.md'), 'do not publish me\n');
    await expect(execFileAsync(process.execPath, [scriptPath], { cwd: repo })).rejects.toMatchObject({
      stderr: expect.stringContaining('Release tree must be clean before publish'),
    });
  });
});
