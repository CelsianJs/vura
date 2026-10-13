import { afterAll, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildRegistryNpmInstallInvocation,
  isDirectExecution,
  runRegistryNpmInstallOnce,
  summarizeRetryError,
  validateRegistryVersion,
} from './verify-registry-install.mjs';

const temporaryRoots = [];
afterAll(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('buildRegistryNpmInstallInvocation', () => {
  it('forces online registry metadata through an isolated per-run npm cache', () => {
    const invocation = buildRegistryNpmInstallInvocation('/tmp/vura-registry-cache-123', [
      '@celsian/vura-core@0.8.1',
      '@celsian/vura-adapter-cloudflare@0.8.1',
    ]);

    expect(invocation.cmd).toBe('npm');
    expect(invocation.args).toEqual([
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--prefer-online',
      '--prefer-offline=false',
      '--cache',
      '/tmp/vura-registry-cache-123',
      '@celsian/vura-core@0.8.1',
      '@celsian/vura-adapter-cloudflare@0.8.1',
    ]);
    expect(invocation.env).toEqual({
      npm_config_cache: '/tmp/vura-registry-cache-123',
      npm_config_prefer_online: 'true',
      npm_config_prefer_offline: 'false',
    });
  });
});

describe('runRegistryNpmInstallOnce', () => {
  it('spawns npm through the configured binary and passes online metadata flags plus env', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vura-fake-npm-'));
    temporaryRoots.push(root);
    const log = join(root, 'npm-argv.json');
    const fakeNpm = join(root, 'fake-npm.js');
    await writeFile(fakeNpm, [
      '#!/usr/bin/env node',
      "const { writeFileSync } = require('node:fs');",
      `writeFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), env: { npm_config_cache: process.env.npm_config_cache, npm_config_prefer_online: process.env.npm_config_prefer_online, npm_config_prefer_offline: process.env.npm_config_prefer_offline } }, null, 2));`,
      'process.exit(0);',
    ].join('\n'));
    await chmod(fakeNpm, 0o755);

    runRegistryNpmInstallOnce(root, ['@celsian/vura-core@0.8.1'], join(root, '.npm-cache'), {
      cmd: process.execPath,
      prefixArgs: [fakeNpm],
    });

    const observed = JSON.parse(await readFile(log, 'utf8'));
    expect(observed.argv).toEqual([
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--prefer-online',
      '--prefer-offline=false',
      '--cache',
      join(root, '.npm-cache'),
      '@celsian/vura-core@0.8.1',
    ]);
    expect(observed.env).toEqual({
      npm_config_cache: join(root, '.npm-cache'),
      npm_config_prefer_online: 'true',
      npm_config_prefer_offline: 'false',
    });
  });
});

describe('validateRegistryVersion', () => {
  it('accepts exact semver versions and prereleases', () => {
    expect(validateRegistryVersion('0.8.1')).toBe('0.8.1');
    expect(validateRegistryVersion('1.2.3-rc.1')).toBe('1.2.3-rc.1');
    expect(validateRegistryVersion('1.2.3+build.1')).toBe('1.2.3+build.1');
    expect(validateRegistryVersion(undefined)).toBeUndefined();
  });

  it('rejects tags, ranges, leading-v versions, and URL-like selectors', () => {
    for (const value of ['', 'latest', '^0.8.1', '~0.8.1', 'v0.8.1', 'https://registry.npmjs.org/pkg', '1.2.3-rc..1', '1.2.3-01', '01.2.3']) {
      expect(() => validateRegistryVersion(value)).toThrow('exact semver');
    }
  });
});

describe('direct execution guard', () => {
  it('does not execute main for an absent or unrelated entrypoint', () => {
    expect(isDirectExecution('/definitely-absent-vura-checker')).toBe(false);
    expect(isDirectExecution(process.execPath)).toBe(false);
  });

  it('runs main when the script is invoked through a filesystem symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vura-registry-guard-'));
    temporaryRoots.push(root);
    const link = join(root, 'verify-registry-link.mjs');
    await symlink(resolve('scripts/verify-registry-install.mjs'), link);

    const res = spawnSync(process.execPath, [link], {
      cwd: resolve('.'),
      encoding: 'utf8',
      env: {
        ...process.env,
        VURA_REGISTRY_VERSION: 'latest',
        VURA_REGISTRY_SMOKE_ARTIFACT: join(root, 'failure.json'),
      },
    });

    expect(res.status).toBe(1);
    expect(res.stderr).toContain('VURA_REGISTRY_VERSION must be an exact semver version');
  });
});

describe('summarizeRetryError', () => {
  it('keeps the actual registry error shape while bounding noisy npm output', () => {
    const longError = new Error([
      'npm error code ETARGET',
      'npm error notarget No matching version found for @celsian/vura-adapter-cloudflare@0.8.1.',
      'npm error notarget In most cases you or one of your dependencies are requesting',
      'npm error notarget a package version that does not exist.',
      'npm verbose cwd /tmp/vura-registry-smoke',
      'npm verbose os Darwin',
      'npm verbose node v22.13.1',
      'npm verbose npm 10.9.2',
      'npm verbose exit 1',
      'npm verbose code 1',
    ].join('\n'));

    const summary = summarizeRetryError(longError, { maxLines: 4, maxChars: 220 });

    expect(summary).toContain('npm error code ETARGET');
    expect(summary).toContain('@celsian/vura-adapter-cloudflare@0.8.1');
    expect(summary).not.toContain('npm verbose cwd');
    expect(summary.length).toBeLessThanOrEqual(220);
  });
});
