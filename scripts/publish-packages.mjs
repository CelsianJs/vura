#!/usr/bin/env node
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { publishPackages } from './package-list.mjs';

const root = process.cwd();
const dryRun = process.argv.includes('--dry-run') || process.env.VURA_PUBLISH_DRY_RUN === '1' || process.env.NPM_PUBLISH_DRY_RUN === '1';
const distTag = process.env.NPM_DIST_TAG || 'latest';

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd ?? root,
    encoding: 'utf8',
    stdio: opts.stdio ?? 'inherit',
    env: process.env,
  });
  if (res.status !== 0) {
    const details = [res.stdout, res.stderr].filter(Boolean).join('\n');
    throw new Error(`${cmd} ${args.join(' ')} failed with ${res.status}${details ? `\n${details}` : ''}`);
  }
  return res;
}

function packageSpec(name, version) {
  return `${name}@${version}`;
}

function validateDistTag(tag) {
  if (!/^[a-z][a-z0-9._-]*$/i.test(tag)) {
    throw new Error(`Invalid npm dist-tag: ${tag}`);
  }
  if (/^v?\d+(\.\d+){0,2}$/.test(tag)) {
    throw new Error(`Refusing semver-looking npm dist-tag: ${tag}`);
  }
}


function scopedPackageName(name) {
  const match = /^(@[^/]+)\//.exec(name);
  return match?.[1] ?? null;
}

function assertNpmIdentity() {
  const res = spawnSync('npm', ['whoami'], {
    cwd: root,
    encoding: 'utf8',
    stdio: 'pipe',
    env: process.env,
  });
  if (res.status !== 0 || !res.stdout.trim()) {
    const output = `${res.stdout}\n${res.stderr}`.trim();
    throw new Error(`Unable to confirm npm identity before publish${output ? `\n${output}` : ''}`);
  }
  return res.stdout.trim();
}

function assertScopePublishAuthority(plannedPackages) {
  const scopes = [...new Set(plannedPackages.map((item) => scopedPackageName(item.name)).filter(Boolean))];
  if (scopes.length === 0) return;

  const identity = assertNpmIdentity();
  for (const scope of scopes) {
    const res = spawnSync('npm', ['access', 'list', 'packages', scope, '--json'], {
      cwd: root,
      encoding: 'utf8',
      stdio: 'pipe',
      env: process.env,
    });
    if (res.status !== 0) {
      const output = `${res.stdout}\n${res.stderr}`.trim();
      throw new Error(`npm user ${identity} does not have confirmed access to ${scope}; refusing publish before namespace authority is resolved\n${output}`);
    }
    try {
      JSON.parse(res.stdout || '{}');
    } catch {
      throw new Error(`npm access preflight for ${scope} returned non-JSON output; refusing publish before namespace authority is resolved\n${res.stdout}`);
    }
  }
  console.log(`npm namespace authority preflight passed for ${scopes.join(', ')} as ${identity}`);
}

function assertVersionNotPublished(name, version) {
  const spec = packageSpec(name, version);
  const res = spawnSync('npm', ['view', spec, 'version', '--json'], {
    cwd: root,
    encoding: 'utf8',
    stdio: 'pipe',
    env: process.env,
  });
  if (res.status === 0 && res.stdout.trim()) {
    throw new Error(`${spec} is already published; refusing to overwrite release history`);
  }
  const output = `${res.stdout}\n${res.stderr}`;
  if (!/E404|404 Not Found|is not in this registry|not found/i.test(output)) {
    throw new Error(`Unable to confirm ${spec} is unpublished before publish\n${output.trim()}`);
  }
}

validateDistTag(distTag);

const planned = [];
for (const pkg of publishPackages) {
  const packageJson = JSON.parse(await readFile(join(root, pkg, 'package.json'), 'utf8'));
  if (packageJson.private) continue;
  if (!packageJson.name || !packageJson.version) {
    throw new Error(`${pkg}/package.json must define name and version before publish`);
  }
  planned.push({ pkg, name: packageJson.name, version: packageJson.version });
}

if (planned.length === 0) {
  throw new Error('No publishable packages found');
}

console.log(`Publish plan: ${planned.length} package(s), dist-tag=${distTag}, dry-run=${dryRun ? 'yes' : 'no'}`);
if (!dryRun) assertScopePublishAuthority(planned);
for (const item of planned) {
  assertVersionNotPublished(item.name, item.version);
}

function pnpmPack(pkg, outDir) {
  const res = run('pnpm', ['pack', '--pack-destination', outDir], { cwd: join(root, pkg), stdio: 'pipe' });
  const file = res.stdout.trim().split(/\r?\n/).filter(Boolean).pop();
  if (!file) throw new Error(`pnpm pack did not report a tarball for ${pkg}`);
  return isAbsolute(file) ? file : join(outDir, file);
}

const tmp = await mkdtemp(join(tmpdir(), 'vura-publish-'));
try {
  const published = [];
  for (const item of planned) {
    console.log(`${dryRun ? 'Dry-run publishing' : 'Publishing'} ${packageSpec(item.name, item.version)} from ${item.pkg}`);
    const tarball = pnpmPack(item.pkg, tmp);
    const args = ['publish', tarball, '--access', 'public', '--tag', distTag];
    if (dryRun) args.push('--dry-run');
    // Provenance is EXPLICIT OPT-IN (NPM_PROVENANCE=1), set only by the
    // GitHub-hosted fallback publisher. Env sniffing does not work: Depot CI
    // emulates the full GHA env INCLUDING ACTIONS_ID_TOKEN_REQUEST_URL, but
    // Sigstore rejects its identity token (400 CA_CREATE_SIGNING_CERTIFICATE_
    // ERROR — failed the v0.5.6 publish). Depot releases ship without
    // provenance. Do not republish an immutable version to "attach" provenance
    // later; only future GitHub-hosted fallback publishes of not-yet-published
    // versions can include npm provenance.
    if (!dryRun && process.env.NPM_PROVENANCE === '1' && process.env.ACTIONS_ID_TOKEN_REQUEST_URL) {
      args.push('--provenance');
    }
    run('npm', args);
    published.push(packageSpec(item.name, item.version));
  }

  console.log(`${dryRun ? 'Dry-run publish' : 'Publish'} complete:`);
  for (const spec of published) {
    console.log(`  - ${spec}`);
  }
} finally {
  await rm(tmp, { recursive: true, force: true });
}
