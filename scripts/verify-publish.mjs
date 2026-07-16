#!/usr/bin/env node
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
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

const cliBins = ['vura'];
const smokeCliCommands = ['vura', 'create-vura'];

function installedBinPath(cwd, bin) {
  return join(cwd, 'node_modules', '.bin', bin);
}

function assertInstalledBins(cwd) {
  for (const bin of [...cliBins, 'create-vura']) {
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

async function findFreePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForText(url, text, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      const body = await res.text();
      if (res.ok && body.includes(text)) return;
      lastError = new Error(`${url} returned ${res.status} without ${text}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastError ?? new Error(`${url} did not become ready`);
}

async function rewriteScaffoldDeps(scaffoldDir, tarballsByName) {
  const packageJsonPath = join(scaffoldDir, 'package.json');
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  for (const [name, tarball] of tarballsByName) {
    if (packageJson.dependencies?.[name]) {
      packageJson.dependencies[name] = `file:${tarball}`;
    }
  }
  // Core now consumes the fallback compiler's static parser. Add its local
  // tarball explicitly so this unpublished canary cannot fall back to the
  // registry package that shares the current version number.
  const compilerTarball = tarballsByName.get('@celsian/vura-compiler');
  if (compilerTarball && packageJson.dependencies?.['@celsian/vura-core']) {
    packageJson.dependencies['@celsian/vura-compiler'] = `file:${compilerTarball}`;
  }
  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
}

async function assertScaffoldBuildAndBoot(scaffoldDir) {
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: scaffoldDir, stdio: 'pipe' });
  run('npm', ['run', 'build'], { cwd: scaffoldDir, stdio: 'pipe' });

  const port = await findFreePort();
  const child = spawn(process.execPath, ['dist/server/entry.js'], {
    cwd: scaffoldDir,
    env: { ...process.env, NODE_ENV: 'production', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  try {
    await waitForText(`http://127.0.0.1:${port}/`, 'Welcome to Vura');
    await waitForText(`http://127.0.0.1:${port}/about`, 'This project was scaffolded');
    await waitForText(`http://127.0.0.1:${port}/api/hello`, 'Hello from Vura');
    // Client-mode page: the shell must reference the browser bundle, and the
    // bundle must actually boot the page (mount call) — a raw page-module
    // bundle leaves /dashboard at "Loading..." forever.
    await waitForText(`http://127.0.0.1:${port}/dashboard`, '/_then/pages/dashboard.js');
    await waitForText(`http://127.0.0.1:${port}/_then/pages/dashboard.js`, 'mount(');
  } catch (err) {
    throw new Error(`scaffold boot smoke failed: ${err instanceof Error ? err.message : String(err)}\n${output}`);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }
}

function assertManagedDeployAdapterLoads(scaffoldDir) {
  const vuraBin = realpathSync(installedBinPath(scaffoldDir, 'vura'));
  const result = spawnSync(process.execPath, [
    vuraBin,
    'deploy',
    '--token', 'tarball-smoke-token',
    '--project-id', 'tarball-smoke-project',
    '--api-url', 'http://127.0.0.1:1',
  ], { cwd: scaffoldDir, encoding: 'utf8' });
  const output = `${result.stdout}\n${result.stderr}`;

  // The intentionally unreachable API is after the dynamic adapter import.
  // Reaching the network failure therefore proves the packed CLI resolved and
  // invoked the adapter from the generated app without a follow-up install.
  if (!output.includes('Deployment failed:')) {
    throw new Error(`packed vura deploy did not invoke the managed adapter; output=${JSON.stringify(output)}`);
  }
  if (output.includes('deploy support is not installed') || output.includes('npm install @celsian/vura-adapter-vura')) {
    throw new Error(`packed vura deploy could not resolve its managed adapter; output=${JSON.stringify(output)}`);
  }
}

const tmp = await mkdtemp(join(tmpdir(), 'vura-publish-verify-'));
try {
  const tarballs = [];
  const tarballsByName = new Map();
  for (const pkg of publishPackages) {
    const packageJson = JSON.parse(await readFile(join(root, pkg, 'package.json'), 'utf8'));
    if (packageJson.private) continue;
    const tarball = pnpmPack(pkg, tmp);
    const packed = run('tar', ['-xOf', tarball, 'package/package.json']).stdout;
    if (packed.includes('workspace:')) {
      throw new Error(`${packageJson.name} packed package.json still contains workspace: references`);
    }
    tarballs.push(tarball);
    tarballsByName.set(packageJson.name, tarball);
  }

  const smoke = join(tmp, 'smoke');
  run('mkdir', ['-p', smoke]);
  await readFile(join(root, 'package.json'), 'utf8');
  run('npm', ['init', '-y'], { cwd: smoke });
  run('npm', ['install', '--ignore-scripts', ...tarballs], { cwd: smoke, stdio: 'pipe' });

  assertInstalledBins(smoke);
  assertHelpCommands(smoke);

  const check = `
    import('@celsian/vura-core').then(() => import('@celsian/vura-compiler')).then(() => import('@celsian/vura-adapter-cloudflare')).then(() => import('@celsian/vura-adapter-lambda')).then(() => import('@celsian/vura-adapter-vura')).then(() => import('@celsian/vura-vite-plugin')).then(() => console.log('VURA_PUBLISH_VERIFY_OK'));
  `;
  const node = run(process.execPath, ['--input-type=module', '-e', check], { cwd: smoke });
  if (!node.stdout.includes('VURA_PUBLISH_VERIFY_OK')) throw new Error('publish smoke import did not complete');

  // create-vura scaffold smoke: validates the user-facing create command can run
  // from packed artifacts and emits package dependencies matching this release.

  const createThenBin = realpathSync(join(smoke, 'node_modules/create-vura/dist/index.js'));
  const scaffold = run(process.execPath, [createThenBin, 'smoke-app', '--dry-run'], { cwd: smoke });
  if (!scaffold.stdout.includes('package.json')) {
    throw new Error(`create-vura scaffold smoke did not list generated package.json; stdout=${JSON.stringify(scaffold.stdout)} stderr=${JSON.stringify(scaffold.stderr)}`);
  }

  const { getFiles } = await import(join(smoke, 'node_modules/create-vura/dist/index.js'));
  const scaffoldPackage = JSON.parse(getFiles('smoke-app')['package.json']);
  const scaffoldPackageDirs = new Map([
    ['@celsian/vura-core', 'packages/core'],
    ['@celsian/vura-cli', 'packages/cli'],
    ['@celsian/vura-adapter-vura', 'packages/adapter-vura'],
  ]);
  for (const [name, packageDir] of scaffoldPackageDirs) {
    const expectedVersion = JSON.parse(await readFile(join(root, packageDir, 'package.json'), 'utf8')).version;
    if (scaffoldPackage.dependencies[name] !== expectedVersion) {
      throw new Error(`create-vura scaffold dependency ${name}=${scaffoldPackage.dependencies[name]} does not match package version ${expectedVersion}`);
    }
  }

  const rootPackage = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const expectedWhatFramework = rootPackage.dependencies?.['what-framework'];
  if (scaffoldPackage.dependencies['what-framework'] !== expectedWhatFramework) {
    throw new Error(`create-vura scaffold dependency what-framework=${scaffoldPackage.dependencies['what-framework']} does not match root dependency ${expectedWhatFramework}`);
  }

  run(process.execPath, [createThenBin, 'smoke-app', '--no-install'], { cwd: smoke });
  const scaffoldDir = join(smoke, 'smoke-app');
  await rewriteScaffoldDeps(scaffoldDir, tarballsByName);
  await assertScaffoldBuildAndBoot(scaffoldDir);
  assertManagedDeployAdapterLoads(scaffoldDir);

  if (existsSync(join(root, 'packages/compiler-native/package.json'))) {
    const nativeJson = JSON.parse(await readFile(join(root, 'packages/compiler-native/package.json'), 'utf8'));
    if (!nativeJson.private) throw new Error('@celsian/vura-compiler-native must remain private until native artifacts exist');
  }
  console.log(`OK: verified ${tarballs.length} tarball(s); no workspace refs; installed CLI bins/direct help; clean npm install/import, real create-vura scaffold build/run, and packed vura deploy adapter-load smoke passed`);
} finally {
  await rm(tmp, { recursive: true, force: true });
}
