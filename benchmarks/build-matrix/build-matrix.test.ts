import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
