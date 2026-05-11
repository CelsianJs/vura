#!/usr/bin/env node
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { publishPackages } from './package-list.mjs';

const root = process.cwd();

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { cwd: opts.cwd ?? root, encoding: 'utf8', stdio: opts.stdio ?? 'pipe' });
  if (res.status !== 0) {
    const details = [res.stdout, res.stderr].filter(Boolean).join('\n');
    throw new Error(`${cmd} ${args.join(' ')} failed with ${res.status}\n${details}`);
  }
  return res;
}

const cliBins = ['vura', 'thenjs', 'then'];
const smokeCliCommands = ['vura', 'thenjs', 'create-then', 'then'];

function installedBinPath(cwd, bin) {
  return join(cwd, 'node_modules', '.bin', bin);
}

function assertInstalledBins(cwd) {
  for (const bin of [...cliBins, 'create-then']) {
    const binPath = installedBinPath(cwd, bin);
    if (!existsSync(binPath)) {
      throw new Error(`Expected installed CLI bin at ${binPath}`);
    }
    realpathSync(binPath);
  }
}

function assertHelpOutput(bin, res) {
  const output = `${res.stdout}
${res.stderr}`;
  if (!output.includes('Usage:') && !output.includes('Commands:')) {
    throw new Error(`${bin} --help did not print expected help text; stdout=${JSON.stringify(res.stdout)} stderr=${JSON.stringify(res.stderr)}`);
  }
}

function runInstalledBinHelp(cwd, bin) {
  // Execute the installed JS entrypoint directly instead of routing through
  // npx/npm exec. The legacy `then` bin is a shell reserved word, so this
  // keeps smoke checks independent of shell command parsing.
  return run(process.execPath, [realpathSync(installedBinPath(cwd, bin)), '--help'], { cwd });
}

function assertHelpCommands(cwd) {
  for (const bin of smokeCliCommands) {
    assertHelpOutput(bin, runInstalledBinHelp(cwd, bin));
  }
}

function pnpmPack(pkg, outDir) {
  const res = run('pnpm', ['pack', '--pack-destination', outDir], { cwd: join(root, pkg) });
  const file = res.stdout.trim().split(/\r?\n/).filter(Boolean).pop();
  if (!file) throw new Error(`pnpm pack did not report a tarball for ${pkg}`);
  return isAbsolute(file) ? file : join(outDir, file);
}

const tmp = await mkdtemp(join(tmpdir(), 'vura-publish-verify-'));
try {
  const tarballs = [];
  for (const pkg of publishPackages) {
    const packageJson = JSON.parse(await readFile(join(root, pkg, 'package.json'), 'utf8'));
    if (packageJson.private) continue;
    const tarball = pnpmPack(pkg, tmp);
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

  assertInstalledBins(smoke);
  assertHelpCommands(smoke);

  const check = `
    import('@then/core').then(() => import('@then/compiler')).then(() => import('@then/adapter-cloudflare')).then(() => import('@then/adapter-lambda')).then(() => import('@then/vite-plugin')).then(() => console.log('VURA_PUBLISH_VERIFY_OK'));
  `;
  const node = run(process.execPath, ['--input-type=module', '-e', check], { cwd: smoke });
  if (!node.stdout.includes('VURA_PUBLISH_VERIFY_OK')) throw new Error('publish smoke import did not complete');

  // create-then scaffold smoke: validates the user-facing create command can run
  // from packed artifacts and emits package dependencies matching this release.

  const createThenBin = realpathSync(join(smoke, 'node_modules/create-then/dist/index.js'));
  const scaffold = run(process.execPath, [createThenBin, 'smoke-app', '--dry-run'], { cwd: smoke });
  if (!scaffold.stdout.includes('package.json')) {
    throw new Error(`create-then scaffold smoke did not list generated package.json; stdout=${JSON.stringify(scaffold.stdout)} stderr=${JSON.stringify(scaffold.stderr)}`);
  }

  const { getFiles } = await import(join(smoke, 'node_modules/create-then/dist/index.js'));
  const scaffoldPackage = JSON.parse(getFiles('smoke-app')['package.json']);
  if (scaffoldPackage.dependencies['@then/core'] !== '0.1.0' || scaffoldPackage.dependencies['@then/cli'] !== '0.1.0') {
    throw new Error('create-then scaffold dependencies are not aligned with the current publish version');
  }

  if (existsSync(join(root, 'packages/compiler-native/package.json'))) {
    const nativeJson = JSON.parse(await readFile(join(root, 'packages/compiler-native/package.json'), 'utf8'));
    if (!nativeJson.private) throw new Error('@then/compiler-native must remain private until native artifacts exist');
  }
  console.log(`OK: verified ${tarballs.length} tarball(s); no workspace refs; installed CLI bins/direct help; clean npm install/import and create-then scaffold smoke passed`);
} finally {
  await rm(tmp, { recursive: true, force: true });
}
