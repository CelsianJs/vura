/**
 * Route Manifest Scanner
 *
 * Scans src/api/ and src/pages/ directories to build a unified route manifest.
 * Each route gets a `kind` (serverless | hot | task) that determines WHERE it
 * gets deployed. This is the core abstraction that makes ThenJS multi-target.
 *
 * API routes: export named HTTP method functions (GET, POST, PUT, DELETE, etc.)
 * Pages: export default component + optional `page` config
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative, parse as parsePath } from 'node:path';

// ─── Types ───

export type RouteKind = 'serverless' | 'hot' | 'task';
export type PageMode = 'static' | 'server' | 'client' | 'hybrid';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';

export interface ApiRoute {
  /** File path relative to project root */
  filePath: string;
  /** URL pattern, e.g. /api/users/:id */
  urlPattern: string;
  /** HTTP methods exported by this file */
  methods: HttpMethod[];
  /** Deployment target */
  kind: RouteKind;
  /** Raw route config from the file */
  config: Record<string, unknown>;
}

export interface PageRoute {
  /** File path relative to project root */
  filePath: string;
  /** URL pattern, e.g. /blog/:slug */
  urlPattern: string;
  /** Rendering mode */
  mode: PageMode;
  /** Has layout wrapper */
  layout?: string;
  /** Whether the page exports getServerData() */
  hasGetServerData: boolean;
  /** Raw page config from the file */
  config: Record<string, unknown>;
}

export interface RouteManifest {
  api: ApiRoute[];
  pages: PageRoute[];
  timestamp: string;
}

// ─── HTTP Method Detection ───

const HTTP_METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

/**
 * Extract exported HTTP methods and route config from a source file.
 * Uses regex-based static analysis (no eval, no import).
 */
export function extractApiExports(source: string): {
  methods: HttpMethod[];
  kind: RouteKind;
  config: Record<string, unknown>;
} {
  const methods: HttpMethod[] = [];

  for (const method of HTTP_METHODS) {
    // Match: export async function GET | export function GET | export const GET
    const pattern = new RegExp(
      `export\\s+(?:async\\s+)?(?:function\\s+${method}|const\\s+${method}\\s*=)`,
    );
    if (pattern.test(source)) {
      methods.push(method);
    }
  }

  // Extract route config: export const route = { kind: 'serverless' }
  let kind: RouteKind = 'serverless'; // default
  const config: Record<string, unknown> = {};

  const routeBody = extractBalancedBraces(source, /export\s+const\s+route\s*=\s*\{/);
  if (routeBody) {
    const body = routeBody;

    // Extract kind
    const kindMatch = body.match(/kind\s*:\s*['"](\w+)['"]/);
    if (kindMatch && isRouteKind(kindMatch[1]!)) {
      kind = kindMatch[1]!;
    }

    // Extract other simple key-value pairs
    const kvPattern = /(\w+)\s*:\s*(?:'([^']*)'|"([^"]*)"|(\d+)|(\btrue\b|\bfalse\b))/g;
    let kv;
    while ((kv = kvPattern.exec(body)) !== null) {
      const key = kv[1]!;
      const value = kv[2] ?? kv[3] ?? (kv[4] ? Number(kv[4]) : kv[5] === 'true');
      config[key] = value;
    }
  }

  return { methods, kind, config };
}

/**
 * Extract page config: export const page = { mode: 'static' }
 */
export function extractPageConfig(source: string): {
  mode: PageMode;
  hasGetServerData: boolean;
  config: Record<string, unknown>;
} {
  let mode: PageMode = 'static'; // default: static
  const config: Record<string, unknown> = {};

  const pageBody = extractBalancedBraces(source, /export\s+const\s+page\s*=\s*\{/);
  if (pageBody) {
    const body = pageBody;

    const modeMatch = body.match(/mode\s*:\s*['"](\w+)['"]/);
    if (modeMatch && isPageMode(modeMatch[1]!)) {
      mode = modeMatch[1]!;
    }

    const kvPattern = /(\w+)\s*:\s*(?:'([^']*)'|"([^"]*)"|(\d+)|(\btrue\b|\bfalse\b))/g;
    let kv;
    while ((kv = kvPattern.exec(body)) !== null) {
      const key = kv[1]!;
      const value = kv[2] ?? kv[3] ?? (kv[4] ? Number(kv[4]) : kv[5] === 'true');
      config[key] = value;
    }
  }

  // Detect getServerData export
  const hasGetServerData = /export\s+(?:async\s+)?function\s+getServerData|export\s+(?:const|let)\s+getServerData/.test(source);

  // Heuristic: if source imports server-side data functions, default to server
  if (mode === 'static') {
    if (hasGetServerData ||
        /import\s+.*from\s+['"]then\/server['"]/.test(source) ||
        /useSWR|useQuery|useServerData/.test(source)) {
      mode = 'server';
    }
  }

  return { mode, hasGetServerData, config };
}

// ─── File Scanner ───

/**
 * Convert a file path to a URL pattern.
 * src/api/users/[id].ts → /api/users/:id
 * src/pages/blog/[slug].jsx → /blog/:slug
 */
export function fileToUrlPattern(filePath: string, prefix: string): string {
  const { dir, name } = parsePath(filePath);

  // Build the URL from directory + filename
  let url = dir ? `${prefix}/${dir}` : prefix;
  if (name !== 'index') {
    url += `/${name}`;
  }

  // Convert [param] to :param
  url = url.replace(/\[([^\]]+)\]/g, ':$1');

  // Convert [...param] to *param (catch-all)
  url = url.replace(/:\.\.\.(\w+)/g, '*$1');

  // Remove route groups: (auth)/ → nothing
  url = url.replace(/\/\([^)]+\)/g, '');

  return url || '/';
}

/**
 * Recursively scan a directory for route files.
 */
async function scanDir(dir: string, extensions: string[]): Promise<string[]> {
  const files: string[] = [];

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files; // directory doesn't exist
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip _prefixed dirs (layouts, private) and node_modules
      if (!entry.name.startsWith('_') && entry.name !== 'node_modules') {
        files.push(...await scanDir(fullPath, extensions));
      }
    } else {
      const ext = entry.name.slice(entry.name.lastIndexOf('.'));
      if (extensions.includes(ext)) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

/**
 * Scan the project and build a complete route manifest.
 */
export async function buildManifest(projectRoot: string): Promise<RouteManifest> {
  const apiDir = join(projectRoot, 'src', 'api');
  const pagesDir = join(projectRoot, 'src', 'pages');

  // Scan API routes
  const apiFiles = await scanDir(apiDir, ['.ts', '.js', '.mjs']);
  const api: ApiRoute[] = [];

  for (const file of apiFiles) {
    const source = await readFile(file, 'utf-8');
    const relPath = relative(apiDir, file);
    const { methods, kind, config } = extractApiExports(source);

    if (methods.length === 0) continue; // Skip files with no HTTP exports

    api.push({
      filePath: relative(projectRoot, file),
      urlPattern: fileToUrlPattern(
        relPath.replace(/\.(ts|js|mjs)$/, ''),
        '/api',
      ),
      methods,
      kind,
      config,
    });
  }

  // Scan pages
  const pageFiles = await scanDir(pagesDir, ['.tsx', '.jsx', '.ts', '.js']);
  const pages: PageRoute[] = [];

  for (const file of pageFiles) {
    const source = await readFile(file, 'utf-8');
    const relPath = relative(pagesDir, file);
    const { mode, hasGetServerData, config } = extractPageConfig(source);

    pages.push({
      filePath: relative(projectRoot, file),
      urlPattern: fileToUrlPattern(
        relPath.replace(/\.(tsx|jsx|ts|js)$/, ''),
        '',
      ),
      mode,
      hasGetServerData,
      config,
    });
  }

  return {
    api,
    pages,
    timestamp: new Date().toISOString(),
  };
}

// ─── Helpers ───

/**
 * Extract content inside balanced braces after a regex match.
 * Handles nested objects: { kind: 'task', retry: { attempts: 3 }, timeout: 30000 }
 */
function extractBalancedBraces(source: string, startPattern: RegExp): string | null {
  const match = startPattern.exec(source);
  if (!match) return null;
  let depth = 1;
  let i = match.index + match[0].length;
  const start = i;
  while (i < source.length && depth > 0) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') depth--;
    if (depth > 0) i++;
  }
  if (depth !== 0) return null;
  return source.slice(start, i);
}

function isRouteKind(s: string): s is RouteKind {
  return s === 'serverless' || s === 'hot' || s === 'task';
}

function isPageMode(s: string): s is PageMode {
  return s === 'static' || s === 'server' || s === 'client' || s === 'hybrid';
}
