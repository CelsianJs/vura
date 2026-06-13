/**
 * @celsian/vura-adapter-vura
 *
 * Adapts Vura build output for deployment on Vura.io.
 *
 * This adapter runs after `then build` and:
 *   1. Packages the dist/ directory into a tarball
 *   2. Uploads it to the Vura API
 *   3. Streams deployment logs back to the terminal
 *
 * Usage in vura.config.ts:
 * ```ts
 * import { defineConfig } from '@celsian/vura-core';
 * import { vuraAdapter } from '@celsian/vura-adapter-vura';
 *
 * export default defineConfig({
 *   adapter: vuraAdapter({ team: 'my-team' }),
 * });
 * ```
 */

import { mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir, tmpdir } from 'node:os';
import type { ThenAdapter, AdapterBuildContext } from '@celsian/vura-core';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const VURA_API_URL = 'https://api.vura.io';

// ─── Types ───

export interface VuraAdapterOptions {
  /** Vura API token (default: from ~/.vura/credentials) */
  token?: string;
  /** Team slug */
  team?: string;
  /** Project ID (default: from .vura/project.json) */
  projectId?: string;
  /** API base URL (default: https://api.vura.io) */
  apiUrl?: string;
  /** Deploy to production (default: false = preview) */
  production?: boolean;
}

interface VuraCredentials {
  token: string;
  email: string;
}

interface VuraProjectLink {
  projectId: string;
  teamId: string;
  teamSlug: string;
}

/**
 * Options for {@link deployToVura} — the reusable, network-only deploy flow
 * shared by this adapter's `buildEnd` hook and the `vura deploy` CLI command.
 */
export interface DeployToVuraOptions {
  /** Directory containing the built artifacts (the `dist/` output). */
  distDir: string;
  /** Vura API base URL (e.g. https://api.vura.io). */
  apiUrl: string;
  /** Bearer token for the Vura API. */
  token: string;
  /** Target project id. */
  projectId: string;
  /** Deploy to production rather than a preview (default: false). */
  production?: boolean;
  /** Build manifest to attach to the upload. */
  manifest?: unknown;
  /** Git metadata to attach to the upload. */
  gitInfo?: { ref?: string; sha?: string; message?: string };
  /** Poll interval between status/log fetches, in ms (default: 1000). */
  pollIntervalMs?: number;
  /** Maximum number of polls before giving up (default: 300). */
  maxPolls?: number;
  /** Receives human-readable progress + log lines (default: stdout). */
  logger?: (line: string) => void;
}

export interface DeployToVuraResult {
  deploymentId: string;
  url: string;
  status: string;
}

// ─── Adapter Factory ───

/**
 * Create a Vura adapter for Vura.io deployment.
 */
export function vuraAdapter(options: VuraAdapterOptions = {}): ThenAdapter {
  return {
    name: 'vura',

    async buildEnd(ctx: AdapterBuildContext): Promise<void> {
      const apiUrl = options.apiUrl || VURA_API_URL;

      // 1. Resolve authentication
      const token = await resolveToken(options);
      if (!token) {
        console.error('\x1b[31m[vura] Not authenticated. Run `then login` first.\x1b[0m');
        process.exit(1);
      }

      // 2. Resolve project
      const projectId = await resolveProjectId(options, ctx.projectRoot);
      if (!projectId) {
        console.error('\x1b[31m[vura] Project not linked. Run `then link` first.\x1b[0m');
        process.exit(1);
      }

      // 3. Get git info
      const gitInfo = await getGitInfo(ctx.projectRoot);

      // 4-6. Package, upload, and stream logs via the shared deploy flow.
      let result: DeployToVuraResult;
      try {
        result = await deployToVura({
          distDir: ctx.outDir,
          apiUrl,
          token,
          projectId,
          production: options.production,
          manifest: ctx.manifest,
          gitInfo,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`\x1b[31m[vura] Deployment failed: ${message}\x1b[0m`);
        process.exit(1);
      }

      // 7. Print result
      console.log('');
      if (options.production) {
        console.log(`\x1b[32m[vura] Production deployment ready!\x1b[0m`);
      } else {
        console.log(`\x1b[32m[vura] Preview deployment ready!\x1b[0m`);
      }
      console.log(`\x1b[36m[vura]\x1b[0m URL: https://${result.url}`);
    },
  };
}

// ─── Helpers ───

async function resolveToken(options: VuraAdapterOptions): Promise<string | null> {
  if (options.token) return options.token;

  // Check environment variable
  if (process.env.VURA_TOKEN) return process.env.VURA_TOKEN;

  // Read from ~/.vura/credentials
  try {
    const credPath = join(homedir(), '.vura', 'credentials');
    const raw = await readFile(credPath, 'utf-8');
    const creds: VuraCredentials = JSON.parse(raw);
    return creds.token;
  } catch {
    return null;
  }
}

async function resolveProjectId(options: VuraAdapterOptions, projectRoot: string): Promise<string | null> {
  if (options.projectId) return options.projectId;

  // Check environment variable
  if (process.env.VURA_PROJECT_ID) return process.env.VURA_PROJECT_ID;

  // Read from .vura/project.json
  try {
    const linkPath = join(projectRoot, '.vura', 'project.json');
    const raw = await readFile(linkPath, 'utf-8');
    const link: VuraProjectLink = JSON.parse(raw);
    return link.projectId;
  } catch {
    return null;
  }
}

async function getGitInfo(projectRoot: string): Promise<{ ref?: string; sha?: string; message?: string }> {
  try {
    const [refResult, shaResult, messageResult] = await Promise.all([
      execAsync('git rev-parse --abbrev-ref HEAD', { cwd: projectRoot }),
      execAsync('git rev-parse HEAD', { cwd: projectRoot }),
      execAsync('git log -1 --pretty=%B', { cwd: projectRoot }),
    ]);
    return {
      ref: refResult.stdout.trim(),
      sha: shaResult.stdout.trim(),
      message: messageResult.stdout.trim().slice(0, 200), // Truncate long messages
    };
  } catch {
    return {};
  }
}

export async function createTarball(sourceDir: string, outputPath: string): Promise<void> {
  // Use the system tar command for reliability. Write outside sourceDir first so
  // GNU tar on Linux does not warn/fail when the destination path is inside the
  // directory being archived.
  const tempDir = await mkdtemp(join(tmpdir(), 'vura-tarball-out-'));
  const tempOutputPath = join(tempDir, basename(outputPath));
  try {
    await execFileAsync('tar', [
      '-czf',
      tempOutputPath,
      '-C',
      sourceDir,
      '.',
    ]);
    await rename(tempOutputPath, outputPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Package the build output, upload it to the Vura API, stream build logs, and
 * resolve once the deployment is ready.
 *
 * This is the reusable core of the deploy flow — it performs no `process.exit`
 * and writes nothing to disk outside a temp tarball, so it can be driven from
 * both this adapter's `buildEnd` hook and the `vura deploy` CLI command.
 *
 * @throws if the create request fails, the deployment ends in `failed`
 *   (rejects with `meta.build_error` when present) or `cancelled`, or polling
 *   times out before reaching a terminal state.
 */
export async function deployToVura(options: DeployToVuraOptions): Promise<DeployToVuraResult> {
  const {
    distDir,
    apiUrl,
    token,
    projectId,
    production = false,
    manifest,
    gitInfo = {},
    pollIntervalMs = 1000,
    maxPolls = 300,
    logger = (line: string) => process.stdout.write(line),
  } = options;

  // 1. Create tarball of the build output.
  logger('\x1b[36m[vura]\x1b[0m Packaging build artifacts...\n');
  const tempDir = await mkdtemp(join(tmpdir(), 'vura-deploy-artifact-'));
  const tarballPath = join(tempDir, 'vura-deploy.tar.gz');
  try {
    await createTarball(distDir, tarballPath);

    const tarballStat = await stat(tarballPath);
    const sizeMB = (tarballStat.size / 1024 / 1024).toFixed(2);
    logger(`\x1b[36m[vura]\x1b[0m Artifact size: ${sizeMB} MB\n`);

    // 2. Upload to the Vura API.
    logger('\x1b[36m[vura]\x1b[0m Uploading to Vura...\n');
    const formData = new FormData();
    const tarballBuffer = await readFile(tarballPath);
    const blob = new Blob([tarballBuffer], { type: 'application/gzip' });
    formData.append('artifact', blob, 'dist.tar.gz');
    if (manifest !== undefined) formData.append('manifest', JSON.stringify(manifest));
    if (gitInfo.ref) formData.append('gitRef', gitInfo.ref);
    if (gitInfo.sha) formData.append('gitSha', gitInfo.sha);
    if (gitInfo.message) formData.append('commitMessage', gitInfo.message);
    if (production) formData.append('production', 'true');

    const createRes = await fetch(`${apiUrl}/v1/projects/${projectId}/deployments`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });

    if (!createRes.ok) {
      const err = await createRes.json().catch(() => ({ error: { message: 'Upload failed' } }));
      throw new Error((err as any).error?.message || 'Upload failed');
    }

    const created = (await createRes.json()) as { data: { id: string; url: string; status: string } };
    const deploymentId = created.data.id;
    const deploymentUrl = created.data.url;

    logger(`\x1b[36m[vura]\x1b[0m Deployment created: ${deploymentId.slice(0, 8)}\n`);

    // 3. Poll for status + stream logs.
    logger('\x1b[36m[vura]\x1b[0m Streaming build logs...\n\n');
    const status = await pollDeployment(apiUrl, deploymentId, token, { pollIntervalMs, maxPolls, logger });

    return { deploymentId, url: deploymentUrl, status };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

interface DeploymentRecord {
  status: string;
  meta?: { build_error?: string };
}

/**
 * Poll deployment status + logs until a terminal state, printing log lines as
 * they arrive. Resolves with `'ready'`; throws on `failed`/`cancelled`/timeout.
 */
async function pollDeployment(
  apiUrl: string,
  deploymentId: string,
  token: string,
  opts: { pollIntervalMs: number; maxPolls: number; logger: (line: string) => void },
): Promise<string> {
  const { pollIntervalMs, maxPolls, logger } = opts;
  let lastSequence = 0;
  let status = 'building';
  let record: DeploymentRecord = { status };

  for (let i = 0; i < maxPolls; i++) {
    // Check deployment status
    const statusRes = await fetch(`${apiUrl}/v1/deployments/${deploymentId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (statusRes.ok) {
      const data = (await statusRes.json()) as { data: DeploymentRecord };
      record = data.data;
      status = record.status;
    }

    // Fetch new logs
    const logsRes = await fetch(`${apiUrl}/v1/deployments/${deploymentId}/logs`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (logsRes.ok) {
      const logsData = (await logsRes.json()) as {
        data: Array<{ sequence: number; stream: string; content?: string; message?: string }>;
      };
      const newLogs = logsData.data.filter((l) => l.sequence > lastSequence);

      for (const log of newLogs) {
        const text = log.content ?? log.message ?? '';
        const prefix = log.stream === 'stderr' ? '\x1b[31m' : '\x1b[90m';
        logger(`${prefix}${text}\x1b[0m`);
        if (!text.endsWith('\n')) logger('\n');
        lastSequence = log.sequence;
      }
    }

    // Check if deployment is done
    if (status === 'ready') return status;
    if (status === 'failed') {
      throw new Error(record.meta?.build_error || 'Deployment failed.');
    }
    if (status === 'cancelled') {
      throw new Error('Deployment was cancelled.');
    }

    // Wait before next poll
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(`Deployment did not reach a terminal state after ${maxPolls} polls.`);
}
