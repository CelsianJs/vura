#!/usr/bin/env node
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { publishPackages } from './package-list.mjs';
import { retryNpmInstall } from './lib/retry-npm-install.mjs';

const root = process.cwd();
const versionOverride = process.env.VURA_REGISTRY_VERSION;
const tag = process.env.VURA_REGISTRY_TAG || 'latest';
const artifactPath = process.env.VURA_REGISTRY_SMOKE_ARTIFACT || 'artifacts/registry-smoke.json';
// Defaults give ~4m45s of total retry budget (19 delays x 15s). The old
// 12 attempts x 10s (~110s) budget was NOT enough — the v0.5.3 release (run
// 28714991521, 2026-07-04) saw @celsian/vura-adapter-lambda still 404 after
// 2m07s of retrying against a confirmed-successful publish. See
// scripts/lib/retry-npm-install.mjs for the full rationale.
const installAttempts = Math.max(1, Number.parseInt(process.env.VURA_REGISTRY_INSTALL_ATTEMPTS || '20', 10));
const installRetryDelayMs = Math.max(0, Number.parseInt(process.env.VURA_REGISTRY_INSTALL_RETRY_DELAY_MS || '15000', 10));
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

// Wraps a registry-hitting `npm install` in retry-with-backoff. Used for both
// the top-level packages install AND the generated scaffold app's install —
// both hit the live registry right after publish and are equally exposed to
// propagation lag (the scaffold install previously had no retry at all).
async function runNpmInstallWithRetry(cwd, extraArgs, label) {
  return retryNpmInstall(
    () => run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...extraArgs], { cwd }),
    {
      attempts: installAttempts,
      delayMs: installRetryDelayMs,
      onAttemptResult: ({ attempt, attempts, status, retryable, error }) => {
        if (status === 'passed') {
          installAttemptLog.push({ attempt, label, status });
          return;
        }
        installAttemptLog.push({
          attempt,
          label,
          status,
          retryable,
          message: error instanceof Error ? error.message.split('\n').slice(0, 3).join('\n') : String(error),
        });
        if (retryable && attempt < attempts) {
          console.warn(`Registry install (${label}) attempt ${attempt}/${attempts} failed during npm propagation; retrying in ${installRetryDelayMs}ms`);
        }
      },
    },
  );
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
  await runNpmInstallWithRetry(scaffoldDir, [], 'generated app');
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

function assertManagedDeployAdapterLoads(scaffoldDir) {
  const vuraBin = realpathSync(installedBinPath(scaffoldDir, 'vura'));
  const result = spawnSync(process.execPath, [
    vuraBin,
    'deploy',
    '--token', 'registry-smoke-token',
    '--project-id', 'registry-smoke-project',
    '--api-url', 'http://127.0.0.1:1',
  ], { cwd: scaffoldDir, encoding: 'utf8' });
  const output = `${result.stdout}\n${result.stderr}`;
  if (!output.includes('Deployment failed:')) {
    throw new Error(`registry vura deploy did not invoke the managed adapter; output=${JSON.stringify(output)}`);
  }
  if (output.includes('deploy support is not installed') || output.includes('npm install @celsian/vura-adapter-vura')) {
    throw new Error(`registry vura deploy could not resolve its managed adapter; output=${JSON.stringify(output)}`);
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
  await runNpmInstallWithRetry(tmp, specs, 'registry packages');
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
    await import('@celsian/vura-adapter-vura');
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
  const scaffoldDir = join(tmp, 'registry-smoke-app');
  const scaffoldPackage = JSON.parse(await readFile(join(scaffoldDir, 'package.json'), 'utf8'));
  if (!scaffoldPackage.dependencies?.['@celsian/vura-adapter-vura']) {
    throw new Error('registry create-vura scaffold omitted @celsian/vura-adapter-vura');
  }
  completedChecks.push('generated app managed adapter dependency');
  await assertScaffoldBuildAndBoot(scaffoldDir);
  completedChecks.push('generated app npm install/build/boot');
  assertManagedDeployAdapterLoads(scaffoldDir);
  completedChecks.push('generated app vura deploy adapter load');

  await writeArtifact('passed', specs);

  console.log(`OK: registry smoke installed, verified CLI bins/direct help, real scaffold build/boot/deploy adapter load, and imported ${specs.length} package(s): ${specs.join(', ')}`);
} catch (err) {
  await writeArtifact('failed', specs, {
    error: err instanceof Error ? err.message : String(err),
  });
  throw err;
} finally {
  await rm(tmp, { recursive: true, force: true });
}
