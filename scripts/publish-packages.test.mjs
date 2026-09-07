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
  const access = Object.hasOwn(options, 'access') ? options.access : Object.fromEntries(packages.map((name) => [name, 'read-write']));
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
  if (${Boolean(options.accessError)}) { console.error('403 simulated access denial'); process.exit(1); }
  console.log(${JSON.stringify(typeof access === 'string' ? access : JSON.stringify(access))});
  process.exit(0);
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
    ['access denial', { accessError: true }],
    ['empty access map', { access: {} }],
    ['invalid JSON', { access: 'not json' }],
    ['array response', { access: [] }],
    ['null response', { access: null }],
    ['numeric response', { access: 42 }],
  ])('refuses %s before version lookup, packing or publishing', async (_name, options) => {
    const f = await fixture(options);
    await expect(f.run()).rejects.toMatchObject({ code: 1 });
    expect(await f.calls()).toEqual([
      { tool: 'npm', args: ['whoami'] },
      { tool: 'npm', args: ['access', 'list', 'packages', 'release-tester', '--json'] },
    ]);
  }, 120_000);

  it.each(['@celsian/vura-core', 'create-vura'])('refuses read-only access to %s before any upload', async (name) => {
    const names = (await fixture()).packages;
    const access = Object.fromEntries(names.map((pkg) => [pkg, pkg === name ? 'read-only' : 'read-write']));
    const f = await fixture({ access });
    await expect(f.run()).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining(name) });
    expect((await f.calls()).map((call) => call.args[0])).toEqual(['whoami', 'access']);
  }, 120_000);

  it('refuses missing package access with explicit first-publication guidance', async () => {
    const names = (await fixture()).packages;
    const f = await fixture({ access: Object.fromEntries(names.filter((name) => name !== 'create-vura').map((name) => [name, 'read-write'])) });
    await expect(f.run()).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('first publication') });
    expect((await f.calls()).map((call) => call.args[0])).toEqual(['whoami', 'access']);
  }, 120_000);

  it('checks identity-level access for every package before packing or publishing', async () => {
    const f = await fixture();
    const result = await f.run();
    expect(result.stdout).toContain('token restrictions and package 2FA policy still apply');
    const calls = await f.calls();
    expect(calls.slice(0, 2)).toEqual([
      { tool: 'npm', args: ['whoami'] },
      { tool: 'npm', args: ['access', 'list', 'packages', 'release-tester', '--json'] },
    ]);
    expect(calls.slice(2, 2 + f.packages.length).map((call) => call.args[0])).toEqual(f.packages.map(() => 'view'));
    expect(calls.filter((call) => call.args[0] === 'publish')).toHaveLength(f.packages.length);
  }, 120_000);

  it('keeps dry-run credential-free and never sends a real publish', async () => {
    const f = await fixture({ accessError: true });
    await f.run(['--dry-run']);
    const calls = await f.calls();
    expect(calls.some((call) => ['access', 'whoami'].includes(call.args[0]))).toBe(false);
    const publish = calls.filter((call) => call.args[0] === 'publish');
    expect(publish).toHaveLength(f.packages.length);
    expect(publish.every((call) => call.args.includes('--dry-run'))).toBe(true);
  }, 120_000);
});
