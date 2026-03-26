/**
 * @then/adapter-cloudflare
 *
 * Adapts ThenJS build output for Cloudflare Workers deployment.
 *
 * Because Cloudflare Workers natively use the Web Standard Request/Response API
 * (the same as CelsianJS), this adapter is thin — it mainly generates:
 *   1. wrangler.toml configuration
 *   2. Worker entry files that wire routes to a CelsianJS app
 *
 * Supports multiple worker groups, KV namespaces, D1 databases, and R2 buckets.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { ThenAdapter, AdapterBuildContext } from '@then/core';
import type { RouteManifest, ApiRoute } from '@then/core';

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
 * to the appropriate handler using @then/core's req/reply pattern.
 * No CelsianJS dependency required — works standalone.
 */
export function generateWorkerEntry(
  routes: ApiRoute[],
  projectRoot: string,
  workerDir: string,
  taskRoutes: ApiRoute[] = [],
): string {
  const imports: string[] = [];
  const routeTable: string[] = [];

  for (const route of routes) {
    const varName = routeToVarName(route);
    const relPath = relative(workerDir, join(projectRoot, route.filePath))
      .replace(/\.tsx?$/, '.js')
      .replace(/\\/g, '/');
    const importPath = relPath.startsWith('.') ? relPath : `./${relPath}`;
    imports.push(`import * as ${varName} from '${importPath}';`);

    routeTable.push(`  { pattern: '${route.urlPattern}', methods: [${route.methods.map(m => `'${m}'`).join(', ')}], handlers: ${varName} },`);
  }

  // Import task route handlers
  const taskImports: string[] = [];
  const taskTable: string[] = [];
  for (const route of taskRoutes) {
    const varName = routeToVarName(route);
    const relPath = relative(workerDir, join(projectRoot, route.filePath))
      .replace(/\.tsx?$/, '.js')
      .replace(/\\/g, '/');
    const importPath = relPath.startsWith('.') ? relPath : `./${relPath}`;
    taskImports.push(`import * as ${varName} from '${importPath}';`);
    const taskName = route.urlPattern.replace(/^\/api\//, '').replace(/\//g, '.');
    const schedule = route.config.schedule ? `'${route.config.schedule}'` : 'null';
    taskTable.push(`  { name: '${taskName}', handler: ${varName}.POST, schedule: ${schedule} },`);
  }

  const allImports = [...imports, ...taskImports].join('\n');

  return `${allImports}

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

${taskTable.length > 0 ? `const taskRoutes = [\n${taskTable.join('\n')}\n];\n` : ''}
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    if (url.pathname === '/__health') {
      return new Response(JSON.stringify({ ok: true, framework: 'ThenJS' }), { headers: { 'Content-Type': 'application/json' } });
    }

    const match = matchRoute(url.pathname, method);
    if (!match) {
      return new Response(JSON.stringify({ error: 'Not Found', path: url.pathname }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

    const handlerFn = match.route.handlers[method];
    if (typeof handlerFn !== 'function') {
      return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
    }

    const body = await parseBody(request);
    const req = {
      method,
      url: url.pathname,
      headers: Object.fromEntries(request.headers.entries()),
      params: match.params,
      query: Object.fromEntries(url.searchParams.entries()),
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
    };

    const result = await handlerFn(req, reply);
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
 * import { createWorkerHandler } from '@then/adapter-cloudflare';
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
 * Create a ThenJS adapter for Cloudflare Workers deployment.
 *
 * @example
 * ```ts
 * // then.config.ts
 * import { defineConfig } from '@then/core';
 * import { cloudflareAdapter } from '@then/adapter-cloudflare';
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

      // Group routes by workerGroup config key (if specified in route config)
      const workerGroups = groupRoutesByWorker(serverlessRoutes, options.workerGroup);

      for (const [groupName, routes] of Object.entries(workerGroups)) {
        const isDefault = groupName === '__default__';
        const workerName = isDefault ? options.name : `${options.name}-${groupName}`;
        const workerDir = isDefault
          ? join(outDir, 'cloudflare')
          : join(outDir, 'cloudflare', groupName);

        await mkdir(workerDir, { recursive: true });

        // Generate wrangler.toml
        const groupOptions: CloudflareAdapterOptions = {
          ...options,
          name: workerName,
        };
        const toml = generateWranglerToml(groupOptions, routes, taskRoutes);
        await writeFile(join(workerDir, 'wrangler.toml'), toml);

        // Generate worker entry (include task routes for scheduled handler)
        const entry = generateWorkerEntry(routes, projectRoot, workerDir, taskRoutes);
        await writeFile(join(workerDir, 'entry.js'), entry);
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
