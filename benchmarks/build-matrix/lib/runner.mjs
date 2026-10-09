import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { generateFixture, resolveToolVersions, validateBuildOutput, validateFixtureSource } from './fixture.mjs';

const execFileAsync = promisify(execFile);
export const DEFAULT_BUILD_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_TERMINATE_GRACE_MS = 2_000;
export const MAX_PROCESS_TIMEOUT_MS = 60 * 60 * 1000;
export const MAX_TERMINATE_GRACE_MS = 60_000;

export async function runBuildMatrix({
  repoRoot,
  specs,
  outputRoot,
  onProgress = () => {},
  buildTimeoutMs = DEFAULT_BUILD_TIMEOUT_MS,
  bootstrapTimeoutMs = DEFAULT_BOOTSTRAP_TIMEOUT_MS,
}) {
  const bootstrapStartedAt = performance.now();
  await ensureCliBuilt(repoRoot, { timeoutMs: bootstrapTimeoutMs });
  const bootstrapDurationMs = performance.now() - bootstrapStartedAt;
  const toolRevision = await resolveToolRevision(repoRoot);
  return withFixturesRoot(outputRoot, async (fixturesRoot) => {
    const results = [];
    for (let index = 0; index < specs.length; index += 1) {
      const spec = specs[index];
      onProgress({ id: spec.id, phase: 'generate', completed: index, total: specs.length });
      const setupStartedAt = performance.now();
      const { fixtureRoot, contract } = await generateFixture({ repoRoot, outputRoot: fixturesRoot, spec });
      await validateFixtureSource(fixtureRoot);
      const setupDurationMs = performance.now() - setupStartedAt;
      onProgress({ id: spec.id, phase: 'build', completed: index, total: specs.length });
      const startedAt = performance.now();
      const build = await runVuraBuild({
        repoRoot,
        fixtureRoot,
        skipBootstrap: true,
        timeoutMs: buildTimeoutMs,
      });
      const durationMs = performance.now() - startedAt;
      if (build.timedOut) {
        throw new Error(`vura build timed out for ${spec.id} after ${build.timeoutMs}ms`);
      }
      if (build.exitCode !== 0) {
        throw new Error(sanitizeError(`vura build failed for ${spec.id}: ${build.stderr || build.stdout}`, repoRoot, fixtureRoot));
      }
      const validation = await validateBuildOutput(fixtureRoot, contract);
      results.push({
        id: spec.id,
        size: spec.size,
        workload: spec.workload,
        setupDurationMs,
        durationMs,
        counts: contract.counts,
        asset: contract.asset,
        sourceChecksum: contract.sourceChecksum,
        outputChecksum: validation.outputChecksum,
        manifestValidated: true,
        buildExitCode: build.exitCode,
      });
      onProgress({ id: spec.id, phase: 'complete', completed: index + 1, total: specs.length });
    }
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      seed: specs.length === 0 ? null : specs[0].seed.split(':').slice(0, -2).join(':'),
      toolRevision,
      bootstrapDurationMs,
      cellCount: results.length,
      ok: results.length === specs.length && results.every((result) => result.manifestValidated),
      results,
    };
  });
}

export async function runVuraBuild({
  repoRoot,
  fixtureRoot,
  skipBootstrap = false,
  timeoutMs = DEFAULT_BUILD_TIMEOUT_MS,
}) {
  if (!skipBootstrap) await ensureCliBuilt(repoRoot);
  const cliBin = join(repoRoot, 'packages', 'cli', 'dist', 'bin.js');
  return runProcess(process.execPath, [cliBin, 'build'], fixtureRoot, {
    timeoutMs,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
}

export async function ensureCliBuilt(repoRoot, { timeoutMs = DEFAULT_BOOTSTRAP_TIMEOUT_MS } = {}) {
  const tscBin = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
  const result = await runProcess(process.execPath, [tscBin, '-b', 'packages/cli'], repoRoot, { timeoutMs });
  if (result.timedOut) {
    throw new Error(`current Vura CLI compilation timed out after ${result.timeoutMs}ms`);
  }
  if (result.exitCode !== 0) {
    throw new Error(sanitizeError(`failed to compile the current Vura CLI: ${result.stderr || result.stdout}`, repoRoot, repoRoot));
  }
}

async function resolveToolRevision(repoRoot) {
  const [commitResult, statusResult, versions] = await Promise.all([
    execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }),
    execFileAsync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: repoRoot }),
    resolveToolVersions(repoRoot),
  ]);
  return {
    gitCommit: commitResult.stdout.trim(),
    dirty: statusResult.stdout.trim().length > 0,
    cliVersion: versions.cli,
    coreVersion: versions.core,
    whatFrameworkVersion: versions.whatFramework,
    celsianCoreVersion: versions.celsianCore,
    nodeVersion: process.version,
  };
}

function sanitizeError(message, repoRoot, fixtureRoot) {
  return message.replaceAll(fixtureRoot, '<fixture>').replaceAll(repoRoot, '<repo>');
}

export async function withFixturesRoot(outputRoot, operation) {
  const ownsFixturesRoot = !outputRoot;
  const fixturesRoot = outputRoot || await mkdtemp(join(tmpdir(), 'vura-build-matrix-'));
  if (!ownsFixturesRoot) {
    await mkdir(fixturesRoot, { recursive: true });
    const info = await lstat(fixturesRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error('refusing to use a symlink or non-directory fixtures root');
    }
  }
  try {
    return await operation(fixturesRoot);
  } finally {
    if (ownsFixturesRoot) await rm(fixturesRoot, { recursive: true, force: true });
  }
}

export function runProcess(command, args, cwd, options = {}) {
  const timeoutMs = positiveInteger(
    options.timeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS,
    'process timeout',
    MAX_PROCESS_TIMEOUT_MS,
  );
  const terminateGraceMs = positiveInteger(
    options.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS,
    'termination grace period',
    MAX_TERMINATE_GRACE_MS,
  );
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: options.env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let forceKillTimer = null;
    let terminationWatchdog = null;
    const clearTimers = () => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (terminationWatchdog) clearTimeout(terminationWatchdog);
    };
    const finish = (exitCode, signal, terminationConfirmed = true) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve({
        exitCode: timedOut ? 124 : exitCode ?? 1,
        stdout,
        stderr,
        timedOut,
        timeoutMs,
        terminationSignal: signal ?? null,
        terminationConfirmed,
      });
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child, 'SIGTERM');
      forceKillTimer = setTimeout(() => {
        terminateProcessTree(child, 'SIGKILL');
        terminationWatchdog = setTimeout(
          () => finish(124, 'SIGKILL', false),
          terminateGraceMs,
        );
      }, terminateGraceMs);
      forceKillTimer.unref?.();
    }, timeoutMs);
    timeout.unref?.();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(error);
    });
    child.once('close', (exitCode, signal) => finish(exitCode, signal));
  });
}

function terminateProcessTree(child, signal) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code === 'ESRCH') return;
    try {
      child.kill(signal);
    } catch {
      // The close event remains the source of truth for process termination.
    }
  }
}

function positiveInteger(value, label, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  if (parsed > maximum) throw new Error(`${label} must be at most ${maximum}ms`);
  return parsed;
}
