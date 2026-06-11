#!/usr/bin/env node
/**
 * use-adapter.mjs <target-dir> <cloudflare|lambda>
 *
 * Rewrites the scaffold's vura.config.js in <target-dir> to configure
 * the specified adapter, and ensures the adapter package is present in
 * package.json dependencies (pointing at the local file: tarball when
 * the tarball exists in .selfhost-tarballs/, otherwise the npm version).
 *
 * The generated vura.config.js matches the exact snippet shown in each
 * adapter's self-host guide so guide text and CI remain 1:1.
 *
 * Usage (CI cloudflare/lambda jobs — run after link-local-packages.mjs):
 *   node scripts/use-adapter.mjs app cloudflare
 *   node scripts/use-adapter.mjs app lambda
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, isAbsolute, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [, , targetDir, adapterName] = process.argv;
if (!targetDir || !adapterName) {
  console.error('Usage: node scripts/use-adapter.mjs <target-dir> <cloudflare|lambda>');
  process.exit(1);
}

const SUPPORTED = ['cloudflare', 'lambda'];
if (!SUPPORTED.includes(adapterName)) {
  console.error(`Unsupported adapter "${adapterName}". Supported: ${SUPPORTED.join(', ')}`);
  process.exit(1);
}

const absTarget = isAbsolute(targetDir) ? targetDir : resolve(process.cwd(), targetDir);
if (!existsSync(absTarget)) {
  console.error(`Target directory does not exist: ${absTarget}`);
  process.exit(1);
}

const adapterPackage = `@celsian/vura-adapter-${adapterName}`;
const adapterFn = adapterName === 'cloudflare' ? 'cloudflareAdapter' : 'lambdaAdapter';

// The exact config snippets from the guides:
const configs = {
  cloudflare: `import { defineConfig } from '@celsian/vura-core';
import { cloudflareAdapter } from '@celsian/vura-adapter-cloudflare';

export default defineConfig({
  adapter: cloudflareAdapter({
    name: 'my-worker',
  }),
});
`,
  lambda: `import { defineConfig } from '@celsian/vura-core';
import { lambdaAdapter } from '@celsian/vura-adapter-lambda';

export default defineConfig({
  adapter: lambdaAdapter({
    region: 'us-east-1',
    memory: 256,
    timeout: 30,
    stackName: 'my-vura-app',
    runtime: 'nodejs22.x',
    architecture: 'x86_64',
  }),
});
`,
};

// Write the new vura.config.js
// The scaffold may have created vura.config.js (not .ts) — check both
const configJs = join(absTarget, 'vura.config.js');
const configTs = join(absTarget, 'vura.config.ts');
const configPath = existsSync(configTs) ? configTs : configJs;

await writeFile(configPath, configs[adapterName]);
console.log(`Wrote ${adapterName} adapter config to ${configPath}`);

// Ensure the adapter package is in dependencies.
// If link-local-packages.mjs already added a file: tarball, this is a no-op
// for that dep.  Otherwise add the package from npm.
const pkgJsonPath = join(absTarget, 'package.json');
const pkgJson = JSON.parse(await readFile(pkgJsonPath, 'utf8'));

if (!pkgJson.dependencies) pkgJson.dependencies = {};

// Check if a local tarball was already linked
const alreadyLinked = typeof pkgJson.dependencies[adapterPackage] === 'string' &&
  pkgJson.dependencies[adapterPackage].startsWith('file:');

if (!alreadyLinked) {
  // Try to find a local tarball from link-local-packages.
  // Check inside the app dir first (default — portable across runners),
  // then fall back to the workspace root's .selfhost-tarballs/.
  // pnpm pack names tarballs like: celsian-vura-adapter-cloudflare-0.4.0.tgz
  // Resolve workspace root from the script's location (scripts/ → root) so
  // this works even when called from a different working directory.
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const tarballPrefix = adapterPackage.replace(/\//g, '-').replace(/^@/, '');
  let foundTarball = null;

  const { readdirSync } = await import('node:fs');
  const candidateDirs = [
    join(absTarget, '.selfhost-tarballs'),  // inside app (artifact-portable)
    join(root, '.selfhost-tarballs'),        // workspace root fallback
  ];

  for (const tarballDir of candidateDirs) {
    if (!existsSync(tarballDir)) continue;
    const tarballs = readdirSync(tarballDir);
    const match = tarballs.find(f => f.startsWith(tarballPrefix) && f.endsWith('.tgz'));
    if (match) {
      foundTarball = join(tarballDir, match);
      break;
    }
  }

  if (foundTarball) {
    pkgJson.dependencies[adapterPackage] = `file:${foundTarball}`;
    console.log(`Linked local tarball for ${adapterPackage}: ${foundTarball}`);
  } else {
    // Fall back to the workspace version
    const adapterPkgPath = join(root, `packages/adapter-${adapterName}`, 'package.json');
    const adapterVersion = existsSync(adapterPkgPath)
      ? JSON.parse(await readFile(adapterPkgPath, 'utf8')).version
      : 'latest';
    pkgJson.dependencies[adapterPackage] = adapterVersion;
    console.log(`Added ${adapterPackage}@${adapterVersion} to dependencies`);
  }

  await writeFile(pkgJsonPath, `${JSON.stringify(pkgJson, null, 2)}\n`);
}

console.log(`OK: ${adapterName} adapter configured in ${absTarget}`);
