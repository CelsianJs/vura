#!/usr/bin/env node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { publishPackages } from './package-list.mjs';

const root = process.cwd();
const limitsPath = join(root, 'scripts/package-size-limits.json');
const limits = JSON.parse(await readFile(limitsPath, 'utf8'));

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd ?? root,
    encoding: 'utf8',
    stdio: opts.stdio ?? 'pipe',
  });
  if (res.status !== 0) {
    const details = [res.stdout, res.stderr].filter(Boolean).join('\n');
    throw new Error(`${cmd} ${args.join(' ')} failed with ${res.status}${details ? `\n${details}` : ''}`);
  }
  return res;
}

function pnpmPack(pkg, outDir) {
  const res = run('pnpm', ['pack', '--pack-destination', outDir], { cwd: join(root, pkg) });
  const reported = res.stdout.trim().split(/\r?\n/).filter(Boolean).pop();
  if (!reported) throw new Error(`pnpm pack did not report a tarball for ${pkg}`);
  const tarball = isAbsolute(reported) ? reported : join(outDir, basename(reported));
  return { tarball, bytes: statSync(tarball).size };
}

const tmp = await mkdtemp(join(tmpdir(), 'vura-package-size-'));
try {
  const sizes = [];
  for (const pkg of publishPackages) {
    const packageJson = JSON.parse(await readFile(join(root, pkg, 'package.json'), 'utf8'));
    if (packageJson.private) continue;
    const limit = limits[packageJson.name];
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error(`${packageJson.name} is missing a positive packed-size limit in scripts/package-size-limits.json`);
    }
    const { bytes } = pnpmPack(pkg, tmp);
    if (bytes > limit) {
      throw new Error(`${packageJson.name} packed tarball is ${bytes} bytes, over limit ${limit} bytes`);
    }
    sizes.push({ name: packageJson.name, version: packageJson.version, packedBytes: bytes, limitBytes: limit });
  }

  await mkdir(join(root, 'artifacts'), { recursive: true });
  await writeFile(join(root, 'artifacts/package-sizes.json'), `${JSON.stringify(sizes, null, 2)}\n`);

  console.log('OK: package tarball sizes within tracked limits');
  for (const item of sizes) {
    console.log(`  - ${item.name}@${item.version}: ${item.packedBytes}/${item.limitBytes} bytes`);
  }
} finally {
  await rm(tmp, { recursive: true, force: true });
}
