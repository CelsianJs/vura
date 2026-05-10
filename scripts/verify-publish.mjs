#!/usr/bin/env node
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const packages = [
  'packages/core',
  'packages/compiler',
  'packages/cli',
  'packages/create-then',
  'packages/adapter-cloudflare',
  'packages/adapter-lambda',
  'packages/adapter-vura',
  'packages/vite-plugin',
];

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { cwd: opts.cwd ?? root, encoding: 'utf8', stdio: opts.stdio ?? 'pipe' });
  if (res.status !== 0) {
    const details = [res.stdout, res.stderr].filter(Boolean).join('\n');
    throw new Error(`${cmd} ${args.join(' ')} failed with ${res.status}\n${details}`);
  }
  return res;
}

function npmPack(pkg, outDir) {
  const res = run('npm', ['pack', '--pack-destination', outDir], { cwd: join(root, pkg) });
  const file = res.stdout.trim().split(/\r?\n/).filter(Boolean).pop();
  if (!file) throw new Error(`npm pack did not report a tarball for ${pkg}`);
  return join(outDir, file);
}

const tmp = await mkdtemp(join(tmpdir(), 'vura-publish-verify-'));
try {
  const tarballs = [];
  for (const pkg of packages) {
    const packageJson = JSON.parse(await readFile(join(root, pkg, 'package.json'), 'utf8'));
    if (packageJson.private) continue;
    const tarball = npmPack(pkg, tmp);
    const packed = run('tar', ['-xOf', tarball, 'package/package.json']).stdout;
    if (packed.includes('workspace:')) {
      throw new Error(`${packageJson.name} packed package.json still contains workspace: references`);
    }
    tarballs.push(tarball);
  }

  const smoke = join(tmp, 'smoke');
  run('mkdir', ['-p', smoke]);
  await readFile(join(root, 'package.json'), 'utf8');
  run('npm', ['init', '-y'], { cwd: smoke });
  run('npm', ['install', '--ignore-scripts', ...tarballs], { cwd: smoke, stdio: 'pipe' });

  const check = `
    import('@then/core').then(() => import('@then/compiler')).then(() => import('@then/adapter-cloudflare')).then(() => import('@then/adapter-lambda')).then(() => import('@then/adapter-vura')).then(() => import('@then/vite-plugin')).then(() => console.log('VURA_PUBLISH_VERIFY_OK'));
  `;
  const node = run(process.execPath, ['--input-type=module', '-e', check], { cwd: smoke });
  if (!node.stdout.includes('VURA_PUBLISH_VERIFY_OK')) throw new Error('publish smoke import did not complete');
  if (existsSync(join(root, 'packages/compiler-native/package.json'))) {
    const nativeJson = JSON.parse(await readFile(join(root, 'packages/compiler-native/package.json'), 'utf8'));
    if (!nativeJson.private) throw new Error('@then/compiler-native must remain private until native artifacts exist');
  }
  console.log(`OK: verified ${tarballs.length} tarball(s); no workspace refs; clean npm install/import passed`);
} finally {
  await rm(tmp, { recursive: true, force: true });
}
