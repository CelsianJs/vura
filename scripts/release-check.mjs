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
  // The full release test gate builds many nested fixture apps and generated
  // server/function bundles. Two Vitest workers keep useful fanout while
  // avoiding the local oversubscription that makes fixture-level 15s tests
  // and 30s hooks race each other. The normal `pnpm test` script and Vitest
  // config stay unchanged for everyday development and matrix CI.
  // Re-measure this cap when the fixture topology changes; do not compensate
  // for excess process fanout by relaxing the test or hook deadlines.
  pnpmStep(['run', 'test', '--maxWorkers=2']),
  pnpmStep(['run', 'audit']),
  pnpmStep(['run', 'verify:publish']),
  pnpmStep(['run', 'package:size']),
  ['node', ['scripts/publish-packages.mjs', '--dry-run'], { env: { VURA_PUBLISH_DRY_RUN: '1' } }],
  ['node', ['scripts/assert-clean-release-tree.mjs']],
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
