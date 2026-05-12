#!/usr/bin/env node

/**
 * Vura CLI Entry Point
 *
 * Usage:
 *   vura build     — Scan routes, generate manifests, bundle for deployment
 *   vura deploy    — Explain managed deployment availability (not in OSS CLI yet)
 *   vura dev       — Start local dev server with HMR
 *   vura manifest  — Print the route manifest (debug)
 */

import { run } from './index.js';

run(process.argv.slice(2)).catch((err: Error) => {
  console.error(`\n  ✘ ${err.message}\n`);
  process.exit(1);
});
