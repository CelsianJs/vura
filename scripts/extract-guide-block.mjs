#!/usr/bin/env node
/**
 * extract-guide-block.mjs <guide.md> <lang>
 *
 * Reads a self-host guide markdown file and prints the contents of the
 * first fenced block with the given language tag to stdout.
 *
 * Usage:
 *   node scripts/extract-guide-block.mjs docs-site/pages/self-host/fly.md toml > app/fly.toml
 *
 * Exits non-zero and prints to stderr if no matching block is found.
 */

import { readFile } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFencedBlock } from './extract-guide-dockerfile.mjs';

// Only run CLI logic when executed directly (not when imported by tests)
const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  const [, , guidePath, lang] = process.argv;
  if (!guidePath || !lang) {
    console.error(
      'Usage: node scripts/extract-guide-block.mjs <guide.md> <lang>'
    );
    process.exit(1);
  }

  const absPath = isAbsolute(guidePath)
    ? guidePath
    : resolve(process.cwd(), guidePath);

  const source = await readFile(absPath, 'utf8');
  const content = extractFencedBlock(source, lang);

  if (!content) {
    console.error(`No \`\`\`${lang} block found in ${guidePath}`);
    process.exit(1);
  }

  process.stdout.write(content);
}
