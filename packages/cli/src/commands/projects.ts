/**
 * `vura projects list|create <name>` — manage Vura Platform projects.
 *
 * list    GET  /v1/projects?teamId=<id>       — projects in a team.
 * create  POST /v1/projects { name, teamId }  — create a project.
 *
 * Both need a team. `--team <id-or-slug>` resolves it (see
 * `team-resolution.ts`); if omitted, the caller's only team is used when
 * they have exactly one (true for every freshly registered account).
 *
 * `create` also links the current directory to the new project by writing
 * `.vura/project.json` (the same file `vura deploy` reads via
 * `vura-client.ts`'s `readProjectLink`) — but only when this looks like a
 * Vura project root (a `vura.config.*` is present) that isn't already linked,
 * so it never silently overwrites an existing link.
 *
 * Flags:
 *   --token <t>       API token (else VURA_TOKEN, else ~/.vura/credentials)
 *   --api-url <url>   API base URL (else VURA_API_URL, else https://api.vura.io)
 *   --team <id|slug>  Team to operate in (else the caller's only team)
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { formatApiError, readProjectLink, resolveApiUrl, resolveToken, vuraApiRequest, writeProjectLink } from '../vura-client.js';
import { resolveTeam, TeamResolutionError } from './team-resolution.js';

const CONFIG_FILES = ['vura.config.ts', 'vura.config.js', 'vura.config.mjs'];

interface ProjectsFlags {
  token?: string;
  apiUrl?: string;
  team?: string;
}

interface ProjectSummary {
  id: string;
  name: string;
  slug: string;
  teamId?: string;
  productionUrl?: string | null;
}

function parseFlags(args: string[]): { flags: ProjectsFlags; positionals: string[] } {
  const flags: ProjectsFlags = {};
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--token':
        flags.token = args[++i];
        break;
      case '--api-url':
        flags.apiUrl = args[++i];
        break;
      case '--team':
        flags.team = args[++i];
        break;
      default:
        if (!arg.startsWith('--')) positionals.push(arg);
        break;
    }
  }
  return { flags, positionals };
}

function looksLikeProjectRoot(root: string): boolean {
  return CONFIG_FILES.some((f) => existsSync(join(root, f)));
}

function printProjectsTable(projects: ProjectSummary[]): void {
  if (projects.length === 0) {
    console.log('  No projects found. Run `vura projects create <name>` to create one.');
    return;
  }
  console.log('\n  Projects:\n');
  const slugWidth = Math.max(4, ...projects.map((p) => p.slug.length));
  const nameWidth = Math.max(4, ...projects.map((p) => p.name.length));
  for (const p of projects) {
    console.log(`    ${p.slug.padEnd(slugWidth)}  ${p.name.padEnd(nameWidth)}  ${p.id}`);
  }
  console.log();
}

async function listCommand(apiUrl: string, token: string, teamFlag: string | undefined): Promise<void> {
  const team = await resolveTeam(apiUrl, token, teamFlag);
  const body = (await vuraApiRequest(apiUrl, `/v1/projects?teamId=${encodeURIComponent(team.id)}`, { token })) as {
    data?: ProjectSummary[];
  };
  printProjectsTable(body?.data ?? []);
}

async function createCommand(
  apiUrl: string,
  token: string,
  name: string,
  teamFlag: string | undefined,
  projectRoot: string,
): Promise<void> {
  const team = await resolveTeam(apiUrl, token, teamFlag);
  const body = (await vuraApiRequest(apiUrl, '/v1/projects', {
    method: 'POST',
    token,
    body: { name, teamId: team.id },
  })) as { data?: ProjectSummary };

  const project = body?.data;
  if (!project) {
    console.error('  Project creation succeeded but the response was missing project data.');
    process.exitCode = 1;
    return;
  }

  console.log(`\n  Created project "${project.name}" (${project.slug}) in team ${team.slug}.`);
  console.log(`  Project id: ${project.id}`);

  if (looksLikeProjectRoot(projectRoot) && !(await readProjectLink(projectRoot))) {
    await writeProjectLink(projectRoot, { projectId: project.id, teamId: team.id, teamSlug: team.slug });
    console.log(`  Linked this directory to ${project.slug} (.vura/project.json).\n`);
  } else {
    console.log('');
  }
}

export async function projectsCommand(args: string[], projectRoot: string = process.cwd()): Promise<void> {
  const subcommand = args[0];
  const { flags, positionals } = parseFlags(args.slice(1));

  const token = await resolveToken(flags.token);
  if (!token) {
    console.error('  Not authenticated. Run `vura login`, set VURA_TOKEN, or pass --token <token>.');
    process.exitCode = 1;
    return;
  }
  const apiUrl = resolveApiUrl(flags.apiUrl);

  try {
    if (subcommand === 'list') {
      await listCommand(apiUrl, token, flags.team);
      return;
    }

    if (subcommand === 'create') {
      const name = positionals[0];
      if (!name) {
        console.error('  Usage: vura projects create <name> [--team <id-or-slug>]');
        process.exitCode = 1;
        return;
      }
      await createCommand(apiUrl, token, name, flags.team, projectRoot);
      return;
    }
  } catch (err) {
    if (err instanceof TeamResolutionError) {
      console.error(`  ${err.message}`);
    } else {
      console.error(`  ${formatApiError(err)}`);
    }
    process.exitCode = 1;
    return;
  }

  console.error(`  Unknown subcommand: vura projects ${subcommand ?? ''}`);
  console.error('  Usage:');
  console.error('    vura projects list [--team <id-or-slug>]');
  console.error('    vura projects create <name> [--team <id-or-slug>]');
  process.exitCode = 1;
}
