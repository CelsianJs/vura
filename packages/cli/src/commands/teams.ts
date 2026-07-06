/**
 * `vura teams list|create <name>` — manage Vura Platform teams.
 *
 * list    GET  /v1/teams  — teams the authenticated user belongs to.
 * create  POST /v1/teams  — create a team. The API requires a slug, so one is
 *         derived from the name (matching `vura-client.ts`'s `slugify`,
 *         which mirrors how the API itself derives slugs) unless --slug is given.
 *
 * Flags:
 *   --token <t>       API token (else VURA_TOKEN, else ~/.vura/credentials)
 *   --api-url <url>   API base URL (else VURA_API_URL, else https://api.vura.io)
 *   --slug <slug>     (create only) Explicit slug instead of deriving one from <name>.
 */

import { formatApiError, resolveApiUrl, resolveToken, slugify, vuraApiRequest } from '../vura-client.js';
import { listTeams } from './team-resolution.js';

interface TeamsFlags {
  token?: string;
  apiUrl?: string;
  slug?: string;
}

function parseFlags(args: string[]): { flags: TeamsFlags; positionals: string[] } {
  const flags: TeamsFlags = {};
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
      case '--slug':
        flags.slug = args[++i];
        break;
      default:
        if (!arg.startsWith('--')) positionals.push(arg);
        break;
    }
  }
  return { flags, positionals };
}

function printTeamsTable(teams: { name: string; slug: string; role?: string; plan?: string }[]): void {
  if (teams.length === 0) {
    console.log('  No teams found. Run `vura teams create <name>` to create one.');
    return;
  }
  console.log('\n  Teams:\n');
  const slugWidth = Math.max(4, ...teams.map((t) => t.slug.length));
  const nameWidth = Math.max(4, ...teams.map((t) => t.name.length));
  for (const t of teams) {
    console.log(`    ${t.slug.padEnd(slugWidth)}  ${t.name.padEnd(nameWidth)}  ${(t.role ?? '').padEnd(8)} ${t.plan ?? ''}`);
  }
  console.log();
}

async function listCommand(apiUrl: string, token: string): Promise<void> {
  const teams = await listTeams(apiUrl, token);
  printTeamsTable(teams);
}

async function createCommand(apiUrl: string, token: string, name: string, slugFlag?: string): Promise<void> {
  const slug = slugFlag || slugify(name);
  const body = (await vuraApiRequest(apiUrl, '/v1/teams', {
    method: 'POST',
    token,
    body: { name, slug },
  })) as { data?: { id: string; name: string; slug: string } };

  const team = body?.data;
  if (!team) {
    console.error('  Team creation succeeded but the response was missing team data.');
    process.exitCode = 1;
    return;
  }

  console.log(`\n  Created team "${team.name}" (${team.slug}).`);
  console.log(`  Team id: ${team.id}\n`);
}

export async function teamsCommand(args: string[]): Promise<void> {
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
      await listCommand(apiUrl, token);
      return;
    }

    if (subcommand === 'create') {
      const name = positionals[0];
      if (!name) {
        console.error('  Usage: vura teams create <name> [--slug <slug>]');
        process.exitCode = 1;
        return;
      }
      await createCommand(apiUrl, token, name, flags.slug);
      return;
    }
  } catch (err) {
    console.error(`  ${formatApiError(err)}`);
    process.exitCode = 1;
    return;
  }

  console.error(`  Unknown subcommand: vura teams ${subcommand ?? ''}`);
  console.error('  Usage:');
  console.error('    vura teams list');
  console.error('    vura teams create <name> [--slug <slug>]');
  process.exitCode = 1;
}
