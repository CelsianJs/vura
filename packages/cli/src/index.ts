/**
 * ThenJS CLI
 *
 * Minimal CLI that wires together @celsian/then-core's build pipeline
 * with project configuration and deployment providers.
 */

import { buildCommand } from './commands/build.js';
import { manifestCommand } from './commands/manifest.js';
import { deployCommand } from './commands/deploy.js';
import { devCommand } from './commands/dev.js';
import { adminCommand } from './commands/admin.js';

const COMMANDS: Record<string, (args: string[]) => Promise<void>> = {
  build: buildCommand,
  manifest: manifestCommand,
  deploy: deployCommand,
  dev: devCommand,
  admin: adminCommand,
};

export async function run(args: string[]): Promise<void> {
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  const handler = COMMANDS[command];
  if (!handler) {
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
  }

  await handler(args.slice(1));
}

function printHelp(): void {
  console.log(`
  vura / thenjs — Vura CLI

  Commands:
    dev         Start local development server
    build       Build the project for deployment
    deploy      Explain managed deployment availability (not in OSS CLI yet)
    admin       Launch the admin dashboard
    manifest    Print the route manifest (debug)

  Options:
    --help, -h  Show this help message
`);
}
