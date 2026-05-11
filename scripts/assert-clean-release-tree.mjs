#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const root = process.cwd();

function runGit(args, opts = {}) {
  const res = spawnSync('git', args, {
    cwd: opts.cwd ?? root,
    encoding: 'utf8',
    stdio: opts.stdio ?? 'pipe',
  });
  if (res.error) throw res.error;
  return res;
}

const diffCheck = runGit(['diff', '--check'], { stdio: 'inherit' });
if (diffCheck.status !== 0) {
  throw new Error('git diff --check failed; fix whitespace errors before release');
}

const status = runGit(['status', '--porcelain=v1']);
if (status.status !== 0) {
  throw new Error(`git status failed with exit code ${status.status}\n${status.stderr || status.stdout}`);
}

const dirty = status.stdout.trim();
if (dirty) {
  throw new Error(`Release tree must be clean before publish. Commit, revert, or ignore these paths:\n${dirty}`);
}

console.log('OK: release tree is clean');
