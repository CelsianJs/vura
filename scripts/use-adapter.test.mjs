import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const scriptPath = resolve('scripts/use-adapter.mjs');

async function makeScaffoldDir(extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'vura-use-adapter-'));
  const pkg = {
    name: 'test-app',
    version: '0.1.0',
    type: 'module',
    dependencies: {
      '@celsian/vura-core': '0.4.0',
      '@celsian/vura-cli': '0.4.0',
      'what-framework': '^0.11.1',
    },
    ...extra,
  };
  await writeFile(join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  await writeFile(
    join(dir, 'vura.config.js'),
    `import { defineConfig } from '@celsian/vura-core';\nexport default defineConfig({});\n`
  );
  return dir;
}

describe('use-adapter.mjs', () => {
  it('writes cloudflare adapter config to vura.config.js', async () => {
    const dir = await makeScaffoldDir();
    await execFileAsync(process.execPath, [scriptPath, dir, 'cloudflare']);
    const config = await readFile(join(dir, 'vura.config.js'), 'utf8');
    expect(config).toContain("import { cloudflareAdapter } from '@celsian/vura-adapter-cloudflare'");
    expect(config).toContain("cloudflareAdapter({");
    expect(config).toContain("name: 'my-worker'");
  });

  it('writes lambda adapter config to vura.config.js', async () => {
    const dir = await makeScaffoldDir();
    await execFileAsync(process.execPath, [scriptPath, dir, 'lambda']);
    const config = await readFile(join(dir, 'vura.config.js'), 'utf8');
    expect(config).toContain("import { lambdaAdapter } from '@celsian/vura-adapter-lambda'");
    expect(config).toContain("lambdaAdapter({");
    expect(config).toContain("region: 'us-east-1'");
  });

  it('adds the adapter package to dependencies when not present', async () => {
    const dir = await makeScaffoldDir();
    await execFileAsync(process.execPath, [scriptPath, dir, 'cloudflare']);
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    expect(pkg.dependencies).toHaveProperty('@celsian/vura-adapter-cloudflare');
  });

  it('preserves an existing file: tarball dep when adapter already linked', async () => {
    const dir = await makeScaffoldDir({
      dependencies: {
        '@celsian/vura-core': '0.4.0',
        '@celsian/vura-cli': '0.4.0',
        'what-framework': '^0.11.1',
        '@celsian/vura-adapter-cloudflare': 'file:/tmp/some-tarball.tgz',
      },
    });
    await execFileAsync(process.execPath, [scriptPath, dir, 'cloudflare']);
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    // Should not overwrite the existing file: dep
    expect(pkg.dependencies['@celsian/vura-adapter-cloudflare']).toBe(
      'file:/tmp/some-tarball.tgz'
    );
  });

  it('exits non-zero for unsupported adapter name', async () => {
    const dir = await makeScaffoldDir();
    await expect(
      execFileAsync(process.execPath, [scriptPath, dir, 'netlify'])
    ).rejects.toMatchObject({ code: 1 });
  });

  it('exits non-zero when no args given', async () => {
    await expect(
      execFileAsync(process.execPath, [scriptPath])
    ).rejects.toMatchObject({ code: 1 });
  });

  it('exits non-zero when target dir does not exist', async () => {
    await expect(
      execFileAsync(process.execPath, [scriptPath, '/tmp/does-not-exist-xyz', 'cloudflare'])
    ).rejects.toMatchObject({ code: 1 });
  });
});
