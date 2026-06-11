#!/usr/bin/env node
/**
 * extract-guide-dockerfile.mjs <guide.md>
 *
 * Reads a self-host guide markdown file and prints the contents of the
 * first fenced ```dockerfile block to stdout.  This is how CI extracts
 * the canonical Dockerfile from the guide so guide text and CI script
 * are always identical — guides can't silently drift from CI.
 *
 * Usage:
 *   node scripts/extract-guide-dockerfile.mjs docs-site/pages/self-host/docker.md > app/Dockerfile
 *
 * Exits non-zero and prints to stderr if no dockerfile block is found.
 *
 * The extractFencedBlock helper is also exported for use by
 * extract-guide-block.mjs and its tests.
 */

import { readFile } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Extracts the first fenced block matching the given fence language.
 * @param {string} md - Markdown source
 * @param {string} lang - Fence language (e.g. "dockerfile", "toml")
 * @returns {string|null}
 */
export function extractFencedBlock(md, lang) {
  const langLower = lang.toLowerCase();
  // Match both ``` and ~~~ fences; case-insensitive on the language token.
  // The content between fences is captured as group 1.
  const pattern = new RegExp(
    `^[ \\t]*\`{3,}[ \\t]*${langLower}[ \\t]*\\r?\\n([\\s\\S]*?)^[ \\t]*\`{3,}[ \\t]*$`,
    'im'
  );
  const m = pattern.exec(md);
  return m ? m[1] : null;
}

// Only run CLI logic when executed directly (not when imported by tests)
const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  const [, , guidePath] = process.argv;
  if (!guidePath) {
    console.error(
      'Usage: node scripts/extract-guide-dockerfile.mjs <guide.md>'
    );
    process.exit(1);
  }

  const absPath = isAbsolute(guidePath)
    ? guidePath
    : resolve(process.cwd(), guidePath);

  const source = await readFile(absPath, 'utf8');
  const content = extractFencedBlock(source, 'dockerfile');

  if (!content) {
    console.error(`No \`\`\`dockerfile block found in ${guidePath}`);
    process.exit(1);
  }

  process.stdout.write(content);
}
