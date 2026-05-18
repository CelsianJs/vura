/**
 * `vura manifest` — Print the route manifest for debugging.
 *
 * Scans the project's src/api/ and src/pages/ directories
 * and outputs the discovered routes with their kinds and methods.
 */

import { buildManifest } from '@celsian/vura-core';
import { loadConfig } from '../config-loader.js';

export async function manifestCommand(args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const config = await loadConfig(projectRoot);

  console.log('\n  Scanning routes...\n');

  const manifest = await buildManifest(config.root ?? projectRoot);

  // API routes
  if (manifest.api.length > 0) {
    console.log('  API Routes:');
    for (const route of manifest.api) {
      const methods = route.methods.join(', ');
      console.log(`    ${route.kind.padEnd(12)} ${methods.padEnd(20)} ${route.urlPattern}`);
    }
    console.log();
  } else {
    console.log('  No API routes found in src/api/\n');
  }

  // Pages
  if (manifest.pages.length > 0) {
    console.log('  Pages:');
    for (const page of manifest.pages) {
      console.log(`    ${page.mode.padEnd(12)} ${page.urlPattern}`);
    }
    console.log();
  } else {
    console.log('  No pages found in src/pages/\n');
  }

  console.log(`  Total: ${manifest.api.length} API routes, ${manifest.pages.length} pages`);
  console.log(`  Timestamp: ${manifest.timestamp}\n`);

  // JSON output if --json flag
  if (args.includes('--json')) {
    console.log(JSON.stringify(manifest, null, 2));
  }
}
