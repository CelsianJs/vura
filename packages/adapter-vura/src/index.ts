/**
 * @then/adapter-vura
 *
 * Adapts ThenJS build output for deployment on Vura.io.
 *
 * This adapter runs after `then build` and:
 *   1. Packages the dist/ directory into a tarball
 *   2. Uploads it to the Vura API
 *   3. Streams deployment logs back to the terminal
 *
 * Usage in then.config.ts:
 * ```ts
 * import { defineConfig } from '@then/core';
 * import { vuraAdapter } from '@then/adapter-vura';
 *
 * export default defineConfig({
 *   adapter: vuraAdapter({ team: 'my-team' }),
 * });
 * ```
 */

import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import type { ThenAdapter, AdapterBuildContext } from '@then/core';

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

// ─── Adapter Factory ───

/**
 * Create a ThenJS adapter for Vura.io deployment.
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

      // 4. Create tarball of dist/
      console.log('\x1b[36m[vura]\x1b[0m Packaging build artifacts...');
      const tarballPath = join(ctx.outDir, 'vura-deploy.tar.gz');
      await createTarball(ctx.outDir, tarballPath);

      const tarballStat = await stat(tarballPath);
      const sizeMB = (tarballStat.size / 1024 / 1024).toFixed(2);
      console.log(`\x1b[36m[vura]\x1b[0m Artifact size: ${sizeMB} MB`);

      // 5. Upload to Vura API
      console.log('\x1b[36m[vura]\x1b[0m Uploading to Vura...');

      const formData = new FormData();
      const tarballBuffer = await readFile(tarballPath);
      const blob = new Blob([tarballBuffer], { type: 'application/gzip' });
      formData.append('artifact', blob, 'dist.tar.gz');
      formData.append('manifest', JSON.stringify(ctx.manifest));

      if (gitInfo.ref) formData.append('gitRef', gitInfo.ref);
      if (gitInfo.sha) formData.append('gitSha', gitInfo.sha);
      if (gitInfo.message) formData.append('commitMessage', gitInfo.message);
      if (options.production) formData.append('production', 'true');

      const createRes = await fetch(`${apiUrl}/v1/projects/${projectId}/deployments`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });

      if (!createRes.ok) {
        const err = await createRes.json().catch(() => ({ error: { message: 'Upload failed' } }));
        console.error(`\x1b[31m[vura] Deployment failed: ${(err as any).error?.message}\x1b[0m`);
        process.exit(1);
      }

      const deployment = await createRes.json() as { data: { id: string; url: string; status: string } };
      const deploymentId = deployment.data.id;
      const deploymentUrl = deployment.data.url;

      console.log(`\x1b[36m[vura]\x1b[0m Deployment created: ${deploymentId.slice(0, 8)}`);

      // 6. Stream deployment logs
      console.log('\x1b[36m[vura]\x1b[0m Streaming build logs...\n');
      await streamLogs(apiUrl, deploymentId, token);

      // 7. Print result
      console.log('');
      if (options.production) {
        console.log(`\x1b[32m[vura] Production deployment ready!\x1b[0m`);
      } else {
        console.log(`\x1b[32m[vura] Preview deployment ready!\x1b[0m`);
      }
      console.log(`\x1b[36m[vura]\x1b[0m URL: https://${deploymentUrl}`);
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
  // Use the system tar command for reliability
  await execFileAsync('tar', [
    '-czf',
    outputPath,
    '--exclude',
    basename(outputPath),
    '-C',
    sourceDir,
    '.',
  ]);
}

async function streamLogs(apiUrl: string, deploymentId: string, token: string): Promise<void> {
  // Poll for logs (WebSocket not available in all environments)
  let lastSequence = 0;
  let status = 'building';
  const maxPolls = 300; // 5 minutes at 1s intervals

  for (let i = 0; i < maxPolls; i++) {
    // Check deployment status
    const statusRes = await fetch(`${apiUrl}/v1/deployments/${deploymentId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (statusRes.ok) {
      const data = await statusRes.json() as { data: { status: string } };
      status = data.data.status;
    }

    // Fetch new logs
    const logsRes = await fetch(`${apiUrl}/v1/deployments/${deploymentId}/logs`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (logsRes.ok) {
      const logsData = await logsRes.json() as { data: Array<{ sequence: number; stream: string; content: string }> };
      const newLogs = logsData.data.filter(l => l.sequence > lastSequence);

      for (const log of newLogs) {
        const prefix = log.stream === 'stderr' ? '\x1b[31m' : '\x1b[90m';
        process.stdout.write(`${prefix}${log.content}\x1b[0m`);
        if (!log.content.endsWith('\n')) process.stdout.write('\n');
        lastSequence = log.sequence;
      }
    }

    // Check if deployment is done
    if (['ready', 'failed', 'cancelled'].includes(status)) {
      if (status === 'failed') {
        console.error('\x1b[31m[vura] Deployment failed.\x1b[0m');
        process.exit(1);
      }
      if (status === 'cancelled') {
        console.warn('\x1b[33m[vura] Deployment was cancelled.\x1b[0m');
        process.exit(1);
      }
      break;
    }

    // Wait 1 second before next poll
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}
