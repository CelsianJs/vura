/**
 * Shared "which team am I talking about" logic for `vura teams` and
 * `vura projects`. Both commands accept a `--team <id-or-slug>` flag, and
 * both need the same fallback when it's omitted: use the caller's only team
 * if they have exactly one (true for every freshly registered account, which
 * gets a personal team automatically), otherwise ask them to disambiguate.
 */

import { vuraApiRequest } from '../vura-client.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ResolvedTeam {
  id: string;
  slug: string;
  name: string;
}

interface TeamSummary {
  id: string;
  name: string;
  slug: string;
  role?: string;
  plan?: string;
}

/** Thrown for team-resolution failures the caller should print and exit(1) on. */
export class TeamResolutionError extends Error {}

/**
 * List the caller's teams via GET /v1/teams.
 */
export async function listTeams(apiUrl: string, token: string): Promise<TeamSummary[]> {
  const body = (await vuraApiRequest(apiUrl, '/v1/teams', { token })) as { data?: TeamSummary[] };
  return body?.data ?? [];
}

/**
 * Resolve a `--team` flag value (or its absence) to a concrete team id.
 *
 *   - UUID-shaped input is used directly as the team id (no round trip).
 *   - Non-UUID input is treated as a slug and looked up via GET /v1/teams/:slug.
 *   - No input at all falls back to the caller's only team, if they have
 *     exactly one; otherwise throws {@link TeamResolutionError} listing the
 *     choices so the CLI can print a helpful "pick one of: a, b, c" error.
 */
export async function resolveTeam(apiUrl: string, token: string, teamFlag: string | undefined): Promise<ResolvedTeam> {
  if (teamFlag && UUID_RE.test(teamFlag)) {
    return { id: teamFlag, slug: teamFlag, name: teamFlag };
  }

  if (teamFlag) {
    const body = (await vuraApiRequest(apiUrl, `/v1/teams/${encodeURIComponent(teamFlag)}`, { token })) as {
      data?: TeamSummary;
    };
    if (!body?.data) {
      throw new TeamResolutionError(`Team "${teamFlag}" not found.`);
    }
    return { id: body.data.id, slug: body.data.slug, name: body.data.name };
  }

  const teams = await listTeams(apiUrl, token);
  if (teams.length === 1) {
    return { id: teams[0].id, slug: teams[0].slug, name: teams[0].name };
  }
  if (teams.length === 0) {
    throw new TeamResolutionError('No teams found. Run `vura teams create <name>` first.');
  }
  const choices = teams.map((t) => t.slug).join(', ');
  throw new TeamResolutionError(`Multiple teams found — pass --team <id-or-slug>. Choices: ${choices}`);
}
