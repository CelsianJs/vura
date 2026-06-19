#!/usr/bin/env node
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { publishPackages } from './package-list.mjs';

const root = process.cwd();
const versionOverride = process.env.VURA_REGISTRY_VERSION;
const tag = process.env.VURA_REGISTRY_TAG || 'latest';
const artifactPath = process.env.VURA_REGISTRY_SMOKE_ARTIFACT || 'artifacts/registry-smoke.json';
const installAttempts = Math.max(1, Number.parseInt(process.env.VURA_REGISTRY_INSTALL_ATTEMPTS || '12', 10));
const installRetryDelayMs = Math.max(0, Number.parseInt(process.env.VURA_REGISTRY_INSTALL_RETRY_DELAY_MS || '10000', 10));
const completedChecks = [];
const installAttemptLog = [];

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { cwd: opts.cwd ?? root, encoding: 'utf8', stdio: opts.stdio ?? 'pipe' });
  if (res.status !== 0) {
    const details = [res.stdout, res.stderr].filter(Boolean).join('\n');
    throw new Error(`${cmd} ${args.join(' ')} failed with ${res.status}\n${details}`);
  }
  return res;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryableRegistryInstallFailure(err) {
  const message = err instanceof Error ? err.message : String(err);
  return /E404|ETARGET|No matching version found|notarget|not found|404 Not Found/i.test(message);
}

async function runRegistryInstallWithRetry(cwd, specs) {
  let lastError;

  for (let attempt = 1; attempt <= installAttempts; attempt++) {
    try {
      run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...specs], { cwd });
      installAttemptLog.push({ attempt, status: 'passed' });
      return;
    } catch (err) {
      lastError = err;
      const retryable = retryableRegistryInstallFailure(err);
      installAttemptLog.push({
        attempt,
        status: 'failed',
        retryable,
        message: err instanceof Error ? err.message.split('\n').slice(0, 3).join('\n') : String(err),
      });
      if (!retryable || attempt === installAttempts) break;
      console.warn(`Registry install attempt ${attempt}/${installAttempts} failed during npm propagation; retrying in ${installRetryDelayMs}ms`);
      await sleep(installRetryDelayMs);
    }
  }

  throw lastError;
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
    await waitForText(`http://127.0.0.1:${port}/api/hello`, 'Hello from Vura!');
  } catch (err) {
    throw new Error(`registry scaffold boot smoke failed: ${err instanceof Error ? err.message : String(err)}\n${output}`);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }
}

async function packageSpec(pkgDir) {
  const packageJson = JSON.parse(await readFile(join(root, pkgDir, 'package.json'), 'utf8'));
  if (packageJson.private) return null;
  const selector = versionOverride || packageJson.version;
  return `${packageJson.name}@${selector || tag}`;
}

async function writeArtifact(status, specs, extra = {}) {
  const artifact = {
    status,
    generatedAt: new Date().toISOString(),
    packageCount: specs.length,
    packages: specs,
    installAttempts: installAttemptLog,
    checks: completedChecks,
    ...extra,
  };
  await mkdir(dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
}

const tmp = await mkdtemp(join(tmpdir(), 'vura-registry-smoke-'));
let specs = [];
try {
  specs = (await Promise.all(publishPackages.map(packageSpec))).filter(Boolean);
  if (specs.length === 0) throw new Error('No public packages found for registry smoke');

  run('npm', ['init', '-y'], { cwd: tmp });
  await runRegistryInstallWithRetry(tmp, specs);
  completedChecks.push('npm install --ignore-scripts --no-audit --no-fund');

  assertInstalledBins(tmp);
  completedChecks.push('installed CLI bins');
  assertHelpCommands(tmp);
  completedChecks.push('direct installed CLI bin help');

  const importCheck = `
    await import('@celsian/vura-core');
    await import('@celsian/vura-compiler');
    await import('@celsian/vura-adapter-cloudflare');
    await import('@celsian/vura-adapter-lambda');
    await import('@celsian/vura-vite-plugin');
    console.log('VURA_REGISTRY_IMPORT_OK');
  `;
  const imported = run(process.execPath, ['--input-type=module', '-e', importCheck], { cwd: tmp });
  if (!imported.stdout.includes('VURA_REGISTRY_IMPORT_OK')) {
    throw new Error('Registry smoke import did not complete');
  }
  completedChecks.push('esm imports');

  const createThenBin = realpathSync(join(tmp, 'node_modules/create-vura/dist/index.js'));
  const scaffold = run(process.execPath, [createThenBin, 'registry-smoke-app', '--dry-run'], { cwd: tmp });
  if (!scaffold.stdout.includes('package.json')) {
    throw new Error(`create-vura registry scaffold smoke did not list package.json; stdout=${JSON.stringify(scaffold.stdout)} stderr=${JSON.stringify(scaffold.stderr)}`);
  }
  completedChecks.push('create-vura --dry-run');

  run(process.execPath, [createThenBin, 'registry-smoke-app', '--no-install'], { cwd: tmp });
  completedChecks.push('create-vura --no-install');
  await assertScaffoldBuildAndBoot(join(tmp, 'registry-smoke-app'));
  completedChecks.push('generated app npm install/build/boot');

  await writeArtifact('passed', specs);

  console.log(`OK: registry smoke installed, verified CLI bins/direct help, real scaffold build/boot, and imported ${specs.length} package(s): ${specs.join(', ')}`);
} catch (err) {
  await writeArtifact('failed', specs, {
    error: err instanceof Error ? err.message : String(err),
  });
  throw err;
} finally {
  await rm(tmp, { recursive: true, force: true });
}
