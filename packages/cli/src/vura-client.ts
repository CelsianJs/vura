/**
 * Shared credential/config resolution and API client for commands that talk
 * to the Vura Platform (`vura login`, `vura teams`, `vura projects`,
 * `vura deploy`).
 *
 * Conventions (do not change without updating every command that relies on
 * them — `deploy.ts` and `@celsian/vura-adapter-vura` read the same files):
 *   token      : --token flag   > VURA_TOKEN env    > ~/.vura/credentials `token`
 *   api url    : --api-url flag > VURA_API_URL env  > https://api.vura.io
 *   project id : --project-id flag > VURA_PROJECT_ID env > <root>/.vura/project.json `projectId`
 */

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_API_URL = 'https://api.vura.io';

export interface VuraCredentials {
  token: string;
  email?: string;
  refreshToken?: string;
}

export interface VuraProjectLink {
  projectId: string;
  teamId?: string;
  teamSlug?: string;
}

/** Home directory, honoring HOME/USERPROFILE overrides (e.g. in tests). */
export function resolveHome(): string {
  return process.env.HOME || process.env.USERPROFILE || homedir();
}

function credentialsPath(): string {
  return join(resolveHome(), '.vura', 'credentials');
}

/** Read ~/.vura/credentials. Returns null if absent, malformed, or tokenless. */
export async function readCredentials(): Promise<VuraCredentials | null> {
  try {
    const raw = await readFile(credentialsPath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<VuraCredentials>;
    if (parsed && typeof parsed.token === 'string' && parsed.token.length > 0) {
      return parsed as VuraCredentials;
    }
    return null;
  } catch {
    return null;
  }
}

/** Write ~/.vura/credentials at mode 0600 (owner read/write only). */
export async function writeCredentials(creds: VuraCredentials): Promise<void> {
  const dir = join(resolveHome(), '.vura');
  await mkdir(dir, { recursive: true });
  const path = credentialsPath();
  await writeFile(path, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });
  // `writeFile`'s `mode` only applies when CREATING the file — a pre-existing
  // credentials file (left at a looser mode by an older CLI or a manual edit)
  // would keep that mode while now holding a token. Re-tighten explicitly.
  await chmod(path, 0o600);
}

/** Resolve the auth token: --token flag > VURA_TOKEN env > ~/.vura/credentials. */
export async function resolveToken(flag?: string): Promise<string | null> {
  if (flag) return flag;
  if (process.env.VURA_TOKEN) return process.env.VURA_TOKEN;
  const creds = await readCredentials();
  return creds?.token ?? null;
}

/** Resolve the API base URL: --api-url flag > VURA_API_URL env > default. */
export function resolveApiUrl(flag?: string): string {
  return flag || process.env.VURA_API_URL || DEFAULT_API_URL;
}

/** Read <projectRoot>/.vura/project.json. Returns null if absent/malformed. */
export async function readProjectLink(projectRoot: string): Promise<VuraProjectLink | null> {
  try {
    const raw = await readFile(join(projectRoot, '.vura', 'project.json'), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<VuraProjectLink>;
    if (parsed && typeof parsed.projectId === 'string' && parsed.projectId.length > 0) {
      return parsed as VuraProjectLink;
    }
    return null;
  } catch {
    return null;
  }
}

/** Write <projectRoot>/.vura/project.json, linking the project for `vura deploy`. */
export async function writeProjectLink(projectRoot: string, link: VuraProjectLink): Promise<void> {
  const dir = join(projectRoot, '.vura');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'project.json'), `${JSON.stringify(link, null, 2)}\n`);
}

/** Resolve the project id: --project-id flag > VURA_PROJECT_ID env > .vura/project.json. */
export async function resolveProjectId(flag: string | undefined, projectRoot: string): Promise<string | null> {
  if (flag) return flag;
  if (process.env.VURA_PROJECT_ID) return process.env.VURA_PROJECT_ID;
  const link = await readProjectLink(projectRoot);
  return link?.projectId ?? null;
}

interface ApiErrorBody {
  error?: { code?: string; message?: string; status?: number };
}

/** An error response from the Vura API, carrying the HTTP status for callers to branch on (e.g. 401 → suggest `vura login`). */
export class VuraApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'VuraApiError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Call the Vura API and return the parsed JSON body. Throws {@link VuraApiError}
 * on a non-2xx response, using the server's `{ error: { message } }` shape
 * when present.
 */
export async function vuraApiRequest(
  apiUrl: string,
  path: string,
  init: { method?: string; token?: string; body?: unknown } = {},
): Promise<unknown> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;

  const res = await fetch(`${apiUrl}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });

  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (!res.ok) {
    const errBody = body as ApiErrorBody;
    const message = errBody?.error?.message || `Request failed with HTTP ${res.status}`;
    throw new VuraApiError(message, res.status, errBody?.error?.code);
  }

  return body;
}

/** Format a caught error for CLI display, adding a `vura login` hint on 401s. */
export function formatApiError(err: unknown): string {
  if (err instanceof VuraApiError) {
    if (err.status === 401) return `${err.message}. Run \`vura login\` and try again.`;
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

/** Slugify a name the same way the Vura API derives team/project slugs. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
}
