#!/usr/bin/env node
// Prove the manifest contract can be consumed without the framework toolchain.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = await mkdtemp(join(tmpdir(), 'vura-contract-package-'));
function run(command, args, cwd = temp) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${command} failed (${result.status}): ${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

try {
  const packed = run('pnpm', ['pack', '--pack-destination', temp], join(root, 'packages/contract'));
  const reported = packed.trim().split(/\r?\n/).at(-1);
  assert.ok(reported, 'pnpm pack must report the contract tarball');
  const tarball = isAbsolute(reported) ? reported : join(temp, reported);
  await writeFile(join(temp, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball]);
  const installed = JSON.parse(await readFile(join(temp, 'node_modules/@celsian/vura-contract/package.json'), 'utf8'));
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies', 'bundleDependencies']) {
    assert.equal(Object.keys(installed[field] ?? {}).length, 0, `contract must have no ${field}`);
  }
  const tree = JSON.parse(run('npm', ['ls', '--all', '--json']));
  assert.deepEqual(Object.keys(tree.dependencies ?? {}), ['@celsian/vura-contract']);
  assert.equal(Object.keys(tree.dependencies['@celsian/vura-contract'].dependencies ?? {}).length, 0);

  const probe = `
    import assert from 'node:assert/strict';
    import { parseManifest, deriveRequiredFeatures, evaluateCapabilities } from '@celsian/vura-contract';
    const manifest = parseManifest({
      schemaVersion: 1, requiredFeatures: [], api: [], pages: [], layouts: [],
      timestamp: '2026-09-06T00:00:00.000Z',
    });
    assert.deepEqual(deriveRequiredFeatures(manifest), []);
    assert.equal(evaluateCapabilities(manifest, {name:'empty-fixture', supportedFeatures:[]}).compatible, true);
    assert.throws(() => parseManifest({...manifest, schemaVersion:999}));
    assert.throws(() => parseManifest({...manifest, requiredFeatures:['unknown-feature']}));
    console.log('VURA_CONTRACT_PACKAGE_OK');
  `;
  assert.match(run(process.execPath, ['--input-type=module', '-e', probe]), /VURA_CONTRACT_PACKAGE_OK/);

  await writeFile(join(temp, 'consumer.ts'), `
    import { parseManifest, evaluateCapabilities, type ParsedManifest } from '@celsian/vura-contract';
    const manifest: ParsedManifest = parseManifest('{}');
    const result: boolean = evaluateCapabilities(manifest, {name:'consumer', supportedFeatures:[]}).compatible;
    void result;
    // @ts-expect-error unknown capabilities must not silently become supported
    evaluateCapabilities(manifest, {name:'invalid', supportedFeatures:['made-up-feature']});
  `);
  await writeFile(join(temp, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
      strict: true, skipLibCheck: false, noEmit: true, types: [], lib: ['ES2022'],
    },
    files: ['consumer.ts'],
  }));
  // The compiler is the test tool, not a dependency of the clean consumer.
  run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(temp, 'tsconfig.json')]);
  console.log('OK: contract-only tarball install, zero transitive dependencies, ESM behavior and strict declarations without Node/DOM ambient types');
} finally {
  await rm(temp, { recursive: true, force: true });
}
