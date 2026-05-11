#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const pnpmExecPath = process.env.npm_execpath?.includes('pnpm') ? process.env.npm_execpath : null;

function pnpmStep(args) {
  return pnpmExecPath ? [process.execPath, [pnpmExecPath, ...args]] : ['pnpm', args];
}

const steps = [
  pnpmStep(['run', 'assert:release-private']),
  pnpmStep(['run', 'lint']),
  pnpmStep(['run', 'build']),
  pnpmStep(['run', 'test']),
  pnpmStep(['audit', '--prod']),
  pnpmStep(['run', 'verify:publish']),
  ['node', ['scripts/publish-packages.mjs', '--dry-run'], { env: { VURA_PUBLISH_DRY_RUN: '1' } }],
  ['git', ['diff', '--check']],
];

function runStep(cmd, args, opts = {}) {
  const printable = [cmd, ...args].join(' ');
  console.log(`\n==> ${printable}`);
  const res = spawnSync(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...(opts.env ?? {}) },
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`${printable} failed with exit code ${res.status}`);
  }
}

for (const [cmd, args, opts] of steps) {
  runStep(cmd, args, opts);
}

console.log('\nOK: release check passed');
