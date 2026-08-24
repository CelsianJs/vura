#!/usr/bin/env node

import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBuildMatrix } from './lib/runner.mjs';
import { selectMatrixSpecs } from './lib/spec.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

try {
  const args = parseArgs(process.argv.slice(2));
  const result = await runBuildMatrix({
    repoRoot,
    specs: selectMatrixSpecs(args.cells),
    outputRoot: args.fixturesRoot,
    buildTimeoutMs: args.cellTimeoutMs || process.env.VURA_BUILD_MATRIX_CELL_TIMEOUT_MS,
    bootstrapTimeoutMs: args.bootstrapTimeoutMs || process.env.VURA_BUILD_MATRIX_BOOTSTRAP_TIMEOUT_MS,
    onProgress: ({ id, phase, completed, total }) => {
      process.stderr.write(`[build-matrix] ${id} ${phase} ${completed}/${total}\n`);
    },
  });
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (args.output) await writeFile(args.output, serialized, 'utf8');
  process.stdout.write(serialized);
} catch (error) {
  process.stderr.write(`[build-matrix] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const parsed = { cells: 'all' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') continue;
    if (!['--cells', '--output', '--fixtures-root', '--cell-timeout-ms', '--bootstrap-timeout-ms'].includes(arg)) {
      throw new Error(`unknown argument: ${arg}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${arg}`);
    index += 1;
    if (arg === '--cells') parsed.cells = value;
    else if (arg === '--output') parsed.output = value;
    else if (arg === '--fixtures-root') parsed.fixturesRoot = value;
    else if (arg === '--cell-timeout-ms') parsed.cellTimeoutMs = value;
    else parsed.bootstrapTimeoutMs = value;
  }
  return parsed;
}
