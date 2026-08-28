/**
 * @celsian/vura-adapter-cloudflare
 *
 * Adapts Vura build output for Cloudflare Workers deployment.
 *
 * Because Cloudflare Workers natively use the Web Standard Request/Response API
 * (the same as CelsianJS), this adapter is thin — it mainly generates:
 *   1. wrangler.toml configuration
 *   2. Worker entry files that wire routes to a CelsianJS app
 *
 * Supports multiple worker groups, KV namespaces, D1 databases, and R2 buckets.
 */

import { writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vuraCoreRuntimeShimContents, serverlessRevalidateStubs, pruneStaleOutputs, GLOBAL_HOOKS_FILENAMES } from '@celsian/vura-core';
import type { ThenAdapter, AdapterBuildContext } from '@celsian/vura-core';
import type { RouteManifest, ApiRoute } from '@celsian/vura-core';


const require = createRequire(import.meta.url);

function resolveCorePackageDir(): string {
  try {
    return dirname(require.resolve('@celsian/vura-core'));
  } catch {
    const localCore = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@celsian', 'vura-core');
    return join(localCore, existsSync(join(localCore, 'src')) ? 'src' : 'dist');
  }
}

const CORE_PACKAGE_DIR = resolveCorePackageDir();

function coreModuleExt(moduleName: string): string {
  return existsSync(join(CORE_PACKAGE_DIR, `${moduleName}.ts`)) ? 'ts' : 'js';
}

function vuraCoreRuntimeShimPlugin() {
  return {
    name: 'vura-core-runtime-shim',
    setup(build: any) {
      build.onResolve({ filter: /^@celsian\/vura-core\/(jsx-runtime|jsx-dev-runtime)$/ }, () => ({
        path: join(CORE_PACKAGE_DIR, `jsx-runtime.${coreModuleExt('jsx-runtime')}`),
      }));
      build.onResolve({ filter: /^@celsian\/vura-core$/ }, () => ({
        path: '@celsian/vura-core',
        namespace: 'vura-core-runtime-shim',
      }));
      build.onLoad({ filter: /.*/, namespace: 'vura-core-runtime-shim' }, () => ({
        loader: 'js',
        resolveDir: CORE_PACKAGE_DIR,
        contents: vuraCoreRuntimeShimContents({
          packageDir: CORE_PACKAGE_DIR,
          // Workers bundles carry no Node server runtime.
          includeServerRuntime: false,
          extra: serverlessRevalidateStubs('Workers'),
        }),
      }));
    },
  };
}

// ─── Types ───

export interface KVBinding {
  /** Binding name accessible in env */
  binding: string;
  /** KV namespace ID */
  id: string;
  /** Optional preview ID for local dev */
  preview_id?: string;
}

export interface D1Binding {
  /** Binding name accessible in env */
  binding: string;
  /** D1 database name */
  database_name: string;
  /** D1 database ID */
  database_id: string;
}

export interface R2Binding {
  /** Binding name accessible in env */
  binding: string;
  /** R2 bucket name */
  bucket_name: string;
}

export interface WorkerRoute {
  /** URL pattern, e.g. "example.com/api/*" */
  pattern: string;
  /** Optional zone name */
  zone_name?: string;
}

export interface CloudflareAdapterOptions {
  /** Worker name (used in wrangler.toml) */
  name: string;
  /** Compatibility date for the Workers runtime (default: today's date) */
  compatibilityDate?: string;
  /** Route patterns to attach the worker to */
  routes?: WorkerRoute[];
  /** KV namespace bindings */
  kv?: KVBinding[];
  /** D1 database bindings */
  d1?: D1Binding[];
  /** R2 bucket bindings */
  r2?: R2Binding[];
  /** Optional: group routes into separate workers by config key */
  workerGroup?: string;
}

// ─── Wrangler TOML Generator ───

/**
 * Generate a wrangler.toml configuration string from adapter options and routes.
 */
export function generateWranglerToml(
  options: CloudflareAdapterOptions,
  routes: ApiRoute[],
  taskRoutes: ApiRoute[] = [],
): string {
  const lines: string[] = [];

  lines.push(`name = "${options.name}"`);
  lines.push(`main = "entry.js"`);
  lines.push(
    `compatibility_date = "${options.compatibilityDate ?? toDateString(new Date())}"`,
  );
  lines.push('');

  // Route patterns
  if (options.routes && options.routes.length > 0) {
    lines.push('# Routes');
    for (const route of options.routes) {
      lines.push('[[routes]]');
      lines.push(`pattern = "${route.pattern}"`);
      if (route.zone_name) {
        lines.push(`zone_name = "${route.zone_name}"`);
      }
      lines.push('');
    }
  }

  // KV bindings
  if (options.kv && options.kv.length > 0) {
    lines.push('# KV Namespaces');
    for (const kv of options.kv) {
      lines.push('[[kv_namespaces]]');
      lines.push(`binding = "${kv.binding}"`);
      lines.push(`id = "${kv.id}"`);
      if (kv.preview_id) {
        lines.push(`preview_id = "${kv.preview_id}"`);
      }
      lines.push('');
    }
  }

  // D1 bindings
  if (options.d1 && options.d1.length > 0) {
    lines.push('# D1 Databases');
    for (const d1 of options.d1) {
      lines.push('[[d1_databases]]');
      lines.push(`binding = "${d1.binding}"`);
      lines.push(`database_name = "${d1.database_name}"`);
      lines.push(`database_id = "${d1.database_id}"`);
      lines.push('');
    }
  }

  // R2 bindings
  if (options.r2 && options.r2.length > 0) {
    lines.push('# R2 Buckets');
    for (const r2 of options.r2) {
      lines.push('[[r2_buckets]]');
      lines.push(`binding = "${r2.binding}"`);
      lines.push(`bucket_name = "${r2.bucket_name}"`);
      lines.push('');
    }
  }

  // Cron triggers from task routes
  const cronTasks = taskRoutes.filter(r => r.config.schedule);
  if (cronTasks.length > 0) {
    lines.push('# Cron Triggers');
    lines.push('[triggers]');
    lines.push(`crons = [${cronTasks.map(r => `"${r.config.schedule}"`).join(', ')}]`);
    lines.push('');
  }

  return lines.join('\n');
}

// ─── Worker Entry Generator ───

/**
 * Generate a self-contained Worker entry file that routes requests
 * to the appropriate handler using @celsian/vura-core's req/reply pattern.
 * No CelsianJS dependency required — works standalone.
 *
 * `globalHooksFile` is the project's conventional hooks file (src/api/_hooks.ts
 * or src/hooks.ts) when it exists. buildEnd bundles it next to this entry as
 * hooks.js; the entry imports it and merges its hooks ahead of each route's
 * own, which is the order the hot server and the generated dist/functions/
 * entry both use. Passing null emits an empty stand-in so no import is left
 * dangling.
 */
export function generateWorkerEntry(
  routes: ApiRoute[],
  projectRoot: string,
  workerDir: string,
  taskRoutes: ApiRoute[] = [],
  globalHooksFile?: string | null,
): string {
  const imports: string[] = [];
  const routeTable: string[] = [];

  for (const route of routes) {
    const varName = routeToVarName(route);
    const importPath = `./routes/${routeModuleFileName(route)}`;
    imports.push(`import * as ${varName} from '${importPath}';`);

    routeTable.push(`  { pattern: '${route.urlPattern}', methods: [${route.methods.map(m => `'${m}'`).join(', ')}], handlers: ${varName} },`);
  }

  // Import task route handlers
  const taskImports: string[] = [];
  const taskTable: string[] = [];
  for (const route of taskRoutes) {
    const varName = routeToVarName(route);
    const importPath = `./routes/${routeModuleFileName(route)}`;
    taskImports.push(`import * as ${varName} from '${importPath}';`);
    const taskName = route.urlPattern.replace(/^\/api\//, '').replace(/\//g, '.');
    const schedule = route.config.schedule ? `'${route.config.schedule}'` : 'null';
    taskTable.push(`  { name: '${taskName}', handler: ${varName}.POST, schedule: ${schedule} },`);
  }

  const allImports = [...imports, ...taskImports].join('\n');
  const hooksImport = globalHooksFile
    ? "import * as globalHooksMod from './hooks.js';"
    : 'const globalHooksMod = {};';

  return `${allImports}
${hooksImport}

const routes = [
${routeTable.join('\n')}
];

function matchRoute(pathname, method) {
  for (const route of routes) {
    if (!route.methods.includes(method)) continue;
    const paramNames = [];
    let regexStr = '';
    let i = 0;
    while (i < route.pattern.length) {
      if (route.pattern[i] === ':' && i > 0 && route.pattern[i-1] === '/') {
        let name = ''; i++;
        while (i < route.pattern.length && /[a-zA-Z0-9_]/.test(route.pattern[i])) { name += route.pattern[i]; i++; }
        paramNames.push(name); regexStr += '([^/]+)';
      } else if (route.pattern[i] === '*') {
        paramNames.push('*'); regexStr += '(.*)'; i++;
      } else {
        const ch = route.pattern[i];
        if ('.+?^\${}()|[]\\\\'.includes(ch)) regexStr += '\\\\' + ch;
        else regexStr += ch;
        i++;
      }
    }
    const match = pathname.match(new RegExp('^' + regexStr + '\$'));
    if (match) {
      const params = {};
      paramNames.forEach((name, idx) => { try { params[name] = decodeURIComponent(match[idx + 1]); } catch { params[name] = match[idx + 1]; } });
      return { route, params };
    }
  }
  return null;
}

function parseBody(request) {
  const ct = request.headers.get('content-type') || '';
  if (!request.body) return Promise.resolve(null);
  if (ct.includes('application/json')) return request.json().catch(() => null);
  if (ct.includes('application/x-www-form-urlencoded')) return request.text().then(t => Object.fromEntries(new URLSearchParams(t)));
  return request.text();
}

// The hot server and core's dist/functions/ entry both hand a hook a request
// whose headers answer .get(); these two adapters hand it a plain lowercased
// object, so the auth snippet the hooks reference prints —
// req.headers.get('authorization') — threw here. A hooks file is written once
// and deployed to every target, so the accessor is added rather than the object
// replaced: .get/.has are non-enumerable, so Object.keys, spread and
// JSON.stringify over req.headers are unchanged and existing
// req.headers['x-thing'] reads keep working.
function withHeaderAccessors(headers) {
  const read = (name) => {
    const value = headers[String(name).toLowerCase()];
    return value === undefined ? null : value;
  };
  Object.defineProperties(headers, {
    get: { value: read, writable: true, configurable: true, enumerable: false },
    has: { value: (name) => read(name) !== null, writable: true, configurable: true, enumerable: false },
  });
  return headers;
}

function normalizeHooks(hooks) {
  if (!hooks) return undefined;
  return {
    onRequest: hooks.onRequest ? (Array.isArray(hooks.onRequest) ? hooks.onRequest : [hooks.onRequest]) : undefined,
    onError: hooks.onError ? (Array.isArray(hooks.onError) ? hooks.onError : [hooks.onError]) : undefined,
    onResponse: hooks.onResponse ? (Array.isArray(hooks.onResponse) ? hooks.onResponse : [hooks.onResponse]) : undefined,
  };
}

function validationIssues(target, error) {
  const issues = (error && Array.isArray(error.issues)) ? error.issues : [{ path: [], message: error?.message || 'Invalid value' }];
  return { target, issues: issues.map(i => ({ path: Array.isArray(i.path) ? i.path.join('.') : String(i.path || ''), message: i.message || 'Invalid value', ...(i.code ? { code: i.code } : {}) })) };
}

function validateRequest(req, schema) {
  const errors = [];
  if (schema.body) {
    const r = schema.body.safeParse(req.parsedBody);
    if (!r.success) errors.push(validationIssues('body', r.error));
    else { req.parsedBody = r.data; req.body = r.data; }
  }
  if (schema.query) {
    const r = schema.query.safeParse(req.query);
    if (!r.success) errors.push(validationIssues('query', r.error));
    // Match the celsian runtime: the validated+coerced output replaces
    // req.query, so reading it never hands back input that skipped the schema.
    // req.parsedQuery is the explicitly-typed alias.
    else { req.parsedQuery = r.data; req.query = r.data; }
  }
  if (schema.params) {
    const r = schema.params.safeParse(req.params);
    if (!r.success) errors.push(validationIssues('params', r.error));
    else req.params = r.data;
  }
  if (errors.length > 0) {
    const issueCount = errors.reduce((acc, e) => acc + e.issues.length, 0);
    const message = 'Validation failed: ' + issueCount + ' issue' + (issueCount > 1 ? 's' : '') + ' in ' + errors.map(e => e.target).join(', ');
    return { statusCode: 400, body: { error: message, code: 'VALIDATION_ERROR', details: errors } };
  }
  req.validated = { body: req.parsedBody, query: schema.query ? req.parsedQuery : req.query, params: req.params };
  return null;
}

// Global hooks run before the route's own, in each phase. Same merge the
// generated dist/functions/ entry does: an app-wide auth or audit hook has to
// see a request before anything a single route registered.
function mergeHooks(globalHooks, routeHooks) {
  const merged = (name) => [...(globalHooks?.[name] || []), ...(routeHooks?.[name] || [])];
  return { onRequest: merged('onRequest'), onError: merged('onError'), onResponse: merged('onResponse') };
}

async function runHooks(hooks, ...args) {
  if (!hooks) return;
  for (const hook of hooks) await hook(...args);
}

async function runOnError(err, req, reply, lifecycleHooks) {
  if (!lifecycleHooks?.onError?.length) return { handled: false, error: err };
  let handled = false;
  for (const hook of lifecycleHooks.onError) {
    try { await hook(err, req, reply); handled = true; }
    catch (hookErr) { err = hookErr; }
  }
  return { handled, error: err };
}

const globalHooks = normalizeHooks(globalHooksMod);

${taskTable.length > 0 ? `const taskRoutes = [\n${taskTable.join('\n')}\n];\n` : ''}
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    if (url.pathname === '/__health') {
      return new Response(JSON.stringify({ ok: true, framework: 'Vura' }), { headers: { 'Content-Type': 'application/json' } });
    }

    const match = matchRoute(url.pathname, method);
    if (!match) {
      return new Response(JSON.stringify({ error: 'Not Found', path: url.pathname }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

    const handlerFn = match.route.handlers[method];
    const routeHooks = normalizeHooks(match.route.handlers.hooks || match.route.handlers);
    const lifecycleHooks = mergeHooks(globalHooks, routeHooks);
    const routeSchema = match.route.handlers.schema;
    if (typeof handlerFn !== 'function') {
      return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
    }

    const body = await parseBody(request);
    const req = {
      method,
      url: url.pathname,
      headers: withHeaderAccessors(Object.fromEntries(request.headers.entries())),
      params: match.params,
      query: Object.fromEntries(url.searchParams.entries()),
      body,
      parsedBody: body,
      __cf_env: env,
      __cf_ctx: ctx,
    };

    let statusCode = 200;
    const responseHeaders = { 'content-type': 'application/json' };
    let responseBody = null;
    const reply = {
      status(code) { statusCode = code; return reply; },
      header(name, value) { responseHeaders[name] = value; return reply; },
      json(data) { responseBody = JSON.stringify(data); return null; },
      send(data) { responseBody = data; return null; },
      redirect(url, status) { statusCode = status || 302; responseHeaders.location = url; responseBody = 'Redirecting to ' + url; return null; },
    };

    const startedAt = performance.now();
    let result;
    let hadError = false;
    try {
      await runHooks(lifecycleHooks.onRequest, req, reply);
      // Validation moved behind the onRequest hooks and inside the try, which
      // is where the generated dist/functions/ entry has always had it. It was
      // in front, and returning early: an unauthenticated caller got the
      // route's 400 schema report instead of the hooks file's 401, and
      // onResponse — documented as running once per request whatever the
      // outcome — never saw a rejected request at all.
      if (routeSchema && responseBody === null) {
        const validationError = validateRequest(req, routeSchema);
        if (validationError) {
          statusCode = validationError.statusCode;
          responseBody = JSON.stringify(validationError.body);
        }
      }
      // A hook that answered (reply.json/send/redirect) short-circuits the
      // handler. Without this the handler still ran behind a hook's 401: the
      // caller saw the 401, and the handler had already charged the API call,
      // written the row, or read the record it was being denied.
      if (responseBody === null) result = await handlerFn(req, reply);
    } catch (err) {
      hadError = true;
      // Only an error Vura constructed may choose its own status — see the
      // note in core's generateFunctionEntry. Brand-keyed rather than an
      // instanceof check because each bundle inlines its own copy of core.
      statusCode = err && err[Symbol.for('vura.http-error')] === true && err.statusCode ? err.statusCode : 500;
      const errorResult = await runOnError(err, req, reply, lifecycleHooks);
      if (!errorResult.handled && responseBody === null) {
        responseBody = JSON.stringify({ error: statusCode === 500 ? 'Internal Server Error' : (errorResult.error?.message || 'Request failed') });
      }
    } finally {
      const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
      try { await runHooks(lifecycleHooks.onResponse, req, reply, { statusCode, durationMs, hadError }); } catch {}
    }

    if (result instanceof Response) return result;
    if (responseBody !== null) return new Response(responseBody, { status: statusCode, headers: responseHeaders });
    if (result && typeof result === 'object') return new Response(JSON.stringify(result), { status: statusCode, headers: responseHeaders });
    return new Response(null, { status: 204 });
  },
${taskTable.length > 0 ? `
  async scheduled(event, env, ctx) {
    // Execute all task routes that have schedules
    const results = [];
    for (const task of taskRoutes) {
      if (task.schedule !== event.cron) continue;
      if (typeof task.handler === 'function') {
        try {
          const result = await task.handler({
            taskId: String(Date.now()),
            input: { _cron: true, _schedule: task.schedule },
            attempt: 1,
          });
          results.push({ task: task.name, status: 'completed', result });
        } catch (err) {
          results.push({ task: task.name, status: 'failed', error: err.message });
        }
      }
    }
    return results;
  },
` : ''}};
`;
}

// ─── Worker Handler Wrapper ───

/**
 * Wrap a CelsianJS app instance as a Cloudflare Worker fetch handler.
 *
 * CelsianJS already uses Web Standard Request/Response, so this is a thin wrapper
 * that passes Cloudflare env bindings and execution context to route handlers
 * via properties on the request object.
 *
 * @example
 * ```ts
 * import { createApp } from '@celsian/core';
 * import { createWorkerHandler } from '@celsian/vura-adapter-cloudflare';
 *
 * const app = createApp();
 * app.get('/hello', (req) => new Response('Hello!'));
 *
 * export default createWorkerHandler(app);
 * ```
 */
export function createWorkerHandler(app: CelsianApp): CloudflareWorkerHandler {
  return {
    async fetch(
      request: Request,
      env: Record<string, unknown>,
      ctx: ExecutionContext,
    ): Promise<Response> {
      // Attach CF bindings to the request so handlers can access KV, D1, R2, etc.
      (request as CloudflareRequest).__cf_env = env;
      (request as CloudflareRequest).__cf_ctx = ctx;
      return app.handle(request);
    },
  };
}

// ─── Adapter Factory ───

/**
 * Create a Vura adapter for Cloudflare Workers deployment.
 *
 * @example
 * ```ts
 * // vura.config.ts
 * import { defineConfig } from '@celsian/vura-core';
 * import { cloudflareAdapter } from '@celsian/vura-adapter-cloudflare';
 *
 * export default defineConfig({
 *   adapter: cloudflareAdapter({
 *     name: 'my-api',
 *     compatibilityDate: '2024-12-01',
 *     kv: [{ binding: 'CACHE', id: 'abc123' }],
 *   }),
 * });
 * ```
 */
export function cloudflareAdapter(options: CloudflareAdapterOptions): ThenAdapter {
  return {
    name: 'cloudflare',

    async buildEnd(ctx: AdapterBuildContext): Promise<void> {
      const { manifest, projectRoot, outDir } = ctx;

      // Filter for serverless routes only
      const serverlessRoutes = manifest.api.filter(r => r.kind === 'serverless');
      const taskRoutes = manifest.api.filter(r => r.kind === 'task');

      const hotRoutes = manifest.api.filter(r => r.kind === 'hot');
      if (hotRoutes.length > 0) {
        const routeList = hotRoutes.map(r => r.urlPattern).join(', ');
        console.warn(
          `[vura] ${hotRoutes.length} hot route(s) cannot run on cloudflare and were not bundled: ${routeList} — deploy them to a persistent host (see /self-host/)`,
        );
      }

      const globalHooksFile = findGlobalHooksFile(projectRoot);

      // Group routes by workerGroup config key (if specified in route config)
      const workerGroups = groupRoutesByWorker(serverlessRoutes, options.workerGroup);

      for (const [groupName, routes] of Object.entries(workerGroups)) {
        const isDefault = groupName === '__default__';
        const workerName = isDefault ? options.name : `${options.name}-${groupName}`;
        const workerDir = isDefault
          ? join(outDir, 'cloudflare')
          : join(outDir, 'cloudflare', groupName);

        await mkdir(workerDir, { recursive: true });

        // Wrangler consumes ESM regardless of extension, while Node 20 and
        // artifact-inspection tools require an explicit module boundary for
        // entry.js and the bundled route modules.
        await writeFile(
          join(workerDir, 'package.json'),
          JSON.stringify({ type: 'module' }, null, 2) + '\n',
        );

        // Generate wrangler.toml
        const groupOptions: CloudflareAdapterOptions = {
          ...options,
          name: workerName,
        };
        const toml = generateWranglerToml(groupOptions, routes, taskRoutes);
        await writeFile(join(workerDir, 'wrangler.toml'), toml);

        // The hooks file only has a request to wrap when this worker has HTTP
        // routes. A task-only group runs through `scheduled`, which never
        // reaches the fetch lifecycle, so it gets the empty stand-in — the same
        // rule core applies when it emits dist/functions/.
        const groupHooksFile = routes.length > 0 ? globalHooksFile : null;

        // Generate worker entry (include task routes for scheduled handler)
        const entry = generateWorkerEntry(routes, projectRoot, workerDir, taskRoutes, groupHooksFile);
        await writeFile(join(workerDir, 'entry.js'), entry);
        const routesDir = join(workerDir, 'routes');
        const emitted = new Set<string>();
        for (const route of [...routes, ...taskRoutes]) {
          const outfile = join(routesDir, routeModuleFileName(route));
          await bundleRouteModule(route, projectRoot, outfile);
          emitted.add(outfile);
        }

        // The hooks bundle sits beside the entry rather than in routes/, so the
        // sweep below does not reach it. Reconcile it here for the same reason:
        // a project that deletes its hooks file must not keep shipping the last
        // build's copy.
        const hooksOutfile = join(workerDir, 'hooks.js');
        if (groupHooksFile) {
          await bundleGlobalHooksModule(groupHooksFile, projectRoot, hooksOutfile);
        } else {
          await rm(hooksOutfile, { force: true });
        }

        // A route deleted from src/ leaves its bundle here: entry.js stops
        // importing it and wrangler.toml is regenerated, so it is dead weight
        // rather than a live endpoint, but it still ships to Cloudflare with
        // everything else in this directory. Sweeping after the writes leaves a
        // build that failed partway with its previous, working output.
        await pruneStaleOutputs(routesDir, emitted);
      }
    },
  };
}

// ─── Internal Types ───

/** Minimal CelsianJS app interface for the handler wrapper */
export interface CelsianApp {
  handle(request: Request): Promise<Response> | Response;
}

/** Request with Cloudflare bindings attached */
export interface CloudflareRequest extends Request {
  __cf_env: Record<string, unknown>;
  __cf_ctx: ExecutionContext;
}

/** Cloudflare Worker execution context */
export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

/** Cloudflare Worker module format handler */
export interface CloudflareWorkerHandler {
  fetch(
    request: Request,
    env: Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<Response>;
}

// ─── Helpers ───

function routeToVarName(route: ApiRoute): string {
  return 'route_' + route.urlPattern
    .replace(/^\//, '')
    .replace(/[/:*\-]/g, '_')
    .replace(/_+/g, '_');
}

function routeModuleFileName(route: ApiRoute): string {
  return route.filePath
    .replace(/\.[cm]?tsx?$/, '')
    .replace(/[^a-zA-Z0-9_/-]/g, '_')
    .replace(/[/-]+/g, '_')
    .replace(/^_+|_+$/g, '') + '.js';
}

async function bundleRouteModule(route: Pick<ApiRoute, 'filePath'>, projectRoot: string, outfile: string): Promise<void> {
  const absPath = join(projectRoot, route.filePath);
  if (!existsSync(absPath)) {
    throw new Error(`Route source not found for ${route.filePath}: ${absPath}`);
  }

  const { build: esbuild } = await import('esbuild');
  await mkdir(dirname(outfile), { recursive: true });
  await esbuild({
    entryPoints: [absPath],
    bundle: true,
    format: 'esm',
    target: 'es2022',
    platform: 'neutral',
    outfile,
    nodePaths: [
      join(projectRoot, 'node_modules'),
      join(process.cwd(), 'node_modules'),
      join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules'),
    ],
    plugins: [vuraCoreRuntimeShimPlugin()],
    external: ['what-framework', 'what-framework/*'],
  });
}

/**
 * Find the project's conventional global hooks file, if it has one.
 *
 * Same list core, the CLI's dev server and the Vite plugin all read, so a file
 * the dev server picks up is the file the deployment artifact gets.
 */
function findGlobalHooksFile(projectRoot: string): string | null {
  for (const filename of GLOBAL_HOOKS_FILENAMES) {
    if (existsSync(join(projectRoot, filename))) return filename;
  }
  return null;
}

/**
 * Bundle the global hooks file for the Worker, next to the entry that imports
 * it. Same esbuild settings as a route module, so the same runtime-shim
 * allowlist decides what a hooks file may import.
 *
 * A hooks file that cannot be bundled fails the build. It is not skipped and
 * not warned over. The headline use of this file is an app-wide authorization
 * check — the docs hand `cookieSession()` and `createJWTGuard()` straight into
 * it — so degrading would ship a worker whose auth layer is missing while the
 * build reports success. That is exactly the failure this wiring exists to
 * close, reintroduced with a different cause. An unbuildable hooks file is a
 * fixable mistake; a deploy that silently lost its authorization is not.
 */
async function bundleGlobalHooksModule(
  hooksFile: string,
  projectRoot: string,
  outfile: string,
): Promise<void> {
  try {
    await bundleRouteModule({ filePath: hooksFile }, projectRoot, outfile);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `[vura] global hooks file ${hooksFile} could not be bundled for Cloudflare Workers.\n` +
      'Workers have no Node built-ins and only the @celsian/vura-core exports on the runtime-shim ' +
      'allowlist are available, so a hooks file importing outside that set cannot be deployed. ' +
      'Fix the import, or move the code into the routes that need it. It cannot be dropped: ' +
      'a hooks file is where an app-wide authorization check lives.\n' +
      detail,
    );
  }
}

function toDateString(date: Date): string {
  return date.toISOString().split('T')[0]!;
}

/**
 * Group routes by their worker group. Routes can specify a worker group
 * in their config (e.g., `export const route = { kind: 'serverless', worker: 'auth' }`).
 * Routes without a group go into '__default__'.
 */
function groupRoutesByWorker(
  routes: ApiRoute[],
  groupKey?: string,
): Record<string, ApiRoute[]> {
  if (!groupKey) {
    return { __default__: routes };
  }

  const groups: Record<string, ApiRoute[]> = {};

  for (const route of routes) {
    const group = (route.config[groupKey] as string) ?? '__default__';
    if (!groups[group]) {
      groups[group] = [];
    }
    groups[group].push(route);
  }

  return groups;
}
