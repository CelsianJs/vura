#!/usr/bin/env node
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { publishPackages } from './package-list.mjs';

const root = process.cwd();
const versionOverride = process.env.VURA_REGISTRY_VERSION;
const tag = process.env.VURA_REGISTRY_TAG || 'latest';
const artifactPath = process.env.VURA_REGISTRY_SMOKE_ARTIFACT || 'artifacts/registry-smoke.json';

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

async function packageSpec(pkgDir) {
  const packageJson = JSON.parse(await readFile(join(root, pkgDir, 'package.json'), 'utf8'));
  if (packageJson.private) return null;
  const selector = versionOverride || packageJson.version;
  return `${packageJson.name}@${selector || tag}`;
}

const tmp = await mkdtemp(join(tmpdir(), 'vura-registry-smoke-'));
try {
  const specs = (await Promise.all(publishPackages.map(packageSpec))).filter(Boolean);
  if (specs.length === 0) throw new Error('No public packages found for registry smoke');

  run('npm', ['init', '-y'], { cwd: tmp });
  run('npm', ['install', '--ignore-scripts', ...specs], { cwd: tmp });

  assertInstalledBins(tmp);
  assertHelpCommands(tmp);

  const importCheck = `
    await import('@then/core');
    await import('@then/compiler');
    await import('@then/adapter-cloudflare');
    await import('@then/adapter-lambda');
    await import('@then/vite-plugin');
    console.log('VURA_REGISTRY_IMPORT_OK');
  `;
  const imported = run(process.execPath, ['--input-type=module', '-e', importCheck], { cwd: tmp });
  if (!imported.stdout.includes('VURA_REGISTRY_IMPORT_OK')) {
    throw new Error('Registry smoke import did not complete');
  }

  const createThenBin = realpathSync(join(tmp, 'node_modules/create-then/dist/index.js'));
  const scaffold = run(process.execPath, [createThenBin, 'registry-smoke-app', '--dry-run'], { cwd: tmp });
  if (!scaffold.stdout.includes('package.json')) {
    throw new Error(`create-then registry scaffold smoke did not list package.json; stdout=${JSON.stringify(scaffold.stdout)} stderr=${JSON.stringify(scaffold.stderr)}`);
  }

  const artifact = {
    status: 'passed',
    generatedAt: new Date().toISOString(),
    packageCount: specs.length,
    packages: specs,
    checks: ['npm install --ignore-scripts', 'installed CLI bins', 'direct installed CLI bin help', 'esm imports', 'create-then --dry-run'],
  };
  await mkdir(dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);

  console.log(`OK: registry smoke installed, verified CLI bins/direct help, and imported ${specs.length} package(s): ${specs.join(', ')}`);
} finally {
  await rm(tmp, { recursive: true, force: true });
}
