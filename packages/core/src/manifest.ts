/**
 * Route Manifest Scanner
 *
 * Scans src/api/ and src/pages/ directories to build a unified route manifest.
 * Each route gets a `kind` (serverless | hot | task) that determines WHERE it
 * gets deployed. This is the core abstraction that makes Vura multi-target.
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
  /**
   * Whether this route exports a `websocket(peer, req)` function.
   * Only meaningful when kind === 'hot'. Optional so that older
   * manifests/callers do not require backfilling the field.
   */
  hasWebsocket?: boolean;
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
  /**
   * Ordered layout chain from outermost to innermost.
   * Each entry is a file path (relative to project root) of a layout file.
   * The page's content is wrapped by these layouts in order.
   */
  layouts?: string[];
  /** Whether the page exports getServerData() */
  hasGetServerData: boolean;
  /** Raw page config from the file */
  config: Record<string, unknown>;
}

/**
 * A layout file that wraps child pages.
 * Layouts nest following directory structure — parent wraps child.
 */
export interface LayoutRoute {
  /** File path relative to project root */
  filePath: string;
  /** Directory this layout covers (relative to pages dir, e.g. "" for root, "blog" for blog/) */
  dirPattern: string;
}

export interface RouteManifest {
  api: ApiRoute[];
  pages: PageRoute[];
  /** Layout files detected in the pages directory */
  layouts: LayoutRoute[];
  timestamp: string;
}

// ─── HTTP Method Detection ───

const HTTP_METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

/**
 * Extract exported HTTP methods, route config, and websocket presence from a
 * source file. Uses regex-based static analysis (no eval, no import).
 *
 * NOTE on comment-stripping: stripping `//`-comment lines before regex scanning
 * would prevent false positives like `// export function websocket(peer, req) {}`.
 * However, the existing balanced-brace extractor and kv-pattern regexes are
 * tuned to the current source format and are not comment-aware in ways that
 * would interact cleanly with a strip pass (e.g. `//`  inside string literals
 * would be incorrectly stripped). Rather than risk regressions in the route/kind
 * detection, we skip automatic comment stripping here.
 * TODO(comment-false-positives): add a safe strip pass once extractApiExports
 * has broader test coverage for edge cases.
 */
export function extractApiExports(source: string): {
  methods: HttpMethod[];
  kind: RouteKind;
  hasWebsocket: boolean;
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

  // Detect `export function websocket` or `export const websocket = …`
  // Word boundary after `websocket` prevents false matches on `websocketHelper`, etc.
  const hasWebsocket = /export\s+(?:async\s+)?(?:function\s+websocket\b|const\s+websocket\s*=)/.test(source);

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

    // Extract array values: key: ['a', 'b'] or key: ["a", "b"]
    const arrayPattern = /(\w+)\s*:\s*\[([^\]]*)\]/g;
    let arr;
    while ((arr = arrayPattern.exec(body)) !== null) {
      const key = arr[1]!;
      const rawItems = arr[2]!;
      // parse items: either 'foo' or "foo"
      const items = [...rawItems.matchAll(/['"]([^'"]*)['"]/g)].map(m => m[1]!);
      if (items.length > 0) {
        config[key] = items;
      }
    }
  }

  // Detect top-level `export const kind = 'hot'` (route-kind shorthand — the
  // Phase 0 wedge contract). Route-config `kind` takes precedence; this only
  // applies when no `export const route = { ... }` block set one.
  if (!routeBody) {
    const kindShorthand = source.match(/export\s+const\s+kind\s*=\s*['"](\w+)['"]/);
    if (kindShorthand && isRouteKind(kindShorthand[1]!)) {
      kind = kindShorthand[1]!;
    }
  }

  // Detect top-level `export const schedule = '...'` (task route schedule sugar).
  // Route-config `schedule` takes precedence; this only fills in when absent.
  if (!config.schedule) {
    const scheduleMatch = source.match(/export\s+const\s+schedule\s*=\s*['"]([^'"]+)['"]/);
    if (scheduleMatch) {
      config.schedule = scheduleMatch[1];
    }
  }

  return { methods, kind, hasWebsocket, config };
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

    // Extract array values: key: ['a', 'b'] or key: ["a", "b"]
    const arrayPattern = /(\w+)\s*:\s*\[([^\]]*)\]/g;
    let arr;
    while ((arr = arrayPattern.exec(body)) !== null) {
      const key = arr[1]!;
      const rawItems = arr[2]!;
      // parse items: either 'foo' or "foo"
      const items = [...rawItems.matchAll(/['"]([^'"]*)['"]/g)].map(m => m[1]!);
      if (items.length > 0) {
        config[key] = items;
      }
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
 * Layout file name patterns (without extension).
 * Supports both `layout.tsx` and `_layout.tsx` conventions.
 */
const LAYOUT_NAMES = new Set(['layout', '_layout']);

/**
 * Check if a filename (without extension) is a layout file.
 */
function isLayoutFile(name: string): boolean {
  return LAYOUT_NAMES.has(name);
}

/**
 * Scan a pages directory for layout files.
 * Returns layout file paths keyed by their directory relative to pagesDir.
 */
async function scanLayouts(
  dir: string,
  extensions: string[],
  baseDir: string = dir,
): Promise<LayoutRoute[]> {
  const layouts: LayoutRoute[] = [];

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return layouts;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') {
        layouts.push(...await scanLayouts(fullPath, extensions, baseDir));
      }
    } else {
      const ext = entry.name.slice(entry.name.lastIndexOf('.'));
      if (!extensions.includes(ext)) continue;
      const nameWithoutExt = entry.name.slice(0, entry.name.lastIndexOf('.'));
      if (isLayoutFile(nameWithoutExt)) {
        const relDir = relative(baseDir, dir);
        layouts.push({
          filePath: relative(join(baseDir, '..', '..'), fullPath), // relative to projectRoot
          dirPattern: relDir || '',
        });
      }
    }
  }

  return layouts;
}

/**
 * Build the layout chain for a given page.
 * Walks up the directory tree from the page's directory to the root,
 * collecting layout files. Returns them outermost-first.
 */
function buildLayoutChain(
  pageRelPath: string,
  layouts: LayoutRoute[],
): string[] {
  // pageRelPath is relative to pagesDir, e.g. "blog/post.tsx"
  // We need to find layouts at "", "blog", etc.
  const parts = pageRelPath.split('/');
  parts.pop(); // remove filename

  const chain: string[] = [];
  const dirsToCheck: string[] = [''];
  let accumulated = '';
  for (const part of parts) {
    accumulated = accumulated ? `${accumulated}/${part}` : part;
    dirsToCheck.push(accumulated);
  }

  // Walk from root to leaf — outermost layout first
  for (const dir of dirsToCheck) {
    const layout = layouts.find(l => l.dirPattern === dir);
    if (layout) {
      chain.push(layout.filePath);
    }
  }

  return chain;
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
    const { methods, kind, hasWebsocket, config } = extractApiExports(source);

    // Skip files with no HTTP exports, UNLESS it's a hot route with a websocket
    // handler (ws-only hot routes have no HTTP methods but are still valid routes).
    if (methods.length === 0 && !(kind === 'hot' && hasWebsocket)) continue;

    api.push({
      filePath: relative(projectRoot, file),
      urlPattern: fileToUrlPattern(
        relPath.replace(/\.(ts|js|mjs)$/, ''),
        '/api',
      ),
      methods,
      kind,
      hasWebsocket,
      config,
    });
  }

  // Scan layout files first
  const pageExtensions = ['.tsx', '.jsx', '.ts', '.js'];
  const layouts = await scanLayouts(pagesDir, pageExtensions);

  // Scan pages (excluding layout files)
  const pageFiles = await scanDir(pagesDir, pageExtensions);
  const pages: PageRoute[] = [];

  for (const file of pageFiles) {
    // Skip layout files — they're not routes
    const nameWithoutExt = parsePath(file).name;
    if (isLayoutFile(nameWithoutExt)) continue;

    const source = await readFile(file, 'utf-8');
    const relPath = relative(pagesDir, file);
    const { mode, hasGetServerData, config } = extractPageConfig(source);

    // Build the layout chain for this page
    const layoutChain = buildLayoutChain(relPath, layouts);

    pages.push({
      filePath: relative(projectRoot, file),
      urlPattern: fileToUrlPattern(
        relPath.replace(/\.(tsx|jsx|ts|js)$/, ''),
        '',
      ),
      mode,
      hasGetServerData,
      ...(layoutChain.length > 0 ? { layouts: layoutChain } : {}),
      config,
    });
  }

  return {
    api,
    pages,
    layouts,
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
