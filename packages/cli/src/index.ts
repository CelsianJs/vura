/**
 * Vura CLI
 *
 * Minimal CLI that wires together @celsian/vura-core's build pipeline
 * with project configuration and deployment providers.
 */

import { buildCommand } from './commands/build.js';
import { manifestCommand } from './commands/manifest.js';
import { deployCommand } from './commands/deploy.js';
import { devCommand } from './commands/dev.js';
import { adminCommand } from './commands/admin.js';
import { tasksCommand } from './commands/tasks.js';

const COMMANDS: Record<string, (args: string[]) => Promise<void>> = {
  build: buildCommand,
  manifest: manifestCommand,
  deploy: deployCommand,
  dev: devCommand,
  admin: adminCommand,
  tasks: tasksCommand,
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
  vura — Vura CLI

  Commands:
    dev         Start local development server
    build       Build the project for deployment
    deploy      Deploy the built project to the Vura platform
                  vura deploy [--prod] [--token <t>] [--api-url <u>]
    admin       Launch the admin dashboard
    manifest    Print the route manifest (debug)
    tasks       Manage and run task routes
                  vura tasks list
                  vura tasks run <name> [--input '<json>']

  Options:
    --help, -h  Show this help message
`);
}
