#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const builtEntry = join(here, 'dist', 'bin.js');

if (!existsSync(builtEntry)) {
  console.error('\n  ✘ Vura CLI has not been built yet. Run `pnpm build` from the repository root, then retry.\n');
  process.exit(1);
}

await import(`file://${builtEntry}`);
