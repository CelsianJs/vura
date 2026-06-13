/**
 * `vura deploy` — deploy the built project to the Vura platform.
 *
 * Packages `dist/`, uploads it to the Vura API, streams build logs, and prints
 * the resulting deployment URL. The actual upload/poll flow lives in
 * `@celsian/vura-adapter-vura` (`deployToVura`) so the adapter's `buildEnd`
 * hook and this command share one implementation.
 *
 * Flags:
 *   --prod                Deploy to production (default: preview)
 *   --token <token>       API token (else VURA_TOKEN, else ~/.vura/credentials)
 *   --api-url <url>       API base URL (else VURA_API_URL, else https://api.vura.io)
 *   --project-id <id>     Project id (else VURA_PROJECT_ID, else .vura/project.json)
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_API_URL = 'https://api.vura.io';

interface DeployFlags {
  production: boolean;
  token?: string;
  apiUrl?: string;
  projectId?: string;
}

function parseFlags(args: string[]): DeployFlags {
  const flags: DeployFlags = { production: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--prod':
      case '--production':
        flags.production = true;
        break;
      case '--token':
        flags.token = args[++i];
        break;
      case '--api-url':
        flags.apiUrl = args[++i];
        break;
      case '--project-id':
        flags.projectId = args[++i];
        break;
      default:
        // ignore unknown args (keeps house style: lenient flag parsing)
        break;
    }
  }
  return flags;
}

/** Home directory, honoring HOME/USERPROFILE overrides (e.g. in tests). */
function resolveHome(): string {
  return process.env.HOME || process.env.USERPROFILE || homedir();
}

async function resolveToken(flag?: string): Promise<string | null> {
  if (flag) return flag;
  if (process.env.VURA_TOKEN) return process.env.VURA_TOKEN;
  try {
    const raw = await readFile(join(resolveHome(), '.vura', 'credentials'), 'utf-8');
    const creds = JSON.parse(raw) as { token?: string };
    return creds.token ?? null;
  } catch {
    return null;
  }
}

async function resolveProjectId(flag: string | undefined, projectRoot: string): Promise<string | null> {
  if (flag) return flag;
  if (process.env.VURA_PROJECT_ID) return process.env.VURA_PROJECT_ID;
  try {
    const raw = await readFile(join(projectRoot, '.vura', 'project.json'), 'utf-8');
    const link = JSON.parse(raw) as { projectId?: string };
    return link.projectId ?? null;
  } catch {
    return null;
  }
}

export async function deployCommand(args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const flags = parseFlags(args);

  console.log('\n  vura deploy\n');

  // 1. Resolve authentication.
  const token = await resolveToken(flags.token);
  if (!token) {
    console.error('  Not authenticated. Set VURA_TOKEN, pass --token <token>, or sign in so ~/.vura/credentials exists.');
    process.exitCode = 1;
    return;
  }

  // 2. Resolve project link.
  const projectId = await resolveProjectId(flags.projectId, projectRoot);
  if (!projectId) {
    console.error('  Project not linked. Set VURA_PROJECT_ID, pass --project-id <id>, or create .vura/project.json.');
    process.exitCode = 1;
    return;
  }

  // 3. Ensure the project has been built.
  const distDir = join(projectRoot, 'dist');
  const manifestPath = join(distDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    console.error('  No build found at dist/manifest.json. Run `vura build` first, then `vura deploy`.');
    process.exitCode = 1;
    return;
  }

  const apiUrl = flags.apiUrl || process.env.VURA_API_URL || DEFAULT_API_URL;

  // Attach the built manifest so the platform can classify routes without
  // re-scanning the artifact.
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf-8'));
  } catch {
    manifest = undefined;
  }

  // 4. Deploy via the shared adapter flow.
  const { deployToVura } = await import('@celsian/vura-adapter-vura');
  try {
    const result = await deployToVura({
      distDir,
      apiUrl,
      token,
      projectId,
      production: flags.production,
      manifest,
    });

    console.log('');
    console.log(`  ${flags.production ? 'Production' : 'Preview'} deployment ready.`);
    console.log(`  URL: https://${result.url}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  Deployment failed: ${message}`);
    process.exitCode = 1;
  }
}
