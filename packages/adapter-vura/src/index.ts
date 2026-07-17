/**
 * @celsian/vura-adapter-vura
 *
 * Adapts Vura build output for deployment on Vura.io.
 *
 * This adapter runs after `then build` and:
 *   1. Packages the build output (plus runtime dependencies when required)
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

import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
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
  /**
   * Project root containing dist/, package.json, and node_modules/. Required
   * when the manifest includes Dedicated API routes or server/hybrid pages.
   */
  projectRoot?: string;
  /** Vura API base URL (e.g. https://api.vura.io). */
  apiUrl: string;
  /** Bearer token for the Vura API. */
  token: string;
  /** Target project id. */
  projectId: string;
  /** Deploy to production rather than a preview (default: false). */
  production?: boolean;
  /**
   * @deprecated The validated dist/manifest.json is authoritative. This field
   * remains accepted for source compatibility but cannot replace the artifact.
   */
  manifest?: unknown;
  /** Git metadata to attach to the upload. */
  gitInfo?: { ref?: string; sha?: string; message?: string };
  pollIntervalMs?: number;
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
          projectRoot: ctx.projectRoot,
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
      console.log(`\x1b[36m[vura]\x1b[0m URL: ${result.url}`);
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

export async function createTarball(
  sourceDir: string,
  outputPath: string,
  entries: string[] = ['.'],
): Promise<void> {
  for (const entry of entries) {
    const normalized = normalize(entry);
    if (
      entry.startsWith('-')
      || isAbsolute(entry)
      || normalized === '..'
      || normalized.startsWith(`..${sep}`)
    ) {
      throw new Error(`Refusing unsafe tar entry: ${entry}`);
    }
  }

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
      '--',
      ...entries,
    ]);
    await rename(tempOutputPath, outputPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function assertInsideBoundary(boundary: string, candidate: string, label: string): void {
  const rel = relative(boundary, candidate);
  if (rel !== '' && (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))) {
    throw new Error(
      `Refusing to package ${label} symlink outside its allowed deploy tree: ${candidate}`,
    );
  }
}

async function copyPortableEntry(
  source: string,
  destination: string,
  boundary: string,
  label: string,
  ancestry: Set<string>,
): Promise<void> {
  const entry = await lstat(source);
  if (entry.isSymbolicLink()) {
    const target = await realpath(source);
    assertInsideBoundary(boundary, target, label);
    await copyPortableEntry(target, destination, boundary, label, ancestry);
    return;
  }

  const resolvedSource = await realpath(source);
  assertInsideBoundary(boundary, resolvedSource, label);

  if (entry.isDirectory()) {
    // Dependency graphs can contain cycles (A -> B -> A). Omitting the nested
    // duplicate lets Node continue resolution at an ancestor node_modules
    // while keeping the staged tree finite.
    if (ancestry.has(resolvedSource)) return;
    ancestry.add(resolvedSource);
    try {
      await mkdir(destination, { recursive: true });
      for (const child of await readdir(source)) {
        await copyPortableEntry(
          join(source, child),
          join(destination, child),
          boundary,
          label,
          ancestry,
        );
      }
      await chmod(destination, entry.mode & 0o777);
    } finally {
      ancestry.delete(resolvedSource);
    }
    return;
  }

  if (entry.isFile()) {
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
    await chmod(destination, entry.mode & 0o777);
    return;
  }

  throw new Error(`Refusing unsupported dependency entry: ${source}`);
}

type PackageDependencyMetadata = {
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
  peerDependencies?: Record<string, unknown>;
};

function dependencyNames(
  metadata: PackageDependencyMetadata,
  fields: Array<keyof PackageDependencyMetadata>,
): Set<string> {
  return new Set(fields.flatMap((field) => Object.keys(metadata[field] ?? {})));
}

async function readPackageMetadata(path: string): Promise<PackageDependencyMetadata> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read deploy package metadata at ${path}`, { cause: error });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Deploy package metadata must be a JSON object: ${path}`);
  }
  return parsed as PackageDependencyMetadata;
}

async function copyVisibleDependency(
  modulesRoot: string,
  stagedModules: string,
  dependencyName: string,
  devOnlyDependencies: Set<string>,
): Promise<void> {
  if (devOnlyDependencies.has(dependencyName)) return;
  await copyPortableEntry(
    join(modulesRoot, ...dependencyName.split('/')),
    join(stagedModules, ...dependencyName.split('/')),
    modulesRoot,
    'dependency',
    new Set(),
  );
}

async function createProjectContextTarball(projectRoot: string, outputPath: string): Promise<void> {
  const root = await realpath(projectRoot);
  const distRoot = await realpath(join(root, 'dist'));
  const modulesRoot = await realpath(join(root, 'node_modules'));
  assertInsideBoundary(root, distRoot, 'dist');
  assertInsideBoundary(root, modulesRoot, 'node_modules');

  const packageJsonPath = join(root, 'package.json');
  const packageJson = await lstat(packageJsonPath);
  if (!packageJson.isFile()) {
    throw new Error('Refusing to package package.json unless it is an ordinary file.');
  }

  const rootMetadata = await readPackageMetadata(packageJsonPath);

  const stagingRoot = await mkdtemp(join(tmpdir(), 'vura-portable-context-'));
  try {
    await copyPortableEntry(distRoot, join(stagingRoot, 'dist'), distRoot, 'dist', new Set());
    await copyFile(packageJsonPath, join(stagingRoot, 'package.json'));
    await chmod(join(stagingRoot, 'package.json'), packageJson.mode & 0o777);

    const stagedDistPackageJson = join(stagingRoot, 'dist', 'package.json');
    let distMetadata: PackageDependencyMetadata = {};
    try {
      const distPackageJson = await lstat(stagedDistPackageJson);
      if (!distPackageJson.isFile()) {
        throw new Error('Refusing deploy dist/package.json unless it is an ordinary file.');
      }
      distMetadata = await readPackageMetadata(stagedDistPackageJson);
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
    }

    const runtimeDependencies = new Set([
      ...dependencyNames(rootMetadata, ['dependencies', 'optionalDependencies', 'peerDependencies']),
      ...dependencyNames(distMetadata, ['dependencies', 'optionalDependencies', 'peerDependencies']),
    ]);
    const devOnlyDependencies = new Set(
      [...dependencyNames(rootMetadata, ['devDependencies'])]
        .filter((name) => !runtimeDependencies.has(name)),
    );

    const stagedModules = join(stagingRoot, 'node_modules');
    await mkdir(stagedModules, { recursive: true });
    for (const child of await readdir(modulesRoot)) {
      // Package-manager stores, bins, and caches are implementation details.
      if (child.startsWith('.')) continue;

      if (child.startsWith('@')) {
        for (const scopedChild of await readdir(join(modulesRoot, child))) {
          await copyVisibleDependency(
            modulesRoot,
            stagedModules,
            `${child}/${scopedChild}`,
            devOnlyDependencies,
          );
        }
        continue;
      }

      await copyVisibleDependency(
        modulesRoot,
        stagedModules,
        child,
        devOnlyDependencies,
      );
    }

    await createTarball(stagingRoot, outputPath, ['dist', 'package.json', 'node_modules']);
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

type DeployManifest = {
  api: Array<{
    kind: 'serverless' | 'hot' | 'task';
    hasWebsocket?: boolean;
    config?: {
      compute?: { class?: 'function' | 'dedicated' };
      hot?: boolean;
      runtime?: string;
      placement?: string;
      target?: string;
    };
  }>;
  pages: Array<{ mode: 'static' | 'server' | 'client' | 'hybrid' }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalidManifest(manifestPath: string, detail: string): Error {
  return new Error(
    `Build manifest at ${manifestPath} is invalid (${detail}). ` +
    'Run `vura build` again before deploying.',
  );
}

function assertDeployManifest(
  value: unknown,
  manifestPath = 'dist/manifest.json',
): asserts value is DeployManifest {
  if (!isRecord(value)) throw invalidManifest(manifestPath, 'expected a JSON object');
  if (!Array.isArray(value.api)) throw invalidManifest(manifestPath, 'api must be an array');
  if (!Array.isArray(value.pages)) throw invalidManifest(manifestPath, 'pages must be an array');

  for (const [index, route] of value.api.entries()) {
    if (!isRecord(route)) throw invalidManifest(manifestPath, `api[${index}] must be an object`);
    if (!['serverless', 'hot', 'task'].includes(String(route.kind))) {
      throw invalidManifest(manifestPath, `api[${index}].kind is missing or unsupported`);
    }
    if (route.hasWebsocket !== undefined && typeof route.hasWebsocket !== 'boolean') {
      throw invalidManifest(manifestPath, `api[${index}].hasWebsocket must be a boolean`);
    }
    if (route.config !== undefined && !isRecord(route.config)) {
      throw invalidManifest(manifestPath, `api[${index}].config must be an object`);
    }
    const compute = isRecord(route.config) ? route.config.compute : undefined;
    if (compute !== undefined && !isRecord(compute)) {
      throw invalidManifest(manifestPath, `api[${index}].config.compute must be an object`);
    }
    if (
      isRecord(compute)
      && compute.class !== undefined
      && compute.class !== 'function'
      && compute.class !== 'dedicated'
    ) {
      throw invalidManifest(
        manifestPath,
        `api[${index}].config.compute.class must be function or dedicated`,
      );
    }
  }

  for (const [index, page] of value.pages.entries()) {
    if (!isRecord(page)) throw invalidManifest(manifestPath, `pages[${index}] must be an object`);
    if (!['static', 'server', 'client', 'hybrid'].includes(String(page.mode))) {
      throw invalidManifest(manifestPath, `pages[${index}].mode is missing or unsupported`);
    }
  }
}

function routeRequiresProjectContext(route: DeployManifest['api'][number]): boolean {
  const config = route.config;
  return route.kind === 'hot'
    || route.hasWebsocket === true
    || config?.compute?.class === 'dedicated'
    || config?.hot === true
    || config?.runtime === 'hot'
    || config?.placement === 'hot'
    || config?.target === 'hot';
}

function manifestRequiresProjectContext(manifest: DeployManifest): boolean {
  return manifest.api.some(routeRequiresProjectContext)
    || manifest.pages.some((page) => page.mode === 'server' || page.mode === 'hybrid');
}

async function readBuiltManifest(distDir: string): Promise<DeployManifest> {
  const manifestPath = join(distDir, 'manifest.json');
  let raw: string;
  try {
    raw = await readFile(manifestPath, 'utf8');
  } catch {
    throw new Error(
      `Build manifest is missing at ${manifestPath}. ` +
      'Run `vura build` again before deploying.',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalidManifest(manifestPath, 'malformed JSON');
  }
  assertDeployManifest(parsed, manifestPath);
  return parsed;
}

async function assertProjectContext(projectRoot: string, distDir: string): Promise<void> {
  const root = resolve(projectRoot);
  const built = resolve(distDir);
  if (relative(root, built) !== 'dist') {
    throw new Error(
      'Dedicated routes and server-rendered pages require dist/ directly under the project root. ' +
      `Received build output at ${distDir}.`,
    );
  }

  const packageJson = await stat(join(root, 'package.json')).catch(() => null);
  if (!packageJson?.isFile()) {
    throw new Error(
      'Dedicated routes and server-rendered pages require package.json in the project root.',
    );
  }

  const nodeModules = await stat(join(root, 'node_modules')).catch(() => null);
  if (!nodeModules?.isDirectory()) {
    throw new Error(
      'Dedicated routes and server-rendered pages require node_modules in the project root. ' +
      'Run your package manager install command before deploying.',
    );
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
    projectRoot,
    apiUrl,
    token,
    projectId,
    production = false,
    gitInfo = {},
    pollIntervalMs = 3000,
    maxPolls = 400,
    logger = (line: string) => process.stdout.write(line),
  } = options;

  // The on-disk artifact is authoritative. Never fall back to a supplied
  // in-memory manifest: a missing or stale build cannot be classified safely.
  const manifest = await readBuiltManifest(distDir);
  const requiresProjectContext = manifestRequiresProjectContext(manifest);

  // 1. Create a lean dist-only archive for ordinary deployments. Dedicated
  // and server-rendered deployments need the runtime dependency tree as a
  // Docker context. Tar intentionally does not receive -h/--dereference:
  // arbitrary dependency symlinks must never cause files outside the project
  // to be copied into the upload.
  logger('\x1b[36m[vura]\x1b[0m Packaging build artifacts...\n');
  const tempDir = await mkdtemp(join(tmpdir(), 'vura-deploy-artifact-'));
  const tarballPath = join(tempDir, 'vura-deploy.tar.gz');
  try {
    if (requiresProjectContext) {
      if (!projectRoot) {
        throw new Error(
          'Dedicated routes and server-rendered pages require a projectRoot deploy context. ' +
          'Upgrade the Vura CLI or adapter and deploy again.',
        );
      }
      await assertProjectContext(projectRoot, distDir);
      await createProjectContextTarball(resolve(projectRoot), tarballPath);
    } else {
      await createTarball(distDir, tarballPath);
    }

    const tarballStat = await stat(tarballPath);
    const sizeMB = (tarballStat.size / 1024 / 1024).toFixed(2);
    logger(`\x1b[36m[vura]\x1b[0m Artifact size: ${sizeMB} MB\n`);

    // 2. Upload to the Vura API.
    logger('\x1b[36m[vura]\x1b[0m Uploading to Vura...\n');
    const formData = new FormData();
    const tarballBuffer = await readFile(tarballPath);
    const blob = new Blob([tarballBuffer], { type: 'application/gzip' });
    formData.append('artifact', blob, 'dist.tar.gz');
    formData.append('manifest', JSON.stringify(manifest));
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
      const message = (err as any).error?.message || 'Upload failed';
      throw new Error(presentDeploymentLog(String(message)));
    }

    const created = (await createRes.json()) as { data: { id: string; url: string; status: string } };
    const deploymentId = created.data.id;
    // Older API versions returned a bare host; newer ones a full https:// URL.
    // Normalize so callers can print it verbatim (no `https://https://`).
    const deploymentUrl = created.data.url.startsWith('http')
      ? created.data.url
      : `https://${created.data.url}`;

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

function retryAfterMs(response: Response): number {
  const raw = response.headers?.get?.('retry-after');
  if (!raw) return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(raw);
  return Number.isNaN(date) ? 0 : Math.max(0, date - Date.now());
}

function presentDeploymentLog(value: string): string {
  return value
    .replace(/registry\.fly\.io\/[A-Za-z0-9._/:@-]+/gi, 'managed-runtime-image')
    .replace(/(?:[A-Za-z0-9-]+\.)*fly\.dev\b/gi, 'managed-runtime-domain')
    .replace(/(?:[A-Za-z0-9-]+\.)*fly\.io\b/gi, 'runtime-provider')
    .replace(/\bflyctl\b/gi, 'runtime-cli')
    .replace(/\bfly(?:\.[A-Za-z0-9_-]+)?\.toml\b/gi, 'runtime-config')
    .replace(/\bFLY(?:CTL)?_[A-Z0-9_]+\b/gi, 'RUNTIME_PROVIDER_SETTING')
    .replace(/\[deploy:hot-image\]/gi, '[deploy:runtime-image]')
    .replace(/hot server image/gi, 'runtime image')
    .replace(/Fly app/gi, 'runtime target')
    .replace(/Fly Machines/gi, 'runtime provider')
    .replace(/\bFly\b/gi, 'runtime provider');
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
    let retryDelayMs = 0;
    // Check deployment status
    const statusRes = await fetch(`${apiUrl}/v1/deployments/${deploymentId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (statusRes.ok) {
      const data = (await statusRes.json()) as { data: DeploymentRecord };
      record = data.data;
      status = record.status;
    } else if (statusRes.status === 429) {
      retryDelayMs = Math.max(retryDelayMs, retryAfterMs(statusRes));
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
        const text = presentDeploymentLog(log.content ?? log.message ?? '');
        const prefix = log.stream === 'stderr' ? '\x1b[31m' : '\x1b[90m';
        logger(`${prefix}${text}\x1b[0m`);
        if (!text.endsWith('\n')) logger('\n');
        lastSequence = log.sequence;
      }
    } else if (logsRes.status === 429) {
      retryDelayMs = Math.max(retryDelayMs, retryAfterMs(logsRes));
    }

    // Check if deployment is done
    if (status === 'ready') return status;
    if (status === 'failed') {
      throw new Error(presentDeploymentLog(record.meta?.build_error || 'Deployment failed.'));
    }
    if (status === 'cancelled') {
      throw new Error('Deployment was cancelled.');
    }

    await new Promise((resolve) => setTimeout(resolve, Math.max(pollIntervalMs, retryDelayMs)));
  }

  const timeoutMinutes = Math.max(1, Math.round((maxPolls * pollIntervalMs) / 60_000));
  throw new Error(
    `Deployment is still running after about ${timeoutMinutes} minute(s) ` +
    `(${maxPolls} checks). Inspect it with vura deployments.`,
  );
}
