/**
 * Vura Build Pipeline
 *
 * Takes a route manifest and produces deployment-ready output:
 * 1. Server bundle (Node.js app that handles API routes + SSR pages + tasks)
 * 2. Client bundle (static assets for CDN)
 * 3. Function bundles (one per serverless route, for Lambda/Workers)
 * 4. Task entries (one per task route, for serverless task execution)
 *
 * The adapter then takes these artifacts and generates platform-specific config.
 *
 * Server entry strategy (v0.3 rebase):
 *   generateServerEntry() emits a THIN wiring file that imports startVuraServer
 *   from @celsian/vura-core instead of inlining all runtime code as JS strings.
 *   build() then esbuild-bundles that thin source (bundle:true) into a fully
 *   self-contained dist/server/entry.js that includes vura-core + celsian + what-fw.
 *   The thin source is also written as entry.source.mjs for inspection.
 *
 * NOTE: TASK_RUNNER_CODE and task admin endpoints (/__tasks) are deferred
 * to Task 11 of the rebase plan.  Task routes in apiRoutes are silently
 * skipped by createApiApp until that task lands.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RouteManifest, ApiRoute, PageRoute } from './manifest.js';
import type { ThenConfig, AdapterBuildContext } from './config.js';


const CORE_PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));

function coreModuleFile(moduleName: string): string {
  const tsPath = join(CORE_PACKAGE_DIR, `${moduleName}.ts`);
  if (existsSync(tsPath)) return tsPath;
  return join(CORE_PACKAGE_DIR, `${moduleName}.js`);
}

function vuraCoreSelfResolvePlugin() {
  return {
    name: 'vura-core-self-resolve',
    setup(build: any) {
      build.onResolve({ filter: /^@celsian\/vura-core\/(jsx-runtime|jsx-dev-runtime)$/ }, (args: any) => ({
        path: coreModuleFile('jsx-runtime'),
      }));
      build.onResolve({ filter: /^@celsian\/vura-core$/ }, () => ({
        path: '@celsian/vura-core',
        namespace: 'vura-core-runtime-shim',
      }));
      build.onLoad({ filter: /.*/, namespace: 'vura-core-runtime-shim' }, () => {
        const ext = (mod: string) => existsSync(join(CORE_PACKAGE_DIR, `${mod}.ts`)) ? 'ts' : 'js';
        return {
          loader: 'js',
          resolveDir: CORE_PACKAGE_DIR,
          contents: `
export { defineConfig } from './config.${ext('config')}';
export { HttpError, ErrorCode, badRequest, unauthorized, forbidden, notFound, methodNotAllowed, conflict, rateLimited, internalError, serviceUnavailable, formatErrorResponse, sendErrorResponse, renderErrorPage, setGlobalErrorHandler, getGlobalErrorHandler, reportError, getErrorMode } from './errors.${ext('errors')}';
export { defineSchema, validate, withValidation, validateRequest } from './validation.${ext('validation')}';
export { HookRegistry, createHookRegistry, getHookRegistry, setDefaultHookRegistry, executeWithHooks } from './hooks.${ext('hooks')}';
export { startVuraServer, serveStaticIfFound } from './runtime/server.${ext('runtime/server')}';
export { createApiApp } from './runtime/api-app.${ext('runtime/api-app')}';
export { createVuraCache, revalidatePath, revalidateTag } from './runtime/cache.${ext('runtime/cache')}';
export { buildWhatRoutes, createPagesHandler, createVuraRenderRoute } from './runtime/pages.${ext('runtime/pages')}';
`,
        };
      });
    },
  };
}

// ─── Global Hooks File Convention ───
// The production server supports global hooks via a conventional file:
//   src/api/_hooks.ts  (or .js, .mjs)
// This file should export hook arrays:
//   export const onRequest = [(req, reply) => { ... }];
//   export const onError = [(error, req, reply) => { ... }];
//   export const onResponse = [(req, reply, info) => { ... }];

const GLOBAL_HOOKS_FILENAMES = [
  'src/api/_hooks.ts',
  'src/api/_hooks.js',
  'src/api/_hooks.mjs',
  'src/hooks.ts',
  'src/hooks.js',
  'src/hooks.mjs',
];

/**
 * Find the global hooks file in the project, if one exists.
 */
function findGlobalHooksFile(projectRoot: string): string | null {
  for (const filename of GLOBAL_HOOKS_FILENAMES) {
    if (existsSync(join(projectRoot, filename))) {
      return filename;
    }
  }
  return null;
}

// ─── Server Entry Generator ───

/**
 * Generate a THIN wiring file for the production server entry.
 *
 * The emitted source imports route/page modules (pre-bundled to dist/server/)
 * and calls startVuraServer() from @celsian/vura-core.  It is NOT directly
 * runnable — build() esbuild-bundles it (bundle:true) to produce the final
 * self-contained dist/server/entry.js.
 *
 * Global hooks are wired via a conventional file (src/api/_hooks.ts or src/hooks.ts).
 *
 * TODO(Task 11): task routes are passed in apiRoutes but silently ignored by
 * startVuraServer until task admin endpoints land in that task.
 */
export function generateServerEntry(manifest: RouteManifest, projectRoot: string, globalHooksFile?: string | null): string {
  // Reset used var names for each server entry generation
  _usedVarNames.clear();

  const lines: string[] = [];
  const serverPages = manifest.pages.filter(p => p.mode === 'server' || p.mode === 'hybrid');

  // Pre-compute var names so each route/page gets a stable name
  const routeVarNames = new Map<string, string>();
  for (const route of manifest.api) {
    routeVarNames.set(route.filePath, routeToVarName(route));
  }
  const pageVarNames = new Map<string, string>();
  for (const page of serverPages) {
    pageVarNames.set(page.filePath, pageToVarName(page));
  }

  // Collect unique layout files used by server pages
  const layoutVarNames = new Map<string, string>();
  for (const page of serverPages) {
    if (page.layouts) {
      for (const layoutPath of page.layouts) {
        if (!layoutVarNames.has(layoutPath)) {
          layoutVarNames.set(layoutPath, layoutToVarName(layoutPath));
        }
      }
    }
  }

  // ── Imports ──
  lines.push("import { startVuraServer } from '@celsian/vura-core';");
  lines.push("import { fileURLToPath as _fileURLToPath } from 'node:url';");
  lines.push("import { resolve as _resolve, dirname as _dirname } from 'node:path';");

  // Import API route handlers
  for (const route of manifest.api) {
    const varName = routeVarNames.get(route.filePath)!;
    const importPath = `./${relative('dist/server', join('dist/server/api', route.filePath.replace(/^src\/api\//, '')))}`.replace(/\.([mc])?tsx?$/, '.$1js').replace(/\\/g, '/');
    lines.push(`import * as ${varName} from '${importPath}';`);
  }

  // Import server-mode page modules
  for (const page of serverPages) {
    const varName = pageVarNames.get(page.filePath)!;
    const importPath = `./${relative('dist/server', join('dist/server/pages', page.filePath.replace(/^src\/pages\//, '')))}`.replace(/\.([mc])?tsx?$/, '.$1js').replace(/\\/g, '/');
    lines.push(`import * as ${varName} from '${importPath}';`);
  }

  // Import layout modules
  for (const [layoutPath, varName] of layoutVarNames) {
    const importPath = `./${relative('dist/server', join('dist/server/pages', layoutPath.replace(/^src\/pages\//, '')))}`.replace(/\.([mc])?tsx?$/, '.$1js').replace(/\\/g, '/');
    lines.push(`import * as ${varName} from '${importPath}';`);
  }

  // Import global hooks file if present (convention: src/api/_hooks.ts or src/hooks.ts)
  if (globalHooksFile) {
    const hooksImportPath = `./${relative('dist/server', join('dist/server/api', globalHooksFile.replace(/^src\/api\//, '').replace(/^src\//, '')))}`.replace(/\.([mc])?tsx?$/, '.$1js').replace(/\\/g, '/');
    lines.push(`import * as _globalHooksMod from '${hooksImportPath}';`);
  }

  // ── Body ──
  lines.push('');
  lines.push('const _dirname_entry = _dirname(_fileURLToPath(import.meta.url));');
  lines.push("const _publicDir = _resolve(_dirname_entry, '..', 'public');");
  lines.push("const _staticDir = _resolve(_dirname_entry, '..', 'static');");
  lines.push('');
  lines.push('await startVuraServer({');
  lines.push('  port: parseInt(process.env.PORT || \'3000\', 10),');

  // apiRoutes — all routes (task routes silently skipped by startVuraServer for now)
  lines.push('  apiRoutes: [');
  for (const route of manifest.api) {
    const varName = routeVarNames.get(route.filePath)!;
    lines.push(`    { urlPattern: '${route.urlPattern}', filePath: '${route.filePath}', methods: ${JSON.stringify(route.methods)}, kind: '${route.kind}', hasWebsocket: ${!!route.hasWebsocket}, config: ${JSON.stringify(route.config ?? {})}, module: ${varName} },`);
  }
  lines.push('  ],');

  // pages
  // Emit a build-time warning for hybrid pages — they are not yet served at runtime.
  const hybridPages = serverPages.filter(p => p.mode === 'hybrid');
  if (hybridPages.length > 0) {
    console.warn(
      `[vura] hybrid pages are not yet served at runtime (v0.4): ${hybridPages.map(p => p.filePath).join(', ')}`,
    );
  }

  lines.push('  pages: [');
  for (const page of serverPages) {
    const varName = pageVarNames.get(page.filePath)!;
    const layoutModulesStr = page.layouts && page.layouts.length > 0
      ? `[${page.layouts.map(lp => layoutVarNames.get(lp)!).join(', ')}]`
      : '[]';
    // layouts: string paths for inspection/debugging; layoutModules: loaded modules for runtime.
    const layoutsStr = JSON.stringify(page.layouts ?? []);
    lines.push(`    { urlPattern: '${page.urlPattern}', filePath: '${page.filePath}', mode: '${page.mode}', config: ${JSON.stringify(page.config ?? {})}, module: ${varName}, layoutModules: ${layoutModulesStr}, layouts: ${layoutsStr} },`);
  }
  lines.push('  ],');

  // cache
  lines.push('  cache: {');
  lines.push('    revalidateSecret: process.env.VURA_REVALIDATE_SECRET,');
  lines.push('    // TODO: wire full VuraCacheConfig from vura.config when Task X lands');
  lines.push('  },');

  // globalHooks
  if (globalHooksFile) {
    lines.push('  globalHooks: {');
    lines.push('    onRequest: _globalHooksMod.onRequest ? (Array.isArray(_globalHooksMod.onRequest) ? _globalHooksMod.onRequest : [_globalHooksMod.onRequest]) : [],');
    lines.push('    onError: _globalHooksMod.onError ? (Array.isArray(_globalHooksMod.onError) ? _globalHooksMod.onError : [_globalHooksMod.onError]) : [],');
    lines.push('    onResponse: _globalHooksMod.onResponse ? (Array.isArray(_globalHooksMod.onResponse) ? _globalHooksMod.onResponse : [_globalHooksMod.onResponse]) : [],');
    lines.push('  },');
  } else {
    lines.push('  globalHooks: undefined,');
  }

  lines.push('  staticDirs: [_publicDir, _staticDir],');
  lines.push('  shutdownTimeoutMs: parseInt(process.env.THEN_SHUTDOWN_TIMEOUT || \'30000\', 10),');
  lines.push('  installSignalHandlers: true,');
  lines.push('});');

  return lines.join('\n');
}

// ─── Server Entry Bundler ───

async function bundleServerEntry(
  thinSourcePath: string,
  outfile: string,
  projectRoot: string,
): Promise<void> {
  const { build: esbuild } = await import('esbuild');
  await esbuild({
    entryPoints: [thinSourcePath],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile,
    external: NODE_EXTERNAL_BUILTINS,
    plugins: [vuraCoreSelfResolvePlugin()],
    nodePaths: [
      join(projectRoot, 'node_modules'),
      join(process.cwd(), 'node_modules'),
    ],
  });
}

// ─── Serverless Function Generator ───

/**
 * Generate a self-contained serverless function entry for a single API route.
 * No external dependencies — includes inline req/reply shim.
 */
export function generateFunctionEntry(route: ApiRoute, projectRoot: string): string {
  const varName = routeToVarName(route);

  return `import * as ${varName} from './route.js';

const handlers = { ${route.methods.map(m => `${m}: ${varName}.${m}`).join(', ')} };

function parseBody(request) {
  const ct = request.headers.get('content-type') || '';
  if (!request.body) return Promise.resolve(null);
  if (ct.includes('application/json')) return request.json().catch(() => null);
  if (ct.includes('application/x-www-form-urlencoded')) return request.text().then(t => Object.fromEntries(new URLSearchParams(t)));
  return request.text();
}

// Worker-compatible fetch handler (Cloudflare Workers, Deno Deploy, etc.)
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const handlerFn = handlers[method];

    if (typeof handlerFn !== 'function') {
      return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405, headers: { 'content-type': 'application/json' } });
    }

    const body = await parseBody(request);
    const req = {
      method,
      url: url.pathname,
      headers: Object.fromEntries(request.headers.entries()),
      params: {},
      query: Object.fromEntries(url.searchParams.entries()),
      body,
      parsedBody: body,
    };

    let statusCode = 200;
    const responseHeaders = { 'content-type': 'application/json' };
    let responseBody = null;
    const reply = {
      status(code) { statusCode = code; return reply; },
      header(name, value) { responseHeaders[name] = value; return reply; },
      json(data) { responseBody = JSON.stringify(data); return null; },
      send(data) { responseBody = data; return null; },
      redirect(url, status) { statusCode = status || 302; responseHeaders['location'] = url; responseBody = 'Redirecting to ' + url; return null; },
    };

    const result = await handlerFn(req, reply);
    if (result instanceof Response) return result;
    if (responseBody !== null) return new Response(responseBody, { status: statusCode, headers: responseHeaders });
    if (result && typeof result === 'object') return new Response(JSON.stringify(result), { status: statusCode, headers: responseHeaders });
    return new Response(null, { status: 204 });
  },
};
`;
}

// ─── Task Entry Generator ───

/**
 * Generate a self-contained serverless entry for a task route.
 * Wraps the handler with timeout enforcement and retry metadata.
 */
export function generateTaskEntry(route: ApiRoute, projectRoot: string): string {
  const varName = routeToVarName(route);
  const timeoutMs = (route.config.timeout as number) || 30000;

  return `import * as ${varName} from './route.js';

const handler = ${varName}.POST;
const TIMEOUT_MS = ${timeoutMs};

function parseBody(request) {
  const ct = request.headers.get('content-type') || '';
  if (!request.body) return Promise.resolve(null);
  if (ct.includes('application/json')) return request.json().catch(() => null);
  return request.text();
}

// Worker-compatible fetch handler for task execution
export default {
  async fetch(request) {
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405, headers: { 'content-type': 'application/json' } });
    }

    const body = await parseBody(request);
    const taskId = body && body.taskId || String(Date.now());
    const attempt = body && body.attempt || 1;

    try {
      let timer;
      const result = await Promise.race([
        handler({ taskId, input: body && body.input, attempt }).then(r => { clearTimeout(timer); return r; }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Task timeout after ' + TIMEOUT_MS + 'ms')), TIMEOUT_MS); }),
      ]);

      return new Response(JSON.stringify({ taskId, attempt, status: 'completed', result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    } catch (err) {
      return new Response(JSON.stringify({ taskId, attempt, status: 'failed', error: err.message }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    }
  },
};
`;
}

// ─── Build Orchestrator ───

export interface BuildResult {
  serverEntry: string;
  functions: { route: ApiRoute; entryPath: string }[];
  taskEntries: { route: ApiRoute; entryPath: string }[];
  manifest: RouteManifest;
}

/**
 * Run the Vura build pipeline.
 *
 * 1. Generate server entry (for hot server deployment)
 * 2. Generate function entries (for serverless deployment)
 * 3. Generate task entries (for serverless task execution)
 * 4. Write manifest.json
 * 5. Run adapter.buildEnd() if configured
 */
export async function build(
  manifest: RouteManifest,
  config: ThenConfig,
  projectRoot: string,
): Promise<BuildResult> {
  const outDir = join(projectRoot, 'dist');
  const serverDir = join(outDir, 'server');
  const functionsDir = join(outDir, 'functions');

  // Ensure output directories
  await mkdir(serverDir, { recursive: true });
  await mkdir(functionsDir, { recursive: true });

  // Bundle API modules for the generated hot server. The generated server is
  // plain ESM and imports `dist/server/api/**/*.js`, so TypeScript source
  // routes must be transpiled even when callers use the core build API
  // directly instead of going through the CLI.
  await bundleServerApiModules(manifest, projectRoot, serverDir);

  // Bundle server-mode page modules (dist/server/pages/**/*.js).
  // The thin server entry imports these at `./pages/...`; they must exist
  // before bundleServerEntry is called so esbuild can resolve them.
  await bundleServerPageModules(manifest, projectRoot, serverDir);

  // Generated route/page artifacts use ESM .js output. Make the dist/server
  // subtree self-describing so Node treats those files as modules even when
  // the source project has no package.json or defaults to CommonJS.
  await writeFile(join(serverDir, 'package.json'), JSON.stringify({ type: 'module' }, null, 2) + '\n');

  // 1. Generate server entry (with global hooks detection)
  const globalHooksFile = findGlobalHooksFile(projectRoot);
  if (globalHooksFile) {
    console.log(`  [then] Global hooks file found: ${globalHooksFile}`);
  }
  const serverEntryCode = generateServerEntry(manifest, projectRoot, globalHooksFile);
  // Write thin source for inspection, then esbuild-bundle it into entry.js
  const thinSourcePath = join(serverDir, 'entry.source.mjs');
  await writeFile(thinSourcePath, serverEntryCode);
  const serverEntryPath = join(serverDir, 'entry.js');
  await bundleServerEntry(thinSourcePath, serverEntryPath, projectRoot);

  // 2. Generate function entries for serverless routes
  const functions: BuildResult['functions'] = [];
  const serverlessRoutes = manifest.api.filter(r => r.kind === 'serverless');

  for (const route of serverlessRoutes) {
    const funcName = route.urlPattern.replace(/[/:*]/g, '_').replace(/^_/, '');
    const funcDir = join(functionsDir, funcName);
    await mkdir(funcDir, { recursive: true });

    const entryCode = generateFunctionEntry(route, projectRoot);
    const entryPath = join(funcDir, 'index.js');
    await writeFile(entryPath, entryCode);
    await bundleRouteModule(route, projectRoot, join(funcDir, 'route.js'), 'neutral');

    functions.push({ route, entryPath });
  }

  // 3. Generate task entries for task routes
  const taskEntries: BuildResult['taskEntries'] = [];
  const taskRoutes = manifest.api.filter(r => r.kind === 'task');

  for (const route of taskRoutes) {
    const funcName = 'task_' + route.urlPattern.replace(/[/:*]/g, '_').replace(/^_/, '');
    const funcDir = join(functionsDir, funcName);
    await mkdir(funcDir, { recursive: true });

    const entryCode = generateTaskEntry(route, projectRoot);
    const entryPath = join(funcDir, 'index.js');
    await writeFile(entryPath, entryCode);
    await bundleRouteModule(route, projectRoot, join(funcDir, 'route.js'), 'neutral');

    taskEntries.push({ route, entryPath });
  }

  // 4. Write manifest
  await writeFile(
    join(outDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
  );

  // 5. Run adapter if configured
  if (config.adapter) {
    const ctx: AdapterBuildContext = {
      serverEntry: serverEntryPath,
      clientDir: join(outDir, 'client'),
      manifest,
      projectRoot,
      outDir,
    };
    await config.adapter.buildEnd(ctx);
  }

  return { serverEntry: serverEntryPath, functions, taskEntries, manifest };
}


// Node built-ins that must be kept external in all server-side bundles.
// 'node:*' covers the prefixed form; bare names cover older import styles.
const NODE_EXTERNAL_BUILTINS = [
  'ws',
  'node:*',
  'http', 'https', 'fs', 'fs/promises', 'path', 'os', 'url', 'crypto',
  'stream', 'events', 'buffer', 'util', 'assert', 'zlib', 'net', 'tls',
  'child_process', 'worker_threads', 'perf_hooks', 'v8', 'vm',
];

async function bundleRouteModule(
  route: Pick<ApiRoute, 'filePath'>,
  projectRoot: string,
  outfile: string,
  platform: 'node' | 'neutral' = 'node',
  /** When true, what-framework is kept external (caller bundles it). Default: false. */
  keepWhatFwExternal = false,
): Promise<void> {
  const absPath = join(projectRoot, route.filePath);
  if (!existsSync(absPath)) {
    throw new Error(`Route source not found for ${route.filePath}: ${absPath}`);
  }

  const { build: esbuild } = await import('esbuild');
  await mkdir(dirname(outfile), { recursive: true });
  const externalList = keepWhatFwExternal
    ? ['what-framework', 'what-framework/*', ...NODE_EXTERNAL_BUILTINS]
    : [...NODE_EXTERNAL_BUILTINS];
  await esbuild({
    entryPoints: [absPath],
    bundle: true,
    format: 'esm',
    target: 'es2022',
    platform,
    outfile,
    nodePaths: [join(projectRoot, 'node_modules'), join(process.cwd(), 'node_modules')],
    plugins: [vuraCoreSelfResolvePlugin()],
    external: externalList,
  });
}

async function bundleServerApiModules(
  manifest: RouteManifest,
  projectRoot: string,
  serverDir: string,
): Promise<void> {
  if (manifest.api.length === 0) return;

  const apiOutDir = join(serverDir, 'api');
  await mkdir(apiOutDir, { recursive: true });

  const modulePaths = new Set(manifest.api.map(route => route.filePath));
  const globalHooksFile = findGlobalHooksFile(projectRoot);
  if (globalHooksFile) modulePaths.add(globalHooksFile);

  for (const filePath of modulePaths) {
    const absPath = join(projectRoot, filePath);
    // Hooks file may not exist (it's optional); route files must exist.
    if (!existsSync(absPath)) {
      const isHooksFile = GLOBAL_HOOKS_FILENAMES.includes(filePath);
      if (isHooksFile) continue;
      throw new Error(`Route source not found for ${filePath}: ${absPath}`);
    }

    const relativeApiPath = filePath.replace(/^src\/api\//, '').replace(/^src\//, '');
    const outFile = relativeApiPath.replace(/\.([mc])?tsx?$/, '.$1js');
    const outPath = join(apiOutDir, outFile);
    await mkdir(dirname(outPath), { recursive: true });

    // Server API modules are imported by the server entry which bundles
    // what-framework — keep it external here to avoid double-bundling.
    await bundleRouteModule({ filePath }, projectRoot, outPath, 'node', true);
  }
}

async function bundleServerPageModules(
  manifest: RouteManifest,
  projectRoot: string,
  serverDir: string,
): Promise<void> {
  const serverPages = manifest.pages.filter(p => p.mode === 'server' || p.mode === 'hybrid');
  const layoutPaths = new Set<string>();
  for (const page of serverPages) {
    if (page.layouts) {
      for (const lp of page.layouts) layoutPaths.add(lp);
    }
  }

  const allPageFiles = [
    ...serverPages.map(p => p.filePath),
    ...layoutPaths,
  ];

  if (allPageFiles.length === 0) return;

  const pageOutDir = join(serverDir, 'pages');
  await mkdir(pageOutDir, { recursive: true });

  for (const filePath of allPageFiles) {
    const absPath = join(projectRoot, filePath);
    if (!existsSync(absPath)) continue;

    const relativePagePath = filePath.replace(/^src\/pages\//, '');
    const outFile = relativePagePath.replace(/\.([mc])?tsx?$/, '.$1js');
    const outPath = join(pageOutDir, outFile);
    await mkdir(dirname(outPath), { recursive: true });

    // Pages import @celsian/vura-core (jsx-runtime) and what-framework — keep
    // what-framework external so it's not double-bundled (server entry bundles it).
    await bundleRouteModule({ filePath }, projectRoot, outPath, 'node', true);
  }
}

// ─── Helpers ───

const _usedVarNames = new Set<string>();

function routeToVarName(route: ApiRoute): string {
  let name = 'route_' + route.urlPattern
    .replace(/^\//, '')
    .replace(/[/:*\-]/g, '_')
    .replace(/_+/g, '_');
  const base = name;
  let i = 2;
  while (_usedVarNames.has(name)) { name = `${base}_${i++}`; }
  _usedVarNames.add(name);
  return name;
}

function pageToVarName(page: PageRoute): string {
  let name = 'page_' + (page.urlPattern === '/' ? 'index' : page.urlPattern
    .replace(/^\//, '')
    .replace(/[/:*\-]/g, '_')
    .replace(/_+/g, '_'));
  const base = name;
  let i = 2;
  while (_usedVarNames.has(name)) { name = `${base}_${i++}`; }
  _usedVarNames.add(name);
  return name;
}

function layoutToVarName(filePath: string): string {
  let name = 'layout_' + filePath
    .replace(/^src\/pages\//, '')
    .replace(/\.[^.]+$/, '')
    .replace(/[/:*\-]/g, '_')
    .replace(/_+/g, '_');
  if (name === 'layout_' || name === 'layout__layout') name = 'layout_root';
  const base = name;
  let i = 2;
  while (_usedVarNames.has(name)) { name = `${base}_${i++}`; }
  _usedVarNames.add(name);
  return name;
}
