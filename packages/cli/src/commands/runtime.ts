import { buildManifest } from '@celsian/vura-core';
import { adviseRuntime } from './runtime-profile.js';

function hasJsonFlag(args: string[]): boolean {
  return args.includes('--json');
}

export async function runtimeCommand(args: string[], projectRoot?: string): Promise<void> {
  const subcommand = args[0];
  const root = projectRoot ?? process.cwd();

  if (subcommand !== 'advise') {
    console.error(`  Unknown subcommand: vura runtime ${subcommand ?? ''}`);
    console.error('  Usage: vura runtime advise [--json]');
    process.exitCode = 1;
    return;
  }

  const manifest = await buildManifest(root);
  const result = adviseRuntime(manifest);

  if (hasJsonFlag(args)) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.advice.length === 0) {
    console.log('  No runtime placement advice for current manifest.');
    return;
  }

  console.log('\n  Runtime advice:\n');
  for (const item of result.advice) {
    console.log(`    ${item.severity.toUpperCase().padEnd(4)} ${item.pattern} -> ${item.recommendation}`);
    console.log(`         ${item.reason}`);
    if (item.nextCommand) {
      console.log(`         next: ${item.nextCommand}`);
    }
  }
  console.log();
}
