#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { publishPackages } from './package-list.mjs';

const compilerNative = JSON.parse(readFileSync('packages/compiler-native/package.json', 'utf8'));
const failures = [];

if (compilerNative.private !== true) {
  failures.push('@then/compiler-native must remain private until native artifacts and publish policy are ready');
}

if (publishPackages.includes('packages/compiler-native')) {
  failures.push('scripts/package-list.mjs must not include packages/compiler-native in JS package publish list');
}

if (failures.length > 0) {
  console.error('Release private-package assertions failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log('OK: compiler-native remains private and excluded from JS package publish list.');
