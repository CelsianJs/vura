/**
 * `vura tasks list|run <name>` — CLI interface for task routes.
 *
 * list   Scan the project's task routes and print their names and schedules.
 * run    Invoke a task by name immediately, with optional JSON input, using
 *        the same runTaskOnce semantics as the server (retry + timeout).
 *
 * Exit-code seam: on failure (unknown task, handler throws, failed result)
 * this command sets process.exitCode = 1 and returns normally — it never calls
 * process.exit() directly. This lets vitest keep running while still signalling
 * the right exit code to the shell via the CLI entry point.
 */

import { join } from 'node:path';
import { buildManifest, runTaskOnce, buildTaskEnvelope } from '@celsian/vura-core';
import { importRouteModule } from './shared.js';

// ─── Name helpers ────────────────────────────────────────────────────────────

/**
 * Derive a human-readable task name from a manifest urlPattern.
 * "/api/report"      → "report"
 * "/api/jobs/notify" → "jobs.notify"
 */
export function taskNameFromPattern(urlPattern: string): string {
  return urlPattern.replace(/^\/api\//, '').replace(/\//g, '.');
}

// ─── Subcommands ─────────────────────────────────────────────────────────────

async function listTasks(projectRoot: string): Promise<void> {
  const manifest = await buildManifest(projectRoot);
  const taskRoutes = manifest.api.filter((r) => r.kind === 'task');

  if (taskRoutes.length === 0) {
    console.log('  No task routes found in src/api/');
    return;
  }

  console.log('\n  Task routes:\n');
  for (const route of taskRoutes) {
    const name = taskNameFromPattern(route.urlPattern);
    const schedule = route.config.schedule as string | undefined;
    const suffix = schedule ? `  (cron: ${schedule})` : '';
    console.log(`    ${name}${suffix}`);
  }
  console.log();
}

async function runTask(projectRoot: string, taskName: string, rawInput: string | undefined): Promise<void> {
  const manifest = await buildManifest(projectRoot);
  const taskRoutes = manifest.api.filter((r) => r.kind === 'task');

  // Find matching route
  const route = taskRoutes.find((r) => taskNameFromPattern(r.urlPattern) === taskName);
  if (!route) {
    const available = taskRoutes.map((r) => taskNameFromPattern(r.urlPattern));
    console.error(`  Unknown task: "${taskName}"`);
    if (available.length > 0) {
      console.error(`  Available tasks: ${available.join(', ')}`);
    } else {
      console.error('  No task routes found in src/api/');
    }
    process.exitCode = 1;
    return;
  }

  // Parse input
  let input: unknown = undefined;
  if (rawInput !== undefined) {
    try {
      input = JSON.parse(rawInput);
    } catch {
      console.error(`  Invalid JSON for --input: ${rawInput}`);
      process.exitCode = 1;
      return;
    }
  }

  // Load the module
  const mod = await importRouteModule(projectRoot, route.filePath);

  // Validate that POST is a function
  if (typeof mod.POST !== 'function') {
    console.error(`  Task file "${route.filePath}" does not export a POST function`);
    process.exitCode = 1;
    return;
  }

  const result = await runTaskOnce(
    {
      name: taskName,
      config: {
        retries: typeof route.config.retries === 'number' ? route.config.retries : 0,
        timeout: typeof route.config.timeout === 'number' ? route.config.timeout : 30_000,
      },
      handler: mod.POST as (ctx: { attempt: number; input: unknown }) => unknown,
      // Phase 1: validate --input against the task's optional `input` schema.
      inputSchema: mod.input,
    },
    { input },
  );

  // A schema validation failure never ran the handler — print the standard
  // validation error body and exit 1.
  if (result.validationError) {
    console.error(JSON.stringify(result.validationError.body, null, 2));
    process.exitCode = 1;
    return;
  }

  // Print the additive run envelope ({ ok, taskName, attempts, result? }) plus
  // the legacy status/error fields so existing consumers keep working.
  const envelope = buildTaskEnvelope(taskName, result);
  const output: Record<string, unknown> = { ...envelope, status: result.status };
  if (result.error !== undefined) output.error = result.error;
  console.log(JSON.stringify(output, null, 2));

  if (result.status === 'failed') {
    process.exitCode = 1;
  }
}

// ─── Command entry ────────────────────────────────────────────────────────────

/**
 * @param args        CLI argument slice (everything after "tasks").
 * @param projectRoot Override the project root — defaults to process.cwd().
 *                    Exposed for testing so tests do not need process.chdir()
 *                    (which is process-global and unsafe in concurrent workers).
 */
export async function tasksCommand(args: string[], projectRoot?: string): Promise<void> {
  const root = projectRoot ?? process.cwd();
  const subcommand = args[0];

  if (subcommand === 'list') {
    await listTasks(root);
    return;
  }

  if (subcommand === 'run') {
    const taskName = args[1];
    if (!taskName) {
      console.error('  Usage: vura tasks run <name> [--input \'<json>\']');
      process.exitCode = 1;
      return;
    }

    // Parse --input flag
    const inputFlagIdx = args.indexOf('--input');
    if (inputFlagIdx !== -1 && args[inputFlagIdx + 1] === undefined) {
      console.error("  --input requires a JSON value, e.g. --input '{\"day\":\"mon\"}'");
      process.exitCode = 1;
      return;
    }
    const rawInput = inputFlagIdx !== -1 ? args[inputFlagIdx + 1] : undefined;

    await runTask(root, taskName, rawInput);
    return;
  }

  // Unknown subcommand
  console.error(`  Unknown subcommand: vura tasks ${subcommand ?? ''}`);
  console.error('  Usage:');
  console.error('    vura tasks list');
  console.error("    vura tasks run <name> [--input '<json>']");
  process.exitCode = 1;
}
