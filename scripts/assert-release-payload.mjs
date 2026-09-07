#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { publishPackages } from './package-list.mjs';

// Recovery may repair the publisher and its evidence, never the tagged payload.
const toolingPaths = new Set([
  'scripts/publish-packages.mjs',
  'scripts/publish-packages.test.mjs',
  'scripts/assert-release-payload.mjs',
  'scripts/assert-release-payload.test.mjs',
  '.depot/workflows/publish-recovery.yml',
  'README.md',
  'CONTRIBUTING.md',
  'RELEASING.md',
]);

export function assertReleasePayload(tag, commit, cwd = process.cwd()) {
  if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag ?? '')) {
    throw new Error('VURA_RELEASE_TAG must be a stable vX.Y.Z tag.');
  }
  if (!/^[a-f0-9]{40}$/.test(commit ?? '')) {
    throw new Error('VURA_RELEASE_COMMIT must be the full immutable commit SHA.');
  }
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (git('status', '--porcelain').trim()) throw new Error('Recovery requires a clean checkout.');
  const resolved = git('rev-parse', '--verify', `refs/tags/${tag}^{commit}`).trim();
  if (resolved !== commit) throw new Error(`Release tag ${tag} does not match the supplied immutable commit.`);
  const changed = git('diff', '--name-only', '-z', commit, 'HEAD').split('\0').filter(Boolean);
  const forbidden = changed.filter((path) => !toolingPaths.has(path));
  if (forbidden.length) throw new Error(`Tagged release payload changed; refusing recovery: ${forbidden.join(', ')}`);
  for (const path of publishPackages) {
    const pkg = JSON.parse(git('show', `HEAD:${path}/package.json`));
    if (!pkg.private && pkg.version !== tag.slice(1)) throw new Error(`Package ${path} does not match release tag ${tag}.`);
  }
  return { tag, commit, toolingCommit: git('rev-parse', 'HEAD').trim(), changedFiles: changed };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(assertReleasePayload(process.env.VURA_RELEASE_TAG, process.env.VURA_RELEASE_COMMIT)));
}
