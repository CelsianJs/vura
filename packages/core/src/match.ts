/**
 * Route Matching — shared pattern matching for dev server and vite plugin.
 *
 * Compiles URL patterns (e.g. /api/users/:id) into regexes and matches
 * incoming requests against them. Handles :params, * wildcards, and
 * proper escaping of regex-special characters.
 *
 * Supports both API routes and page routes to avoid duplication
 * across dev.ts, vite-plugin, and build.ts.
 */

import type { ApiRoute, PageRoute } from './manifest.js';

// ─── Types ───

export interface CompiledRoute {
  route: ApiRoute;
  regex: RegExp;
  paramNames: string[];
}

export interface RouteMatch {
  route: ApiRoute;
  params: Record<string, string>;
}

export interface CompiledPageRoute {
  page: PageRoute;
  regex: RegExp;
  paramNames: string[];
}

export interface PageRouteMatch {
  page: PageRoute;
  params: Record<string, string>;
}

// ─── Compile a URL pattern into a regex ───

function compilePattern(pattern: string): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  let regexStr = '';
  let i = 0;

  while (i < pattern.length) {
    if (pattern[i] === ':' && i > 0 && pattern[i - 1] === '/') {
      // :param — capture until next /
      let name = '';
      i++; // skip ':'
      while (i < pattern.length && /[a-zA-Z0-9_]/.test(pattern[i])) {
        name += pattern[i];
        i++;
      }
      paramNames.push(name);
      regexStr += '([^/]+)';
    } else if (pattern[i] === '*') {
      // Wildcard — capture rest of path
      paramNames.push('*');
      regexStr += '(.*)';
      i++;
    } else {
      // Escape regex-special characters
      const ch = pattern[i];
      if ('.+?^${}()|[]\\'.includes(ch)) {
        regexStr += '\\' + ch;
      } else {
        regexStr += ch;
      }
      i++;
    }
  }

  return {
    regex: new RegExp(`^${regexStr}$`),
    paramNames,
  };
}

// ─── Compile all routes at once ───

export function compileRoutes(routes: ApiRoute[]): CompiledRoute[] {
  return routes.map((route) => {
    const { regex, paramNames } = compilePattern(route.urlPattern);
    return { route, regex, paramNames };
  });
}

// ─── Match a request against compiled routes ───

export function matchRoute(
  routes: ApiRoute[] | CompiledRoute[],
  method: string,
  pathname: string,
): RouteMatch | null {
  // Auto-compile if given raw ApiRoute[]
  const compiled: CompiledRoute[] =
    routes.length > 0 && 'regex' in routes[0]
      ? (routes as CompiledRoute[])
      : compileRoutes(routes as ApiRoute[]);

  const upperMethod = method.toUpperCase();

  for (const { route, regex, paramNames } of compiled) {
    if (!route.methods.includes(upperMethod as any)) continue;

    const match = pathname.match(regex);
    if (match) {
      const params: Record<string, string> = {};
      for (let i = 0; i < paramNames.length; i++) {
        try { params[paramNames[i]] = decodeURIComponent(match[i + 1]); } catch { params[paramNames[i]] = match[i + 1]; }
      }
      return { route, params };
    }
  }

  return null;
}

// ─── API Path Existence Check (method-agnostic) ───

/**
 * Returns true if ANY compiled API route's URL pattern matches pathname,
 * regardless of HTTP method. Used by dev middlewares to distinguish an
 * intentional handler 404 (route exists, handler returned 404) from a
 * "no such route" 404 (celsian's default when nothing matches).
 */
export function matchApiPath(
  routes: ApiRoute[] | CompiledRoute[],
  pathname: string,
): boolean {
  const compiled: CompiledRoute[] =
    routes.length > 0 && 'regex' in routes[0]
      ? (routes as CompiledRoute[])
      : compileRoutes(routes as ApiRoute[]);

  for (const { regex } of compiled) {
    if (regex.test(pathname)) return true;
  }
  return false;
}

// ─── Page Route Matching ───

/**
 * Compile page routes into regex-based matchers.
 * Shared by dev.ts and vite-plugin — single source of truth.
 */
export function compilePageRoutes(pages: PageRoute[]): CompiledPageRoute[] {
  return pages.map((page) => {
    const { regex, paramNames } = compilePattern(page.urlPattern);
    return { page, regex, paramNames };
  });
}

/**
 * Match a pathname against compiled page routes.
 */
export function matchPageRoute(
  pages: PageRoute[] | CompiledPageRoute[],
  pathname: string,
): PageRouteMatch | null {
  const compiled: CompiledPageRoute[] =
    pages.length > 0 && 'regex' in pages[0]
      ? (pages as CompiledPageRoute[])
      : compilePageRoutes(pages as PageRoute[]);

  for (const { page, regex, paramNames } of compiled) {
    const match = pathname.match(regex);
    if (match) {
      const params: Record<string, string> = {};
      for (let i = 0; i < paramNames.length; i++) {
        try { params[paramNames[i]] = decodeURIComponent(match[i + 1]); } catch { params[paramNames[i]] = match[i + 1]; }
      }
      return { page, params };
    }
  }

  return null;
}
