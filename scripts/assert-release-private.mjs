#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs';
import { publishPackages } from './package-list.mjs';

function findExamplePackageJsons(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const packageJsons = [];

  for (const entry of entries) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      packageJsons.push(...findExamplePackageJsons(path));
    } else if (entry.isFile() && entry.name === 'package.json') {
      packageJsons.push(path);
    }
  }

  return packageJsons;
}

const compilerNative = JSON.parse(readFileSync('packages/compiler-native/package.json', 'utf8'));
const failures = [];

if (compilerNative.private !== true) {
  failures.push('@then/compiler-native must remain private until native artifacts and publish policy are ready');
}

if (publishPackages.includes('packages/compiler-native')) {
  failures.push('scripts/package-list.mjs must not include packages/compiler-native in JS package publish list');
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

console.log('OK: private release assertions passed.');
