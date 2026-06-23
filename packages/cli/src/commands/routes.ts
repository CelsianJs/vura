import { buildManifest } from '@celsian/vura-core';
import { inspectRuntime } from './runtime-profile.js';

function hasJsonFlag(args: string[]): boolean {
  return args.includes('--json');
}

export async function routesCommand(args: string[], projectRoot?: string): Promise<void> {
  const subcommand = args[0];
  const root = projectRoot ?? process.cwd();

  if (subcommand !== 'inspect') {
    console.error(`  Unknown subcommand: vura routes ${subcommand ?? ''}`);
    console.error('  Usage: vura routes inspect [--json]');
    process.exitCode = 1;
    return;
  }

  const manifest = await buildManifest(root);
  const inspection = inspectRuntime(manifest);

  if (hasJsonFlag(args)) {
    console.log(JSON.stringify(inspection, null, 2));
    return;
  }

  console.log('\n  Runtime routes:\n');
  for (const route of inspection.routes) {
    const methods = route.methods ? ` ${route.methods.join(',')}` : '';
    const schedule = route.schedule ? ` cron:${route.schedule}` : '';
    console.log(`    ${route.effectiveProfile.padEnd(10)} ${route.type.padEnd(4)}${methods.padEnd(10)} ${route.pattern}${schedule}`);
  }
  console.log();
  console.log(`  Total: ${inspection.routes.length} runtime entries`);
}
