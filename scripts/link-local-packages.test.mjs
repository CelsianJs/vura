import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const scriptPath = resolve('scripts/link-local-packages.mjs');

async function makeTargetDir(deps = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'vura-link-local-'));
  const pkg = {
    name: 'test-app',
    version: '0.1.0',
    type: 'module',
    dependencies: {
      '@celsian/vura-core': '0.4.0',
      '@celsian/vura-cli': '0.4.0',
      'what-framework': '^0.11.1',
      'create-vura': '0.4.0',
      ...deps,
    },
  };
  await writeFile(join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  return dir;
}

describe('link-local-packages.mjs', () => {
  it('rewrites @celsian/vura-* deps to file: tarballs', async () => {
    const dir = await makeTargetDir();
    const result = await execFileAsync(process.execPath, [scriptPath, dir]);
    expect(result.stdout).toContain('rewrote');

    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    expect(pkg.dependencies['@celsian/vura-core']).toMatch(/^file:/);
    expect(pkg.dependencies['@celsian/vura-cli']).toMatch(/^file:/);
  }, 60_000);

  it('rewrites Vura roots in every consumer dependency section', async () => {
    const dir = await makeTargetDir();
    const pkgPath = join(dir, 'package.json');
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
    delete pkg.dependencies['@celsian/vura-core'];
    pkg.devDependencies = { '@celsian/vura-core': '0.8.3' };
    pkg.peerDependencies = { '@celsian/vura-vite-plugin': '0.8.3' };
    pkg.optionalDependencies = { '@celsian/vura-adapter-cloudflare': '0.8.3' };
    await writeFile(pkgPath, JSON.stringify(pkg, null, 2));

    await execFileAsync(process.execPath, [scriptPath, dir]);

    const rewritten = JSON.parse(await readFile(pkgPath, 'utf8'));
    expect(rewritten.devDependencies['@celsian/vura-core']).toMatch(/^file:/);
    expect(rewritten.peerDependencies['@celsian/vura-vite-plugin']).toMatch(/^file:/);
    expect(rewritten.optionalDependencies['@celsian/vura-adapter-cloudflare']).toMatch(/^file:/);
  }, 60_000);

  it('adds internal runtime package closure as direct file dependencies for pnpm', async () => {
    const dir = await makeTargetDir();
    const pkgPath = join(dir, 'package.json');
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
    pkg.dependencies = { 'what-framework': pkg.dependencies['what-framework'] };
    pkg.devDependencies = { '@celsian/vura-core': '0.8.3' };
    pkg.pnpm = { onlyBuiltDependencies: ['esbuild'] };
    await writeFile(pkgPath, JSON.stringify(pkg, null, 2));

    await execFileAsync(process.execPath, [scriptPath, dir]);

    const rewritten = JSON.parse(await readFile(pkgPath, 'utf8'));
    expect(rewritten.devDependencies['@celsian/vura-core']).toMatch(/^file:/);
    expect(rewritten.dependencies['@celsian/vura-compiler']).toMatch(/^file:/);
    expect(rewritten.dependencies['@celsian/vura-contract']).toMatch(/^file:/);
    expect(rewritten.dependencies['@celsian/vura-adapter-vura']).toBeUndefined();
    expect(rewritten.dependencies['what-framework']).toBe('^0.11.1');
    expect(rewritten.pnpm.onlyBuiltDependencies).toEqual(['esbuild']);
    expect(rewritten.pnpm.overrides['@celsian/vura-core']).toMatch(/^file:/);
    expect(rewritten.pnpm.overrides['@celsian/vura-compiler']).toBe(
      rewritten.dependencies['@celsian/vura-compiler'],
    );
    expect(rewritten.pnpm.overrides['@celsian/vura-contract']).toBe(
      rewritten.dependencies['@celsian/vura-contract'],
    );
  }, 60_000);

  it('does not touch deps not in publishPackages', async () => {
    const dir = await makeTargetDir({ ws: '^8.18.0' });
    await execFileAsync(process.execPath, [scriptPath, dir]);
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    expect(pkg.dependencies['what-framework']).toBe('^0.11.1');
    expect(pkg.dependencies['ws']).toBe('^8.18.0');
  }, 60_000);

  it('exits non-zero when target dir does not exist', async () => {
    await expect(
      execFileAsync(process.execPath, [scriptPath, '/tmp/does-not-exist-abc'])
    ).rejects.toMatchObject({ code: 1 });
  });

  it('exits non-zero when no args given', async () => {
    await expect(
      execFileAsync(process.execPath, [scriptPath])
    ).rejects.toMatchObject({ code: 1 });
  });
});
