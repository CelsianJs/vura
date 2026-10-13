import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FIXTURE_OWNERSHIP_MARKER,
  generateFixture,
  validateFixtureSource,
} from './lib/fixture.mjs';
import { runProcess, withFixturesRoot } from './lib/runner.mjs';
import { getMatrixSpec, MATRIX_SPECS, selectMatrixSpecs } from './lib/spec.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const temporaryRoots: string[] = [];

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), 'vura-matrix-test-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('build matrix contract', () => {
  it('builds static and hybrid cells through the default CLI and cleans its temporary fixtures', async () => {
    const temporaryParent = await temporaryRoot();
    const result = await runProcess(process.execPath, [
      join(repoRoot, 'benchmarks/build-matrix/run.mjs'),
      '--cells', 'small-static,small-hybrid', '--json',
      '--cell-timeout-ms', '60000', '--bootstrap-timeout-ms', '60000',
    ], repoRoot, { timeoutMs: 120_000, env: { ...process.env, TMPDIR: temporaryParent } });

    expect((await readdir(temporaryParent)).filter((name) => name.startsWith('vura-build-matrix-'))).toEqual([]);
    expect(result.stderr).not.toContain('Cannot find package');
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({ ok: true, cellCount: 2 });
    expect(report.toolRevision).toMatchObject({
      whatFrameworkVersion: JSON.parse(await readFile(join(repoRoot, 'packages/cli/node_modules/what-framework/package.json'), 'utf8')).version,
      celsianCoreVersion: JSON.parse(await readFile(join(repoRoot, 'packages/core/node_modules/@celsian/core/package.json'), 'utf8')).version,
    });
    expect(report.bootstrapDurationMs).toBeGreaterThan(0);
    expect(report.results.map((cell: { id: string }) => cell.id)).toEqual(['small-static', 'small-hybrid']);
    expect(report.results.every((cell: { manifestValidated: boolean }) => cell.manifestValidated)).toBe(true);
    expect(report.results.every((cell: { setupDurationMs: number }) => cell.setupDurationMs > 0)).toBe(true);
    expect(result.stdout).not.toContain(temporaryParent);
  }, 120_000);

  it('defines exactly 15 unique cells without an Edge placement', () => {
    expect(MATRIX_SPECS).toHaveLength(15);
    expect(new Set(MATRIX_SPECS.map((spec) => spec.id))).toHaveLength(15);
    expect(JSON.stringify(MATRIX_SPECS)).not.toContain('edge');
    expect(selectMatrixSpecs('small-static,large-hybrid').map((spec) => spec.id))
      .toEqual(['small-static', 'large-hybrid']);
  });

  it('uses the agreed exact workload counts and asset weights', () => {
    expect(getMatrixSpec('small-static')).toMatchObject({
      counts: { pages: { static: 1 } },
      asset: { files: 1, bytes: 102_400 },
    });
    expect(getMatrixSpec('medium-dedicated')).toMatchObject({
      counts: { api: { dedicated: 10 }, features: { websocket: 1, streaming: 0 } },
    });
    expect(getMatrixSpec('large-task')).toMatchObject({ counts: { api: { task: 50 } } });
    expect(getMatrixSpec('large-hybrid')).toMatchObject({
      counts: {
        pages: { static: 15, client: 15, server: 10, hybrid: 10 },
        api: { function: 50, dedicated: 25, task: 25 },
        features: { websocket: 1, streaming: 1 },
      },
      asset: { files: 1, bytes: 52_428_800 },
    });
  });

  it('generates byte-for-byte deterministic source fixtures from the named seed', async () => {
    const [leftRoot, rightRoot] = await Promise.all([temporaryRoot(), temporaryRoot()]);
    const spec = getMatrixSpec('medium-hybrid');
    const [left, right] = await Promise.all([
      generateFixture({ repoRoot, outputRoot: leftRoot, spec }),
      generateFixture({ repoRoot, outputRoot: rightRoot, spec }),
    ]);
    expect(left.contract.sourceChecksum).toBe(right.contract.sourceChecksum);
    expect(left.contract.asset).toEqual(right.contract.asset);
    expect(await validateFixtureSource(left.fixtureRoot)).toEqual(left.contract);
    expect(await validateFixtureSource(right.fixtureRoot)).toEqual(right.contract);
    expect(JSON.parse(await readFile(join(left.fixtureRoot, 'package.json'), 'utf8'))).toMatchObject({
      dependencies: {
        '@celsian/vura-core': left.contract.versions.core,
        'what-framework': left.contract.versions.whatFramework,
      },
      devDependencies: { '@celsian/vura-cli': left.contract.versions.cli },
    });
  });

  it('generates a representative Hybrid fixture with no Edge route source', async () => {
    const outputRoot = await temporaryRoot();
    const generated = await generateFixture({ repoRoot, outputRoot, spec: getMatrixSpec('small-hybrid') });
    const contract = await validateFixtureSource(generated.fixtureRoot);
    expect(contract.counts).toEqual(getMatrixSpec('small-hybrid').counts);
    expect(await readFile(join(generated.fixtureRoot, 'src', 'api', 'function', '001.ts'), 'utf8'))
      .toContain("kind: 'serverless'");
    expect(await readFile(join(generated.fixtureRoot, 'src', 'api', 'dedicated', '001.ts'), 'utf8'))
      .toContain("kind: 'hot'");
    expect(JSON.stringify(contract)).not.toContain('edge');
  });

  it('refuses to recursively delete an existing unowned cell directory', async () => {
    const outputRoot = await temporaryRoot();
    const cellRoot = join(outputRoot, 'small-static');
    await mkdir(cellRoot);
    await writeFile(join(cellRoot, 'keep-me.txt'), 'user-owned\n', 'utf8');

    await expect(generateFixture({ repoRoot, outputRoot, spec: getMatrixSpec('small-static') }))
      .rejects.toThrow('refusing to recursively delete unowned fixture directory');
    await expect(readFile(join(cellRoot, 'keep-me.txt'), 'utf8')).resolves.toBe('user-owned\n');
  });

  it('regenerates only fixture directories carrying the matching harness ownership marker', async () => {
    const outputRoot = await temporaryRoot();
    const spec = getMatrixSpec('small-static');
    const first = await generateFixture({ repoRoot, outputRoot, spec });
    await writeFile(join(first.fixtureRoot, 'stale.txt'), 'stale\n', 'utf8');

    const second = await generateFixture({ repoRoot, outputRoot, spec });
    await expect(access(join(second.fixtureRoot, 'stale.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(second.fixtureRoot, FIXTURE_OWNERSHIP_MARKER), 'utf8'))
      .resolves.toContain('"owner": "vura-build-matrix"');
  });

  it('links only each owned fixture, leaving a custom root dependency directory untouched', async () => {
    const outputRoot = await temporaryRoot();
    const unownedDependencies = join(outputRoot, 'node_modules');
    await mkdir(unownedDependencies);
    await writeFile(join(unownedDependencies, 'keep-me.txt'), 'user-owned\n');
    const { fixtureRoot } = await generateFixture({ repoRoot, outputRoot, spec: getMatrixSpec('small-static') });

    expect((await lstat(join(fixtureRoot, 'node_modules'))).isSymbolicLink()).toBe(true);
    expect(await realpath(join(fixtureRoot, 'node_modules')))
      .toBe(await realpath(join(repoRoot, 'packages/cli/node_modules')));
    expect(await readFile(join(unownedDependencies, 'keep-me.txt'), 'utf8')).toBe('user-owned\n');
    await expect(validateFixtureSource(fixtureRoot)).resolves.toMatchObject({ id: 'small-static' });
  });

  it('excludes dependency contents from the fixture source checksum', async () => {
    const outputRoot = await temporaryRoot();
    const { fixtureRoot, contract } = await generateFixture({ repoRoot, outputRoot, spec: getMatrixSpec('small-static') });
    // Replace the owned link, not its installed workspace target.
    await rm(join(fixtureRoot, 'node_modules'));
    await mkdir(join(fixtureRoot, 'node_modules'));
    await writeFile(join(fixtureRoot, 'node_modules', 'dependency.txt'), 'not fixture source\n');

    await expect(validateFixtureSource(fixtureRoot)).resolves.toEqual(contract);
  });

  it('rejects symlink fixture cells and custom roots without modifying their targets', async () => {
    const outputRoot = await temporaryRoot();
    const target = await temporaryRoot();
    await writeFile(join(target, 'keep-me.txt'), 'user-owned\n');
    await symlink(target, join(outputRoot, 'small-static'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(generateFixture({ repoRoot, outputRoot, spec: getMatrixSpec('small-static') }))
      .rejects.toThrow('refusing to replace unowned fixture path');
    const rootLink = join(outputRoot, 'root-link');
    await symlink(target, rootLink, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(withFixturesRoot(rootLink, async () => { throw new Error('operation should not run'); }))
      .rejects.toThrow('refusing to use a symlink or non-directory fixtures root');
    expect(await readFile(join(target, 'keep-me.txt'), 'utf8')).toBe('user-owned\n');
  });

  it('cleans owned dependency links on failure without removing installed dependencies', async () => {
    let ownedRoot = '';
    const installedDependencies = await realpath(join(repoRoot, 'packages/cli/node_modules'));
    await expect(withFixturesRoot(undefined, async (outputRoot: string) => {
      ownedRoot = outputRoot;
      const { fixtureRoot } = await generateFixture({ repoRoot, outputRoot, spec: getMatrixSpec('small-static') });
      expect(await realpath(join(fixtureRoot, 'node_modules'))).toBe(installedDependencies);
      throw new Error('fixture build failure');
    })).rejects.toThrow('fixture build failure');

    await expect(access(ownedRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(installedDependencies)).resolves.toBeUndefined();
  });

  it.each([0, -1, 1.5, NaN, 3_600_001])('rejects malformed timeout %s before starting a child', (timeoutMs) => {
    expect(() => runProcess(process.execPath, ['-e', ''], repoRoot, { timeoutMs })).toThrow();
  });

  it('terminates timed-out child processes and removes harness-owned temporary fixture roots', async () => {
    let ownedRoot = '';
    const result = await withFixturesRoot(undefined, async (fixturesRoot: string) => {
      ownedRoot = fixturesRoot;
      return runProcess(process.execPath, [
        '-e',
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
      ], fixturesRoot, { timeoutMs: 50, terminateGraceMs: 50 });
    });

    expect(result).toMatchObject({ exitCode: 124, timedOut: true, timeoutMs: 50 });
    expect(result.terminationSignal).toMatch(/^SIG(?:TERM|KILL)$/);
    await expect(access(ownedRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(() => runProcess(process.execPath, ['-e', ''], repoRoot, { timeoutMs: 3_600_001 }))
      .toThrow('process timeout must be at most 3600000ms');
  });
});
