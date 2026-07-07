#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs';
import { publishPackages } from './package-list.mjs';

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.then-dev-cache']);

function findExamplePackageJsons(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const packageJsons = [];

  for (const entry of entries) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) packageJsons.push(...findExamplePackageJsons(path));
    } else if (entry.isFile() && entry.name === 'package.json') {
      packageJsons.push(path);
    }
  }

  return packageJsons;
}

const compilerNative = JSON.parse(readFileSync('packages/compiler-native/package.json', 'utf8'));
const failures = [];
const publishPackageSet = new Set(publishPackages);
const privatePackageNames = new Set();

for (const packageJsonPath of findExamplePackageJsons('packages')) {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  if (packageJson.private === true && packageJson.name) privatePackageNames.add(packageJson.name);
}

if (compilerNative.private !== true) {
  failures.push('@celsian/vura-compiler-native must remain private until native artifacts and publish policy are ready');
}

if (publishPackageSet.has('packages/compiler-native')) {
  failures.push('scripts/package-list.mjs must not include packages/compiler-native in JS package publish list');
}

for (const packageJsonPath of findExamplePackageJsons('packages')) {
  const packageDir = packageJsonPath.replace(/\/package\.json$/, '');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  if (packageJson.private === true) continue;
  if (!publishPackageSet.has(packageDir)) {
    failures.push(`${packageJsonPath} (${packageJson.name || '<unnamed>'}) is not in scripts/package-list.mjs`);
  }
}

for (const packageDir of publishPackages) {
  let packageJson;
  try {
    packageJson = JSON.parse(readFileSync(`${packageDir}/package.json`, 'utf8'));
  } catch {
    failures.push(`${packageDir}/package.json is listed for publish but was not found`);
    continue;
  }
  if (packageJson.private === true) {
    failures.push(`${packageDir}/package.json (${packageJson.name || '<unnamed>'}) is listed for publish but private`);
  }

  for (const section of ['dependencies', 'optionalDependencies']) {
    for (const depName of Object.keys(packageJson[section] || {})) {
      if (privatePackageNames.has(depName)) {
        failures.push(`${packageDir}/package.json (${packageJson.name || '<unnamed>'}) must not ship an install-time ${section} entry for private package ${depName}`);
      }
    }
  }
}

for (const packageJsonPath of findExamplePackageJsons('examples')) {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  if (packageJson.private !== true) {
    failures.push(`${packageJsonPath} must be private`);
  }
}

if (failures.length > 0) {
  console.error('Release private-package assertions failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`OK: private release assertions passed for ${publishPackages.length} publish packages.`);
