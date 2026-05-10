#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const root = process.cwd();
const ignoredDirs = new Set(['.git', 'node_modules', 'dist', '.then-dev-cache', '.omx']);
const checkedExtensions = new Set(['.js', '.mjs', '.ts', '.tsx', '.json', '.md', '.yml', '.yaml']);
const failures = [];

function extname(file) {
  const match = /\.[^.]+$/.exec(file);
  return match ? match[0] : '';
}

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name)) await walk(join(dir, entry.name));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!checkedExtensions.has(extname(entry.name))) continue;
    await checkFile(join(dir, entry.name));
  }
}

async function checkFile(file) {
  const rel = relative(root, file);
  const text = await readFile(file, 'utf8');
  if (text.includes('\r')) failures.push(`${rel}: contains CRLF line endings`);
  if (text.length > 0 && !text.endsWith('\n')) failures.push(`${rel}: missing final newline`);
  text.split('\n').forEach((line, index) => {
    if (/[ \t]$/.test(line)) failures.push(`${rel}:${index + 1}: trailing whitespace`);
  });
}

await walk(root);
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('OK: style/static hygiene checks passed');
