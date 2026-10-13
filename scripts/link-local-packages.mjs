#!/usr/bin/env node
/**
 * link-local-packages.mjs <target-dir>
 *
 * Rewrites all @celsian/vura-* and create-vura dependencies in the
 * target directory's package.json to file: tarballs produced by
 * `pnpm pack` in this workspace.  This lets CI test today's code
 * instead of the published npm versions.
 *
 * By default, tarballs are packed into <target-dir>/.selfhost-tarballs/
 * and file: references are written as relative paths.  This makes the
 * artifact self-contained — file: paths survive being downloaded to a
 * different runner directory.
 *
 * Set TARBALL_DIR env to override the tarball output directory.
 * When TARBALL_DIR is an absolute path, file: refs will be absolute too.
 *
 * Usage (CI scaffold job):
 *   node scripts/link-local-packages.mjs /tmp/app
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, dirname, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { publishPackages } from './package-list.mjs';

const [, , targetDir] = process.argv;
if (!targetDir) {
  console.error('Usage: node scripts/link-local-packages.mjs <target-dir>');
  process.exit(1);
}

const absTarget = isAbsolute(targetDir) ? targetDir : resolve(process.cwd(), targetDir);
if (!existsSync(absTarget)) {
  console.error(`Target directory does not exist: ${absTarget}`);
  process.exit(1);
}

// Resolve the workspace root from the script's own location (scripts/ → root).
// This ensures pnpm pack runs against the correct packages/ directory even when
// the caller runs the script from a different working directory (e.g. cd /tmp).
const root = dirname(dirname(fileURLToPath(import.meta.url)));

// Default: tarballs inside the target dir so the artifact is self-contained
// and file: paths survive download to a different runner.
const tarballDirRaw = process.env.TARBALL_DIR;
const tarballDir = tarballDirRaw
  ? (isAbsolute(tarballDirRaw) ? tarballDirRaw : resolve(root, tarballDirRaw))
  : join(absTarget, '.selfhost-tarballs');

await mkdir(tarballDir, { recursive: true });

/** Run pnpm pack for a package, returning the absolute tarball path. */
function packPackage(pkgRelPath) {
  const res = spawnSync('pnpm', ['pack', '--pack-destination', tarballDir], {
    cwd: join(root, pkgRelPath),
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (res.status !== 0) {
    throw new Error(
      `pnpm pack failed for ${pkgRelPath}:\n${res.stdout}\n${res.stderr}`
    );
  }
  const lines = res.stdout.trim().split(/\r?\n/).filter(Boolean);
  const tarball = lines[lines.length - 1];
  if (!tarball) throw new Error(`pnpm pack produced no output for ${pkgRelPath}`);
  return isAbsolute(tarball) ? tarball : join(tarballDir, tarball);
}

/** Convert an absolute tarball path to a file: reference string.
 *  If the tarball is inside absTarget, use a relative path so the
 *  artifact is portable.  Otherwise use the absolute path.
 */
function toFileRef(tarball) {
  // Check if the tarball is within the target directory
  const rel = relative(absTarget, tarball);
  if (rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
    // Relative to the target dir — portable across runner machines
    return `file:./${rel}`;
  }
  return `file:${tarball}`;
}

// Build map of package name → tarball path
const tarballsByName = new Map();
const packageMetadataByName = new Map();
for (const pkgRelPath of publishPackages) {
  const pkgJsonPath = join(root, pkgRelPath, 'package.json');
  const pkgJson = JSON.parse(await readFile(pkgJsonPath, 'utf8'));
  if (pkgJson.private) continue;
  const tarball = packPackage(pkgRelPath);
  tarballsByName.set(pkgJson.name, tarball);
  packageMetadataByName.set(pkgJson.name, pkgJson);
}

// Rewrite target package.json
const targetPkgJsonPath = join(absTarget, 'package.json');
const targetPkgJson = JSON.parse(await readFile(targetPkgJsonPath, 'utf8'));

let rewroteCount = 0;
const consumerDependencySections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
for (const section of consumerDependencySections) {
  if (!targetPkgJson[section]) continue;
  for (const [name, tarball] of tarballsByName) {
    if (name in targetPkgJson[section]) {
      targetPkgJson[section][name] = toFileRef(tarball);
      rewroteCount++;
    }
  }
}

// Local tarballs can introduce new internal transitive dependencies that the
// published package at the same version does not yet declare. npm follows nested
// file: package metadata for these unpublished candidates, but pnpm resolves the
// tarball's bare semver internal dependencies from the registry unless the
// disposable consumer explicitly pins the candidate closure. Add those internal
// runtime edges as direct file dependencies so pnpm, npm, and linked smoke
// installs all test the same local package graph instead of falling back to a
// stale or missing registry artifact.
targetPkgJson.dependencies ??= {};
const localRoots = new Set(
  consumerDependencySections.flatMap((section) =>
    Object.keys(targetPkgJson[section] ?? {}).filter((name) => tarballsByName.has(name)),
  ),
);
const queue = [...localRoots];
if (localRoots.size > 0) {
  targetPkgJson.pnpm ??= {};
  targetPkgJson.pnpm.overrides ??= {};
  for (const packageName of localRoots) {
    targetPkgJson.pnpm.overrides[packageName] = toFileRef(tarballsByName.get(packageName));
  }
}
while (queue.length > 0) {
  const packageName = queue.shift();
  const metadata = packageMetadataByName.get(packageName);
  for (const section of ['dependencies', 'optionalDependencies']) {
    for (const dependencyName of Object.keys(metadata?.[section] ?? {})) {
      if (!tarballsByName.has(dependencyName) || localRoots.has(dependencyName)) continue;
      localRoots.add(dependencyName);
      queue.push(dependencyName);
      const fileRef = toFileRef(tarballsByName.get(dependencyName));
      targetPkgJson.dependencies[dependencyName] = fileRef;
      targetPkgJson.pnpm.overrides[dependencyName] = fileRef;
      rewroteCount++;
    }
  }
}

await writeFile(targetPkgJsonPath, `${JSON.stringify(targetPkgJson, null, 2)}\n`);
console.log(
  `OK: rewrote ${rewroteCount} dep(s) to local tarballs in ${targetPkgJsonPath}`
);
