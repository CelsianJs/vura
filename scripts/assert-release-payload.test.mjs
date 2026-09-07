import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { assertReleasePayload } from './assert-release-payload.mjs';
import { publishPackages } from './package-list.mjs';

const dirs = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'vura-recovery-payload-'));
  dirs.push(dir);
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--quiet');
  git('config', 'user.name', 'Release Fixture');
  git('config', 'user.email', 'release@example.invalid');
  const put = async (name, body) => { await mkdir(dirname(join(dir, name)), { recursive: true }); await writeFile(join(dir, name), body); };
  const commit = () => { git('add', '.'); git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture'); return git('rev-parse', 'HEAD'); };
  for (const path of publishPackages) await put(`${path}/package.json`, '{"version":"0.8.3"}');
  await put('packages/core/src/marker.js', 'export const marker = true;');
  const sha = commit();
  git('-c', 'tag.gpgsign=false', 'tag', 'v0.8.3');
  return { dir, git, put, commit, sha };
}

it('accepts reviewed tooling changes while preserving immutable release inputs', async () => {
  const f = await fixture();
  await f.put('scripts/publish-packages.mjs', '// repaired tooling');
  await f.put('.depot/workflows/publish-recovery.yml', 'name: recovery');
  f.commit();
  expect(assertReleasePayload('v0.8.3', f.sha, f.dir).commit).toBe(f.sha);
});

it.each(['packages/core/package.json', 'pnpm-lock.yaml', 'scripts/package-list.mjs', 'docs-site/build.mjs', '.npmrc', ' README.md'])('rejects changed payload/build input %s', async (name) => {
  const f = await fixture();
  await f.put(name, 'changed');
  f.commit();
  expect(() => assertReleasePayload('v0.8.3', f.sha, f.dir)).toThrow('Tagged release payload changed');
});

it('rejects dirty checkout, mismatched tag identity and invalid refs', async () => {
  const f = await fixture();
  expect(() => assertReleasePayload('v0.8.3;echo bad', f.sha, f.dir)).toThrow('stable vX.Y.Z');
  expect(() => assertReleasePayload('v0.8.3', 'main', f.dir)).toThrow('full immutable');
  expect(() => assertReleasePayload('v0.8.3', '0'.repeat(40), f.dir)).toThrow('does not match');
  f.git('-c', 'tag.gpgsign=false', 'tag', 'v0.8.4');
  expect(() => assertReleasePayload('v0.8.4', f.sha, f.dir)).toThrow('does not match release tag');
  await f.put('untracked', 'dirty');
  expect(() => assertReleasePayload('v0.8.3', f.sha, f.dir)).toThrow('clean checkout');
});

it('rejects moving tagged input to an otherwise allowed tooling path', async () => {
  const f = await fixture();
  f.git('mv', 'packages/core/src/marker.js', 'README.md');
  f.commit();
  expect(() => assertReleasePayload('v0.8.3', f.sha, f.dir)).toThrow('Tagged release payload changed');
});
