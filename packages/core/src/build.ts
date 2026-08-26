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
 * Task cron scheduling and admin endpoints (/__tasks) are handled by
 * startVuraServer via celsian app.cron (Task 11).  Task routes are passed
 * in apiRoutes; createApiApp skips them for HTTP; startVuraServer wires them
 * to cron and the /__tasks admin layer.  generateTaskEntry remains for
 * serverless/adapter invocation paths.
 */

import { writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RouteManifest, ApiRoute, PageRoute } from './manifest.js';
import type { ThenConfig, AdapterBuildContext } from './config.js';
import type { VuraCacheConfig } from './runtime/cache.js';
import { vuraCoreRuntimeShimContents } from './runtime-shim.js';


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
      // The browser-safe subpath resolves to the real module: it has no Node
      // built-ins, so a server bundle can take it as-is.
      build.onResolve({ filter: /^@celsian\/vura-core\/client$/ }, () => ({
        path: coreModuleFile('client'),
      }));
      build.onResolve({ filter: /^@celsian\/vura-core$/ }, () => ({
        path: '@celsian/vura-core',
        namespace: 'vura-core-runtime-shim',
      }));
      build.onLoad({ filter: /.*/, namespace: 'vura-core-runtime-shim' }, () => ({
        loader: 'js',
        resolveDir: CORE_PACKAGE_DIR,
        contents: vuraCoreRuntimeShimContents({ packageDir: CORE_PACKAGE_DIR }),
      }));
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
 * Task routes are passed in apiRoutes; startVuraServer wires them to cron
 * and the /__tasks admin layer (Task 11 complete).
 *
 * cacheConfig (vura.config `cache`) is wired into the entry as non-secret
 * literals only (store/dir/maxEntries/cdn ids). Secrets are always read from
 * env at runtime (VURA_REVALIDATE_SECRET / VURA_CDN_API_TOKEN); `redis` is a
 * build error (live client not serializable — use createVuraCache instead).
 */
export function generateServerEntry(manifest: RouteManifest, projectRoot: string, globalHooksFile?: string | null, cacheConfig?: VuraCacheConfig): string {
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

  // Import project middleware if present (convention: src/middleware.ts).
  // Bundled to dist/server/middleware.js alongside the entry.
  if (manifest.middleware) {
    lines.push("import * as _middlewareMod from './middleware.js';");
  }

  // Import server-action modules (convention: src/actions/*).
  // Bundled to dist/server/actions/ alongside the entry. Importing them here is
  // what puts them in the registry: an action nobody imported cannot be called.
  const actionModules = manifest.actions ?? [];
  const actionVarNames = new Map<string, string>();
  actionModules.forEach((mod, index) => {
    const varName = `_action${index}`;
    actionVarNames.set(mod.moduleId, varName);
    const outRel = mod.filePath
      .replace(/^src\/actions\//, '')
      .replace(/\.([mc])?[tj]sx?$/, '.js');
    lines.push(`import * as ${varName} from './actions/${outRel}';`);
  });

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

  // apiRoutes — all routes (task routes wired to cron + /__tasks admin by startVuraServer)
  lines.push('  apiRoutes: [');
  for (const route of manifest.api) {
    const varName = routeVarNames.get(route.filePath)!;
    lines.push(`    { urlPattern: '${route.urlPattern}', filePath: '${route.filePath}', methods: ${JSON.stringify(route.methods)}, kind: '${route.kind}', hasWebsocket: ${!!route.hasWebsocket}, config: ${JSON.stringify(route.config ?? {})}, module: ${varName} },`);
  }
  lines.push('  ],');

  // pages
  // Hybrid pages ARE served in production (self-host audit A12): the build
  // prerenders them into dist/static and emits a hydration bundle, and the
  // entry's static layer serves both. The remaining true limitation: the
  // runtime pages handler registers only mode === 'server' pages
  // (buildWhatRoutes filters them), so a hybrid page with dynamic params has
  // no per-request SSR — only its literal prerendered pattern path exists on
  // disk, and param-bearing requests fall through to the pagesHandler, which
  // has no route for them. Warn for exactly that case.
  const dynamicHybridPages = serverPages.filter(
    p => p.mode === 'hybrid' && /[:*]/.test(p.urlPattern),
  );
  if (dynamicHybridPages.length > 0) {
    console.warn(
      `[vura] hybrid pages with dynamic params are not SSR'd at runtime — only the literal prerendered path is served (use mode: 'server' for per-request rendering): ${dynamicHybridPages.map(p => p.filePath).join(', ')}`,
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

  // cache — non-secret literals from vura.config; secrets ALWAYS come from env
  // at runtime so they can never be serialized into the build artifact.
  if (cacheConfig?.store === 'redis') {
    throw new Error(
      "[vura] cache.store 'redis' cannot be wired into the generated server entry: " +
      'a redis store needs a live client instance, which is not serializable at build time. ' +
      "Use the programmatic path instead — createVuraCache({ store: 'redis', redisClient }) " +
      "with startVuraServer() in your own server entry. The generated entry supports 'memory' and 'filesystem'.",
    );
  }
  if (cacheConfig?.revalidateSecret || cacheConfig?.cdn?.apiToken) {
    console.warn(
      '[vura] secret values in vura.config cache are ignored in the generated entry — ' +
      'set VURA_REVALIDATE_SECRET / VURA_CDN_API_TOKEN at runtime.',
    );
  }
  lines.push('  cache: {');
  if (cacheConfig?.store) lines.push(`    store: ${JSON.stringify(cacheConfig.store)},`);
  // dir passes through verbatim — a relative dir resolves from the server
  // process cwd (Docker WORKDIR /app → /app/.vura/cache with dist/Dockerfile).
  if (cacheConfig?.dir !== undefined) lines.push(`    dir: ${JSON.stringify(cacheConfig.dir)},`);
  if (cacheConfig?.maxEntries !== undefined) lines.push(`    maxEntries: ${JSON.stringify(cacheConfig.maxEntries)},`);
  lines.push('    revalidateSecret: process.env.VURA_REVALIDATE_SECRET,');
  if (cacheConfig?.cdn) {
    lines.push('    cdn: {');
    lines.push(`      provider: ${JSON.stringify(cacheConfig.cdn.provider)},`);
    if ('zoneId' in cacheConfig.cdn) lines.push(`      zoneId: ${JSON.stringify(cacheConfig.cdn.zoneId)},`);
    if ('serviceId' in cacheConfig.cdn) lines.push(`      serviceId: ${JSON.stringify(cacheConfig.cdn.serviceId)},`);
    lines.push('      apiToken: process.env.VURA_CDN_API_TOKEN,');
    lines.push('    },');
  }
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

  // middleware
  if (manifest.middleware) {
    lines.push('  middleware: _middlewareMod,');
  }

  // server actions, keyed by module id
  if (actionModules.length > 0) {
    lines.push('  actions: {');
    for (const mod of actionModules) {
      lines.push(`    ${JSON.stringify(mod.moduleId)}: ${actionVarNames.get(mod.moduleId)!},`);
    }
    lines.push('  },');
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
    // esbuild anchors every path it touches to its working directory, which
    // defaults to the cwd captured when the module was first loaded — not the
    // cwd at call time. buildProject takes projectRoot precisely because the
    // caller need not be sitting in it (the platform build service calls this
    // programmatically), so anchor explicitly.
    absWorkingDir: projectRoot,
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
export function generateFunctionEntry(route: ApiRoute, projectRoot: string, globalHooksFile?: string | null): string {
  const varName = routeToVarName(route);
  return `import * as ${varName} from './route.js';
${globalHooksFile ? "import * as globalHooksMod from './hooks.js';" : 'const globalHooksMod = {};'}
const handlers = { ${route.methods.map(m => `${m}: ${varName}.${m}`).join(', ')} };
function parseBody(request) {
  const ct = request.headers.get('content-type') || '';
  if (!request.body) return Promise.resolve(null);
  if (ct.includes('application/json')) return request.json().catch(() => null);
  if (ct.includes('application/x-www-form-urlencoded')) return request.text().then(t => Object.fromEntries(new URLSearchParams(t)));
  return request.text();
}
function routeParams(pathname) {
  const expected = ${JSON.stringify(route.urlPattern)}.split('/').filter(Boolean);
  const actual = pathname.split('/').filter(Boolean);
  const params = {};
  let cursor = 0;
  for (const segment of expected) {
    if (segment === '*') {
      params.wildcard = decodeURIComponent(actual.slice(cursor).join('/'));
      cursor = actual.length;
      break;
    }
    const value = actual[cursor];
    if (value === undefined) return {};
    if (segment.startsWith(':')) params[segment.slice(1)] = decodeURIComponent(value);
    else if (segment !== value) return {};
    cursor += 1;
  }
  return cursor === actual.length ? params : {};
}
function normalizeHooks(hooks) {
  if (!hooks) return undefined;
  const list = (value) => value ? (Array.isArray(value) ? value : [value]) : [];
  return { onRequest: list(hooks.onRequest), onError: list(hooks.onError), onResponse: list(hooks.onResponse) };
}

function mergeHooks(globalHooks, routeHooks) {
  const merged = (name) => [...(globalHooks?.[name] || []), ...(routeHooks?.[name] || [])];
  return { onRequest: merged('onRequest'), onError: merged('onError'), onResponse: merged('onResponse') };
}

function validationIssues(target, error) {
  const issues = error && Array.isArray(error.issues)
    ? error.issues
    : [{ path: [], message: error?.message || 'Invalid value' }];
  return { target, issues: issues.map((issue) => ({
      path: Array.isArray(issue.path) ? issue.path.join('.') : String(issue.path || ''),
      message: issue.message || 'Invalid value',
      ...(issue.code ? { code: issue.code } : {}),
  })) };
}

function validateRequest(req, schema) {
  const errors = [];
  if (schema.body) {
    const result = schema.body.safeParse(req.parsedBody);
    if (!result.success) errors.push(validationIssues('body', result.error));
    else { req.parsedBody = result.data; req.body = result.data; }
  }
  if (schema.query) {
    const result = schema.query.safeParse(req.query);
    if (!result.success) errors.push(validationIssues('query', result.error));
    // Match the celsian runtime: the validated+coerced output replaces
    // req.query, so reading it never hands back input that skipped the schema.
    // req.parsedQuery is the explicitly-typed alias.
    else { req.parsedQuery = result.data; req.query = result.data; }
  }
  if (schema.params) {
    const result = schema.params.safeParse(req.params);
    if (!result.success) errors.push(validationIssues('params', result.error));
    else req.params = result.data;
  }
  if (errors.length) {
    const issueCount = errors.reduce((count, error) => count + error.issues.length, 0);
    const message = 'Validation failed: ' + issueCount + ' issue' + (issueCount > 1 ? 's' : '')
      + ' in ' + errors.map((error) => error.target).join(', ');
    return { statusCode: 400, body: { error: message, code: 'VALIDATION_ERROR', details: errors } };
  }
  req.validated = {
    body: req.parsedBody,
    query: schema.query ? req.parsedQuery : req.query,
    params: req.params,
  };
  return null;
}

async function runHooks(hooks, ...args) {
  for (const hook of hooks || []) await hook(...args);
}

async function runOnError(error, req, reply, hooks) {
  let handled = false;
  for (const hook of hooks || []) {
    try { await hook(error, req, reply); handled = true; }
    catch (hookError) { error = hookError; }
  }
  return { handled, error };
}

const globalHooks = normalizeHooks(globalHooksMod);
const routeHooks = normalizeHooks(${varName}.hooks || {
  onRequest: ${varName}.onRequest,
  onError: ${varName}.onError,
  onResponse: ${varName}.onResponse,
});
const lifecycleHooks = mergeHooks(globalHooks, routeHooks);
const routeSchema = ${varName}.schema;

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
    const req = request;
    Object.defineProperties(req, {
      params: { value: routeParams(url.pathname), writable: true, configurable: true, enumerable: true },
      query: { value: Object.fromEntries(url.searchParams.entries()), writable: true, configurable: true, enumerable: true },
      parsedBody: { value: body, writable: true, configurable: true, enumerable: true },
      body: { get() { return req.parsedBody; }, set(value) { req.parsedBody = value; }, configurable: true },
    });

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

    const startedAt = performance.now();
    let result;
    let hadError = false;
    try {
      await runHooks(lifecycleHooks.onRequest, req, reply);
      if (routeSchema) {
        const validationError = validateRequest(req, routeSchema);
        if (validationError) {
          statusCode = validationError.statusCode;
          responseBody = JSON.stringify(validationError.body);
        }
      }
      if (responseBody === null) result = await handlerFn(req, reply);
    } catch (error) {
      hadError = true;
      // Only an error Vura constructed may choose its own status. A library
      // error that happens to carry a statusCode must not be able to pick one
      // and, by picking a non-500, opt itself out of the sanitisation below —
      // that is how a connection string ends up on the wire. The brand is
      // Symbol.for-keyed because every bundle inlines its own copy of core, so
      // an instanceof check is false for exactly the errors this must allow.
      statusCode = error && error[Symbol.for('vura.http-error')] === true && error.statusCode ? error.statusCode : 500;
      const handled = await runOnError(error, req, reply, lifecycleHooks.onError);
      if (!handled.handled && responseBody === null) {
        responseBody = JSON.stringify({
          error: statusCode === 500 ? 'Internal Server Error' : (handled.error?.message || 'Request failed'),
        });
      }
    } finally {
      const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
      try {
        await runHooks(lifecycleHooks.onResponse, req, reply, { statusCode, durationMs, hadError });
      } catch {}
    }
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
 * Generate the serverless entry SOURCE for a task route. The emitted file is a
 * THIN wiring module (like the server entry): it delegates execution to core's
 * `runTaskOnce` — the single task executor — so the serverless path has the
 * exact same semantics as the hot server: input-schema validation (skipped for
 * cron/synthetic dispatches), framework-owned retries with per-attempt timeout,
 * the platform dispatch header protocol (X-Vura-Task-Id wrapper unwrap,
 * X-Vura-Cron exemption), and the Phase-2 durable-run fields (`runId`, `steps`,
 * `step` on the handler ctx, suspend envelopes). build() esbuild-bundles this
 * source into a self-contained index.js (Workers have no node_modules).
 */
export function generateTaskEntry(route: ApiRoute, projectRoot: string): string {
  const varName = routeToVarName(route);
  const timeoutMs = (route.config.timeout as number) || 30000;
  const retries = typeof route.config.retries === 'number' ? route.config.retries : 0;
  // Dot-form task name — must match the hot server + platform (deriveTaskName).
  const taskName = route.urlPattern.replace(/^\/api\//, '').replace(/\//g, '.');

  return `import * as ${varName} from './route.js';
import { runTaskOnce, buildTaskEnvelope } from '@celsian/vura-core';

const TASK_NAME = ${JSON.stringify(taskName)};
const MAX_BODY_BYTES = 64 * 1024;

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// Worker-compatible fetch handler for task execution
export default {
  async fetch(request) {
    if (request.method !== 'POST') {
      return json(405, { error: 'Method Not Allowed' });
    }
    if (typeof ${varName}.POST !== 'function') {
      return json(500, { error: 'Task must export a POST handler' });
    }

    // Optional JSON body, size-capped like the hot server's /__tasks path.
    const text = await request.text().catch(() => '');
    if (text.length > MAX_BODY_BYTES) {
      return json(413, { error: 'Request body exceeds ' + MAX_BODY_BYTES + ' bytes' });
    }
    let body = null;
    if (text) {
      try { body = JSON.parse(text); } catch { return json(400, { error: 'Request body must be valid JSON' }); }
    }

    // Platform dispatch header protocol (same as the hot server):
    //   X-Vura-Task-Id → wrapper body { taskId, runId?, input, attempt, steps? };
    //                    the real payload is body.input, not the body itself.
    //   X-Vura-Cron    → synthetic input (cron/manual); skip input validation.
    const isPlatformDispatch = (request.headers.get('x-vura-task-id') ?? '') !== '';
    const isPlatformCron = (request.headers.get('x-vura-cron') ?? '').toLowerCase() === 'true';
    const wrapper = isPlatformDispatch && body && typeof body === 'object' ? body : undefined;
    const rawPayload = isPlatformDispatch ? (wrapper ? wrapper.input : undefined) : body;
    const runId = wrapper && typeof wrapper.runId === 'string' ? wrapper.runId : undefined;
    const steps = wrapper && wrapper.steps && typeof wrapper.steps === 'object' ? wrapper.steps : {};

    const result = await runTaskOnce(
      {
        name: TASK_NAME,
        config: { retries: ${retries}, timeout: ${timeoutMs} },
        handler: ${varName}.POST,
        inputSchema: isPlatformCron ? undefined : ${varName}.input,
      },
      {
        input: rawPayload,
        runId,
        steps,
        // A platform dispatch implies durable suspend/resume; otherwise fall
        // back to env detection (enqueue bindings present = platform).
        hasPlatform: isPlatformDispatch ? true : undefined,
      },
    );

    // Schema rejection is terminal and consumes no attempts — surface the 400
    // body verbatim so the platform records it as a validation failure.
    if (result.validationError) {
      return json(result.validationError.statusCode, result.validationError.body);
    }

    const envelope = buildTaskEnvelope(TASK_NAME, result);
    return json(envelope.ok ? 200 : 500, envelope);
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

  // Function and task artifacts are ESM .js files. Keep the entire subtree
  // self-describing for Node 20 and tools that do not perform syntax-based
  // module detection.
  await writeFile(join(functionsDir, 'package.json'), JSON.stringify({ type: 'module' }, null, 2) + '\n');

  // Bundle API modules for the generated hot server. The generated server is
  // plain ESM and imports `dist/server/api/**/*.js`, so TypeScript source
  // routes must be transpiled even when callers use the core build API
  // directly instead of going through the CLI.
  await bundleServerApiModules(manifest, projectRoot, serverDir);

  // Bundle server-mode page modules (dist/server/pages/**/*.js).
  // The thin server entry imports these at `./pages/...`; they must exist
  // before bundleServerEntry is called so esbuild can resolve them.
  await bundleServerPageModules(manifest, projectRoot, serverDir);

  // Bundle project middleware (dist/server/middleware.js), next to the entry
  // that imports it.
  await bundleMiddlewareModule(manifest, projectRoot, serverDir);

  // Bundle server actions (dist/server/actions/**/*.js), next to the entry that
  // imports them.
  await bundleServerActionModules(manifest, projectRoot, serverDir);

  // Generated route/page artifacts use ESM .js output. Make the dist/server
  // subtree self-describing so Node treats those files as modules even when
  // the source project has no package.json or defaults to CommonJS.
  await writeFile(join(serverDir, 'package.json'), JSON.stringify({ type: 'module' }, null, 2) + '\n');

  // 1. Generate server entry (with global hooks detection)
  const globalHooksFile = findGlobalHooksFile(projectRoot);
  if (globalHooksFile) {
    console.log(`  [then] Global hooks file found: ${globalHooksFile}`);
  }
  const serverEntryCode = generateServerEntry(manifest, projectRoot, globalHooksFile, config.cache);
  // Write thin source for inspection, then esbuild-bundle it into entry.js
  const thinSourcePath = join(serverDir, 'entry.source.mjs');
  await writeFile(thinSourcePath, serverEntryCode);
  const serverEntryPath = join(serverDir, 'entry.js');
  await bundleServerEntry(thinSourcePath, serverEntryPath, projectRoot);

  // 2. Generate function entries for serverless routes
  const functions: BuildResult['functions'] = [];
  const serverlessRoutes = manifest.api.filter(r => r.kind === 'serverless');
  let globalHooksBundle: Buffer | undefined;
  if (globalHooksFile && serverlessRoutes.length > 0) {
    const bundledHooksPath = join(functionsDir, '_global-hooks.js');
    await bundleRouteModule({ filePath: globalHooksFile }, projectRoot, bundledHooksPath, 'neutral');
    globalHooksBundle = await readFile(bundledHooksPath);
    await rm(bundledHooksPath, { force: true });
  }

  for (const route of serverlessRoutes) {
    const funcName = route.urlPattern.replace(/[/:*]/g, '_').replace(/^_/, '');
    const funcDir = join(functionsDir, funcName);
    await mkdir(funcDir, { recursive: true });

    const entryCode = generateFunctionEntry(route, projectRoot, globalHooksFile);
    const entryPath = join(funcDir, 'index.js');
    await writeFile(entryPath, entryCode);
    await bundleRouteModule(route, projectRoot, join(funcDir, 'route.js'), 'neutral');
    if (globalHooksBundle) await writeFile(join(funcDir, 'hooks.js'), globalHooksBundle);

    functions.push({ route, entryPath });
  }

  // 3. Generate task entries for task routes
  const taskEntries: BuildResult['taskEntries'] = [];
  const taskRoutes = manifest.api.filter(r => r.kind === 'task');

  for (const route of taskRoutes) {
    const funcName = 'task_' + route.urlPattern.replace(/[/:*]/g, '_').replace(/^_/, '');
    const funcDir = join(functionsDir, funcName);
    await mkdir(funcDir, { recursive: true });

    // route.js must exist before the entry is bundled (the thin source imports it).
    await bundleRouteModule(route, projectRoot, join(funcDir, 'route.js'), 'neutral');

    // Thin source delegating to core runTaskOnce (written for inspection, like
    // entry.source.mjs), then esbuild-bundled self-contained for Workers.
    const entryCode = generateTaskEntry(route, projectRoot);
    const sourcePath = join(funcDir, 'index.source.mjs');
    await writeFile(sourcePath, entryCode);
    const entryPath = join(funcDir, 'index.js');
    await bundleTaskEntry(sourcePath, entryPath, projectRoot);

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
    jsx: 'automatic',
    jsxImportSource: '@celsian/vura-core',
    absWorkingDir: projectRoot,
    nodePaths: [join(projectRoot, 'node_modules'), join(process.cwd(), 'node_modules')],
    plugins: [vuraCoreSelfResolvePlugin()],
    external: externalList,
    ...(platform === 'neutral' ? { banner: { js: 'const process = globalThis.process || { env: {} };' } } : {}),
  });
}

/**
 * Bundle a generated task-entry thin source into a self-contained Workers
 * module. Neutral platform (no Node builtins at runtime), `./route.js` inlined
 * from the already-bundled sibling, core runtime inlined via the self-resolve
 * shim, and the same `process` shim banner as other neutral bundles (core's
 * enqueue/steps read process.env for platform detection).
 */
async function bundleTaskEntry(
  sourcePath: string,
  outfile: string,
  projectRoot: string,
): Promise<void> {
  const { build: esbuild } = await import('esbuild');
  await esbuild({
    entryPoints: [sourcePath],
    bundle: true,
    format: 'esm',
    target: 'es2022',
    platform: 'neutral',
    outfile,
    absWorkingDir: projectRoot,
    nodePaths: [join(projectRoot, 'node_modules'), join(process.cwd(), 'node_modules')],
    plugins: [vuraCoreSelfResolvePlugin()],
    external: [...NODE_EXTERNAL_BUILTINS],
    banner: { js: 'const process = globalThis.process || { env: {} };' },
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

/**
 * Bundle `src/middleware.ts` to `dist/server/middleware.js`.
 *
 * Same externals as a page module: what-framework stays external so it is not
 * double-bundled, and `@celsian/vura-core` resolves through the runtime shim.
 */
async function bundleMiddlewareModule(
  manifest: RouteManifest,
  projectRoot: string,
  serverDir: string,
): Promise<void> {
  if (!manifest.middleware) return;
  const absPath = join(projectRoot, manifest.middleware);
  if (!existsSync(absPath)) return;

  await mkdir(serverDir, { recursive: true });
  await bundleRouteModule(
    { filePath: manifest.middleware },
    projectRoot,
    join(serverDir, 'middleware.js'),
    'node',
    true,
  );
}

/**
 * Bundle every `src/actions/*` module to `dist/server/actions/`.
 *
 * Same externals as a page or middleware module: what-framework stays external
 * so it is not double-bundled, and `@celsian/vura-core` resolves through the
 * runtime shim. The stub plugin is deliberately absent — this is the server
 * side, where the real implementation is the point.
 */
async function bundleServerActionModules(
  manifest: RouteManifest,
  projectRoot: string,
  serverDir: string,
): Promise<void> {
  const actions = manifest.actions ?? [];
  if (actions.length === 0) return;

  const actionsOutDir = join(serverDir, 'actions');
  await mkdir(actionsOutDir, { recursive: true });

  for (const mod of actions) {
    const absPath = join(projectRoot, mod.filePath);
    if (!existsSync(absPath)) continue;

    const outFile = mod.filePath
      .replace(/^src\/actions\//, '')
      .replace(/\.([mc])?[tj]sx?$/, '.js');
    const outPath = join(actionsOutDir, outFile);
    await mkdir(dirname(outPath), { recursive: true });

    await bundleRouteModule({ filePath: mod.filePath }, projectRoot, outPath, 'node', true);
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
