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

  return lines.join('\n');
}

// ─── Worker Entry Generator ───

/**
 * Generate the Worker entry file that creates a CelsianJS app,
 * registers all serverless routes, and exports a CF Worker fetch handler.
 */
export function generateWorkerEntry(
  routes: ApiRoute[],
  projectRoot: string,
  workerDir: string,
): string {
  const imports: string[] = [
    `import { createApp } from '@celsian/core';`,
  ];
  const registrations: string[] = [];

  for (const route of routes) {
    const varName = routeToVarName(route);
    const relPath = relative(workerDir, join(projectRoot, route.filePath))
      .replace(/\.ts$/, '.js');
    // Ensure the path starts with ./ for a valid relative import
    const importPath = relPath.startsWith('.') ? relPath : `./${relPath}`;
    imports.push(`import * as ${varName} from '${importPath}';`);

    for (const method of route.methods) {
      const celsianMethod = method.toLowerCase();
      registrations.push(
        `app.${celsianMethod}('${route.urlPattern}', (req, reply) => ${varName}.${method}(req, reply));`,
      );
    }
  }

  return `${imports.join('\n')}

const app = createApp();

// Register API routes
${registrations.join('\n')}

// Health check
app.get('/__health', (req, reply) => reply.json({ ok: true }));

// Cloudflare Worker fetch handler
// CelsianJS uses Web Standard Request/Response, so this is nearly a pass-through.
export default {
  async fetch(request, env, ctx) {
    // Decorate the request with Cloudflare bindings so route handlers can access them
    request.__cf_env = env;
    request.__cf_ctx = ctx;
    return app.handle(request);
  },
};
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
        const toml = generateWranglerToml(groupOptions, routes);
        await writeFile(join(workerDir, 'wrangler.toml'), toml);

        // Generate worker entry
        const entry = generateWorkerEntry(routes, projectRoot, workerDir);
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
