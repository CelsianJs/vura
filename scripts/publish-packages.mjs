#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { publishPackages } from './package-list.mjs';

const root = process.cwd();

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd ?? root,
    encoding: 'utf8',
    stdio: opts.stdio ?? 'inherit',
    env: process.env,
  });
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed with ${res.status}`);
  }
}

for (const pkg of publishPackages) {
  const packageJson = JSON.parse(await readFile(join(root, pkg, 'package.json'), 'utf8'));
  if (packageJson.private) continue;
  console.log(`Publishing ${packageJson.name} from ${pkg}`);
  const args = ['publish', '--access', 'public'];
  if (process.env.GITHUB_ACTIONS === 'true') args.push('--provenance');
  run('npm', args, { cwd: join(root, pkg) });
}
