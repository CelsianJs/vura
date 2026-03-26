#!/usr/bin/env node

/**
 * ThenJS CLI Entry Point
 *
 * Usage:
 *   then build     — Scan routes, generate manifests, bundle for deployment
 *   then deploy    — Deploy to configured provider (CF Workers, Lambda, etc.)
 *   then dev       — Start local dev server with HMR
 *   then manifest  — Print the route manifest (debug)
 */

import { run } from './index.js';

run(process.argv.slice(2)).catch((err: Error) => {
  console.error(`\n  ✘ ${err.message}\n`);
  process.exit(1);
});
