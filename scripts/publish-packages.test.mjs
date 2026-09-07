import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { publishPackages } from './package-list.mjs';

const execFileAsync = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'vura-publish-access-'));
  temporaryDirectories.push(dir);
  const bin = join(dir, 'bin');
  await mkdir(bin);
  const packages = [];
  for (const packagePath of publishPackages) {
    const pkg = JSON.parse(await readFile(join(root, packagePath, 'package.json'), 'utf8'));
    if (pkg.private) continue;
    packages.push(pkg.name);
    await mkdir(join(dir, packagePath), { recursive: true });
    await writeFile(join(dir, packagePath, 'package.json'), JSON.stringify({ name: pkg.name, version: '0.0.0-test' }));
  }
  const collaboratorMaps = Object.hasOwn(options, 'collaborators')
    ? options.collaborators
    : Object.fromEntries(packages.map((name) => [name, { 'release-tester': 'read-write' }]));
  const callsPath = join(dir, 'calls.jsonl');
  const preamble = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
const log = (tool) => appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({tool, args}) + '\\n');
`;
  await writeFile(join(bin, 'npm'), `${preamble}
log('npm');
if (args[0] === 'whoami') { console.log('release-tester'); process.exit(0); }
if (args[0] === 'access') {
  if (args[1] === 'list' && args[2] === 'packages') {
    console.error('npm ERR! code E403');
    console.error('npm ERR! 403 simulated account-wide package inventory denial');
    process.exit(1);
  }
  if (args[1] === 'list' && args[2] === 'collaborators') {
    if (${Boolean(options.collaboratorError)}) { console.error('npm ERR! code E403'); process.exit(1); }
    const packageName = args[3];
    const collaborators = ${JSON.stringify(
      typeof collaboratorMaps === 'string'
        ? collaboratorMaps
        : Object.fromEntries(Object.entries(collaboratorMaps).map(([name, value]) => [name, typeof value === 'string' ? value : JSON.stringify(value)])),
    )};
    console.log(Object.hasOwn(collaborators, packageName) ? collaborators[packageName] : '{}');
    process.exit(0);
  }
}
if (args[0] === 'view') { console.error('E404 version not found'); process.exit(1); }
if (args[0] === 'publish') { process.exit(0); }
console.error('Unexpected fake npm command'); process.exit(99);
`, { mode: 0o755 });
  await writeFile(join(bin, 'pnpm'), `${preamble}
log('pnpm');
if (args[0] === 'pack') { console.log(${JSON.stringify(join(dir, 'fake-package.tgz'))}); process.exit(0); }
process.exit(99);
`, { mode: 0o755 });
  return {
    packages,
    calls: async () => (await readFile(callsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)),
    run: (args = []) => execFileAsync(process.execPath, [join(root, 'scripts/publish-packages.mjs'), ...args], {
      cwd: dir,
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
        NODE_AUTH_TOKEN: '', NPM_TOKEN: '', NPM_PROVENANCE: '0', NPM_DIST_TAG: 'latest',
        VURA_PUBLISH_DRY_RUN: '0', NPM_PUBLISH_DRY_RUN: '0',
      },
    }),
  };
}

describe('publish-packages npm package access preflight', () => {
  it.each([
    ['collaborator denial', () => ({ collaboratorError: true })],
    ['invalid JSON', (names) => ({ collaborators: Object.fromEntries(names.map((name) => [name, name === '@celsian/vura-core' ? 'not json' : { 'release-tester': 'read-write' }])) })],
    ['array response', (names) => ({ collaborators: Object.fromEntries(names.map((name) => [name, name === '@celsian/vura-core' ? [] : { 'release-tester': 'read-write' }])) })],
    ['null response', (names) => ({ collaborators: Object.fromEntries(names.map((name) => [name, name === '@celsian/vura-core' ? null : { 'release-tester': 'read-write' }])) })],
    ['numeric response', (names) => ({ collaborators: Object.fromEntries(names.map((name) => [name, name === '@celsian/vura-core' ? 42 : { 'release-tester': 'read-write' }])) })],
  ])('refuses %s before version lookup, packing or publishing', async (_name, optionsForNames) => {
    const names = (await fixture()).packages;
    const f = await fixture(optionsForNames(names));
    await expect(f.run()).rejects.toMatchObject({ code: 1 });
    const calls = await f.calls();
    expect(calls[0]).toEqual({ tool: 'npm', args: ['whoami'] });
    expect(calls.every((call) => call.args[0] !== 'view' && call.args[0] !== 'publish' && call.tool !== 'pnpm')).toBe(true);
  }, 120_000);

  it.each(['@celsian/vura-core', 'create-vura'])('refuses read-only access to %s before any upload', async (name) => {
    const names = (await fixture()).packages;
    const collaborators = Object.fromEntries(names.map((pkg) => [pkg, { 'release-tester': pkg === name ? 'read-only' : 'read-write' }]));
    const f = await fixture({ collaborators });
    await expect(f.run()).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining(name) });
    const calls = await f.calls();
    expect(calls[0].args[0]).toBe('whoami');
    expect(calls.every((call) => call.args[0] !== 'view' && call.args[0] !== 'publish' && call.tool !== 'pnpm')).toBe(true);
  }, 120_000);

  it('refuses missing package access with explicit first-publication guidance', async () => {
    const names = (await fixture()).packages;
    const f = await fixture({
      collaborators: Object.fromEntries(names.map((name) => [name, name === 'create-vura' ? {} : { 'release-tester': 'read-write' }])),
    });
    await expect(f.run()).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('first publication') });
    const calls = await f.calls();
    expect(calls[0].args[0]).toBe('whoami');
    expect(calls.every((call) => call.args[0] !== 'view' && call.args[0] !== 'publish' && call.tool !== 'pnpm')).toBe(true);
  }, 120_000);

  it('uses package-specific collaborator checks even when account-wide package inventory would be denied', async () => {
    const f = await fixture();
    const result = await f.run();
    expect(result.stdout).toContain('token restrictions and package 2FA policy still apply');
    const calls = await f.calls();
    expect(calls[0]).toEqual({ tool: 'npm', args: ['whoami'] });
    expect(calls.some((call) => call.args.slice(0, 3).join(' ') === 'access list packages')).toBe(false);
    expect(calls.slice(1, 1 + f.packages.length)).toEqual(f.packages.map((name) => ({
      tool: 'npm',
      args: ['access', 'list', 'collaborators', name, 'release-tester', '--json'],
    })));
    expect(calls.slice(1 + f.packages.length, 1 + (2 * f.packages.length)).map((call) => call.args[0])).toEqual(f.packages.map(() => 'view'));
    expect(calls.filter((call) => call.args[0] === 'publish')).toHaveLength(f.packages.length);
  }, 120_000);

  it('keeps dry-run credential-free and never sends a real publish', async () => {
    const f = await fixture({ collaboratorError: true });
    await f.run(['--dry-run']);
    const calls = await f.calls();
    expect(calls.some((call) => ['access', 'whoami'].includes(call.args[0]))).toBe(false);
    const publish = calls.filter((call) => call.args[0] === 'publish');
    expect(publish).toHaveLength(f.packages.length);
    expect(publish.every((call) => call.args.includes('--dry-run'))).toBe(true);
  }, 120_000);
});
