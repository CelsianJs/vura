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
import {
  maskNonCode,
  readPageConfig,
  readRouteConfig,
} from '@celsian/vura-compiler';

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
  /** Whether the page exports a `loader` (RFC 0001 server-side data fetching) */
  hasLoader: boolean;
  /** @deprecated Whether the page exports the superseded getServerData() */
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
 * source file. Route config uses the compiler's restricted static-literal
 * parser; application modules are never imported or evaluated during scanning.
 */
export function extractApiExports(source: string): {
  methods: HttpMethod[];
  kind: RouteKind;
  hasWebsocket: boolean;
  config: Record<string, unknown>;
} {
  const code = maskNonCode(source);
  const methods: HttpMethod[] = [];

  for (const method of HTTP_METHODS) {
    // Match: export async function GET | export function GET | export const GET
    const pattern = new RegExp(
      `export\\s+(?:async\\s+)?(?:function\\s+${method}|const\\s+${method}\\s*=)`,
    );
    if (pattern.test(code)) {
      methods.push(method);
    }
  }

  // Detect `export function websocket` or `export const websocket = …`
  // Word boundary after `websocket` prevents false matches on `websocketHelper`, etc.
  const hasWebsocket = /export\s+(?:async\s+)?(?:function\s+websocket\b|const\s+websocket\s*=)/.test(code);
  const { kind, config } = readRouteConfig(source);

  return { methods, kind, hasWebsocket, config };
}

/**
 * Extract page config: export const page = { mode: 'static' }
 */
export function extractPageConfig(source: string): {
  mode: PageMode;
  hasLoader: boolean;
  hasGetServerData: boolean;
  config: Record<string, unknown>;
} {
  let mode: PageMode = 'static'; // default: static
  const config = readPageConfig(source);
  const modeWasDeclared = typeof config.mode === 'string' && isPageMode(config.mode);
  if (modeWasDeclared) {
    mode = config.mode as PageMode;
  }

  // Detect the server-data exports. `loader` is the current one; getServerData
  // is its deprecated predecessor and infers the same mode.
  const code = maskNonCode(source);
  const hasLoader = /export\s+(?:async\s+)?function\s+loader\b|export\s+(?:const|let)\s+loader\b/.test(code);
  const hasGetServerData = /export\s+(?:async\s+)?function\s+getServerData|export\s+(?:const|let)\s+getServerData/.test(code);

  // Inference only fills in a mode nobody declared. It used to run whenever the
  // mode was `static`, which cannot tell "defaulted to static" from "the author
  // wrote mode: 'static'" — so a deliberately static page with a loader was
  // silently promoted to server rendering and lost its prerendered HTML. A
  // static page's loader is legitimate: it runs at build time (RFC 0001).
  if (!modeWasDeclared) {
    if (hasLoader ||
        hasGetServerData ||
        /import\s+.*from\s+['"]then\/server['"]/.test(source) ||
        /useSWR|useQuery|useServerData/.test(code)) {
      mode = 'server';
    }
  }

  return { mode, hasLoader, hasGetServerData, config };
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
    const { mode, hasLoader, hasGetServerData, config } = extractPageConfig(source);

    // Build the layout chain for this page
    const layoutChain = buildLayoutChain(relPath, layouts);

    pages.push({
      filePath: relative(projectRoot, file),
      urlPattern: fileToUrlPattern(
        relPath.replace(/\.(tsx|jsx|ts|js)$/, ''),
        '',
      ),
      mode,
      hasLoader,
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

function isPageMode(s: string): s is PageMode {
  return s === 'static' || s === 'server' || s === 'client' || s === 'hybrid';
}
