/**
 * `vura deploy` — deploy the built project to the Vura platform.
 *
 * Packages `dist/` (plus runtime dependencies for Dedicated/server builds),
 * uploads it to the Vura API, streams build logs, and prints the resulting
 * deployment URL. The actual upload/poll flow lives in
 * `@celsian/vura-adapter-vura` (`deployToVura`) so the adapter's `buildEnd`
 * hook and this command share one implementation.
 *
 * Flags:
 *   --prod                Deploy to production (default: preview)
 *   --token <token>       API token (else VURA_TOKEN, else ~/.vura/credentials)
 *   --api-url <url>       API base URL (else VURA_API_URL, else https://api.vura.io)
 *   --project-id <id>     Project id (else VURA_PROJECT_ID, else .vura/project.json)
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveApiUrl, resolveProjectId, resolveToken } from '../vura-client.js';

interface DeployFlags {
  production: boolean;
  token?: string;
  apiUrl?: string;
  projectId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalidManifest(manifestPath: string, detail: string): Error {
  return new Error(
    `Build manifest at ${manifestPath} is invalid (${detail}). ` +
    'Run `vura build` again before deploying.',
  );
}

async function readDeployManifest(manifestPath: string): Promise<unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    throw invalidManifest(manifestPath, 'malformed JSON');
  }

  if (!isRecord(parsed)) throw invalidManifest(manifestPath, 'expected a JSON object');
  if (!Array.isArray(parsed.api)) throw invalidManifest(manifestPath, 'api must be an array');
  if (!Array.isArray(parsed.pages)) throw invalidManifest(manifestPath, 'pages must be an array');
  for (const [index, route] of parsed.api.entries()) {
    if (!isRecord(route) || !['serverless', 'hot', 'task'].includes(String(route.kind))) {
      throw invalidManifest(manifestPath, `api[${index}] must have a supported kind`);
    }
  }
  for (const [index, page] of parsed.pages.entries()) {
    if (!isRecord(page) || !['static', 'server', 'client', 'hybrid'].includes(String(page.mode))) {
      throw invalidManifest(manifestPath, `pages[${index}] must have a supported mode`);
    }
  }
  return parsed;
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

export async function deployCommand(args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const flags = parseFlags(args);

  console.log('\n  vura deploy\n');

  // 1. Resolve authentication.
  const token = await resolveToken(flags.token);
  if (!token) {
    console.error('  Not authenticated. Run `vura login`, set VURA_TOKEN, or pass --token <token>.');
    process.exitCode = 1;
    return;
  }

  // 2. Resolve project link.
  const projectId = await resolveProjectId(flags.projectId, projectRoot);
  if (!projectId) {
    console.error('  Project not linked. Set VURA_PROJECT_ID, pass --project-id <id>, or create .vura/project.json.');
    console.error('  Run `vura teams list` to find a team, then `vura projects create <name> --team <id-or-slug>`.');
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

  const apiUrl = resolveApiUrl(flags.apiUrl);

  // 4. Refuse stale/corrupt build output before loading or calling the adapter.
  let manifest: unknown;
  try {
    manifest = await readDeployManifest(manifestPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  ${message}`);
    process.exitCode = 1;
    return;
  }

  // 5. Deploy via the adapter's independently validated shared flow.
  let deployToVura: typeof import('@celsian/vura-adapter-vura').deployToVura;
  try {
    ({ deployToVura } = await import('@celsian/vura-adapter-vura'));
  } catch {
    console.error('  Managed Vura deploy support is not installed in this CLI package.');
    console.error('  Install it with: npm install @celsian/vura-adapter-vura');
    process.exitCode = 1;
    return;
  }

  try {
    const result = await deployToVura({
      distDir,
      projectRoot,
      apiUrl,
      token,
      projectId,
      production: flags.production,
      manifest,
    });

    console.log('');
    console.log(`  ${flags.production ? 'Production' : 'Preview'} deployment ready.`);
    console.log(`  URL: ${result.url}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  Deployment failed: ${message}`);
    process.exitCode = 1;
  }
}
