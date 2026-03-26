/**
 * @then/vite-plugin
 *
 * Vite plugin for ThenJS that:
 * 1. Adds dev middleware for API routes (CelsianJS-compatible req/reply)
 * 2. Adds dev middleware for server-mode pages (SSR with getServerData)
 * 3. Adds dev middleware for task management (/__tasks/*)
 * 4. Watches src/api/ and src/pages/ for file changes and hot-reloads
 * 5. Scans file-based routes on startup
 */

import { buildManifest, matchRoute } from '@then/core';
import type { RouteManifest, PageRoute, ThenRequest, ThenReply } from '@then/core';
import type { Plugin, ViteDevServer } from 'vite';

export interface ThenPluginOptions {
  /** Project root (default: process.cwd()) */
  root?: string;
}

export function thenPlugin(options: ThenPluginOptions = {}): Plugin {
  let manifest: RouteManifest;
  let projectRoot: string;

  return {
    name: 'vite-plugin-then',
    enforce: 'pre',

    async configResolved(config) {
      projectRoot = options.root ?? config.root;
    },

    async configureServer(server: ViteDevServer) {
      // Scan routes on startup
      manifest = await buildManifest(projectRoot);
      console.log(`  [then] Scanned ${manifest.api.length} API routes, ${manifest.pages.length} pages`);

      // Watch src/api/ and src/pages/ for changes
      const apiDir = `${projectRoot}/src/api`;
      const pagesDir = `${projectRoot}/src/pages`;
      server.watcher.add(apiDir);
      server.watcher.add(pagesDir);

      const rescanOnChange = async (file: string) => {
        if (file.startsWith(apiDir) || file.startsWith(pagesDir)) {
          const rel = file.replace(projectRoot + '/', '');
          console.log(`  [then] Route changed: ${rel}`);
          manifest = await buildManifest(projectRoot);
        }
      };

      server.watcher.on('change', rescanOnChange);
      server.watcher.on('add', rescanOnChange);
      server.watcher.on('unlink', rescanOnChange);

      // ─── Task management middleware ───
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
        const method = (req.method ?? 'GET').toUpperCase();

        if (!url.pathname.startsWith('/__tasks')) {
          return next();
        }

        const taskRoutes = manifest.api.filter(r => r.kind === 'task');

        if (url.pathname === '/__tasks' && method === 'GET') {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            tasks: taskRoutes.map(r => ({
              name: r.urlPattern,
              methods: r.methods,
              config: r.config,
            })),
          }));
          return;
        }

        if (url.pathname.startsWith('/__tasks/') && method === 'POST') {
          const taskName = url.pathname.slice('/__tasks/'.length);
          const taskRoute = taskRoutes.find(r =>
            r.urlPattern.replace(/^\/api\//, '').replace(/\//g, '.') === taskName
          );
          if (!taskRoute) {
            res.statusCode = 404;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Task not found: ' + taskName }));
            return;
          }

          try {
            const modulePath = `/${taskRoute.filePath}`;
            const mod = await server.ssrLoadModule(modulePath);
            const handlerFn = mod.POST;
            if (typeof handlerFn !== 'function') {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'Task must export POST handler' }));
              return;
            }

            const body = await readBody(req);
            const result = await handlerFn({
              taskId: String(Date.now()),
              input: body?.input,
              attempt: 1,
            });

            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ status: 'completed', result }));
          } catch (err: any) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: err.message }));
          }
          return;
        }

        return next();
      });

      // ─── API route middleware ───
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

        // Only handle /api/* routes
        if (!url.pathname.startsWith('/api/')) {
          return next();
        }

        const method = (req.method ?? 'GET').toUpperCase();

        // Try to match a route
        const matched = matchRoute(manifest.api, method, url.pathname);
        if (!matched) {
          return next();
        }

        try {
          // Load the handler module via Vite's module graph (gets HMR for free)
          const modulePath = `/${matched.route.filePath}`;
          const mod = await server.ssrLoadModule(modulePath);
          const handlerFn = mod[method];

          if (typeof handlerFn !== 'function') {
            res.statusCode = 405;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: `Method ${method} not exported by ${matched.route.filePath}` }));
            return;
          }

          // Parse body if needed
          const body = await readBody(req);

          // Create CelsianJS-compatible req/reply
          const cReq: ThenRequest = {
            method,
            url: url.pathname,
            headers: req.headers as Record<string, string>,
            params: matched.params,
            query: Object.fromEntries(url.searchParams.entries()),
            parsedBody: body,
          };

          let statusCode = 200;
          const responseHeaders: Record<string, string> = { 'content-type': 'application/json' };

          const cReply: ThenReply = {
            status(code: number) { statusCode = code; return cReply; },
            header(name: string, value: string) { responseHeaders[name] = value; return cReply; },
            json(data: unknown) {
              res.statusCode = statusCode;
              for (const [k, v] of Object.entries(responseHeaders)) {
                res.setHeader(k, v);
              }
              res.end(JSON.stringify(data));
              return null;
            },
            send(data: string) {
              res.statusCode = statusCode;
              for (const [k, v] of Object.entries(responseHeaders)) {
                res.setHeader(k, v);
              }
              res.end(data);
              return null;
            },
          };

          const result = await handlerFn(cReq, cReply);

          // If handler returned a Response object (Web Standard)
          if (result instanceof Response) {
            res.statusCode = result.status;
            result.headers.forEach((v, k) => res.setHeader(k, v));
            const text = await result.text();
            res.end(text);
            return;
          }

          // If handler returned a plain object (auto-wrap as JSON)
          if (result && typeof result === 'object' && !res.writableEnded) {
            res.statusCode = statusCode;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(result));
            return;
          }

          // reply.json() / reply.send() already ended the response
        } catch (err: any) {
          console.error(`  [then] Error in ${method} ${url.pathname}:`, err);
          if (!res.writableEnded) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              error: 'Internal Server Error',
              message: err.message,
            }));
          }
        }
      });

      // ─── Server-mode page middleware ───
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
        const method = (req.method ?? 'GET').toUpperCase();

        if (method !== 'GET') return next();
        // Skip API routes, static assets, Vite internals
        if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/@') || url.pathname.startsWith('/__')) {
          return next();
        }
        // Skip file requests (has extension)
        if (/\.\w+$/.test(url.pathname)) return next();

        // Find matching server-mode page
        const serverPages = manifest.pages.filter(p => p.mode === 'server' || p.mode === 'hybrid');
        const matched = matchPageRoute(serverPages, url.pathname);
        if (!matched) return next();

        try {
          const modulePath = `/${matched.page.filePath}`;
          const mod = await server.ssrLoadModule(modulePath);
          const Component = mod.default;
          const pageConfig = mod.page ?? {};

          if (typeof Component !== 'function') {
            return next();
          }

          // Call getServerData if present
          let serverData: Record<string, unknown> = {};
          if (typeof mod.getServerData === 'function') {
            serverData = await mod.getServerData({
              params: matched.params,
              url: url.pathname,
              query: Object.fromEntries(url.searchParams.entries()),
            });
          }

          // Render with built-in renderer
          const vnode = Component({ ...serverData, params: matched.params });
          const bodyHtml = builtinRenderToString(vnode);

          const html = wrapDocumentDev(bodyHtml, {
            title: pageConfig.title ?? 'ThenJS App',
            meta: pageConfig.meta ?? [],
            styles: pageConfig.styles ?? [],
            scripts: pageConfig.scripts ?? [],
            head: pageConfig.head ?? '',
          });

          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(html);
        } catch (err: any) {
          console.error(`  [then] Page render error ${url.pathname}:`, err);
          if (!res.writableEnded) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'text/html');
            res.end(`<h1>500 — Server Error</h1><pre>${escapeHtml(String(err.message))}</pre>`);
          }
        }
      });
    },
  };
}

// ─── Page Route Matching ───

function matchPageRoute(
  pages: PageRoute[],
  pathname: string,
): { page: PageRoute; params: Record<string, string> } | null {
  for (const page of pages) {
    const paramNames: string[] = [];
    let regexStr = '';
    let i = 0;
    const pattern = page.urlPattern;

    while (i < pattern.length) {
      if (pattern[i] === ':' && i > 0 && pattern[i - 1] === '/') {
        let name = '';
        i++;
        while (i < pattern.length && /[a-zA-Z0-9_]/.test(pattern[i])) {
          name += pattern[i];
          i++;
        }
        paramNames.push(name);
        regexStr += '([^/]+)';
      } else if (pattern[i] === '*') {
        paramNames.push('*');
        regexStr += '(.*)';
        i++;
      } else {
        const ch = pattern[i];
        if ('.+?^${}()|[]\\'.includes(ch)) {
          regexStr += '\\' + ch;
        } else {
          regexStr += ch;
        }
        i++;
      }
    }

    const match = pathname.match(new RegExp(`^${regexStr}$`));
    if (match) {
      const params: Record<string, string> = {};
      paramNames.forEach((name, idx) => {
        try { params[name] = decodeURIComponent(match[idx + 1]); } catch { params[name] = match[idx + 1]; }
      });
      return { page, params };
    }
  }
  return null;
}

// ─── Built-in SSR Renderer (for dev) ───

function builtinRenderToString(vnode: any): string {
  if (vnode == null || typeof vnode === 'boolean') return '';
  if (typeof vnode === 'string') return escapeHtml(vnode);
  if (typeof vnode === 'number') return String(vnode);
  if (typeof vnode === 'function' && !vnode.type && !vnode.tag) return builtinRenderToString(vnode());
  if (Array.isArray(vnode)) return vnode.map(builtinRenderToString).join('');

  // Support both What Framework vnodes ({ tag }) and standard ({ type })
  const type = vnode.type ?? vnode.tag;
  const { props = {}, children } = vnode;
  if (typeof type === 'function') return builtinRenderToString(type({ ...props, children }));
  if (typeof type === 'string') {
    const attrs = renderAttributes(props);
    const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
    if (VOID.has(type)) return `<${type}${attrs}>`;
    let childHtml = '';
    if (props.dangerouslySetInnerHTML) childHtml = props.dangerouslySetInnerHTML.__html ?? '';
    else if (children != null) {
      childHtml = Array.isArray(children) ? children.map(builtinRenderToString).join('') : builtinRenderToString(children);
    }
    return `<${type}${attrs}>${childHtml}</${type}>`;
  }
  if ((!type || typeof type === 'symbol') && children) {
    return Array.isArray(children) ? children.map(builtinRenderToString).join('') : builtinRenderToString(children);
  }
  return '';
}

function renderAttributes(props: Record<string, any>): string {
  let result = '';
  for (const [key, value] of Object.entries(props)) {
    if (key === 'children' || key === 'dangerouslySetInnerHTML') continue;
    if (key.startsWith('on') && key.length > 2) continue;
    if (value == null || value === false) continue;
    const attrName = key === 'className' ? 'class' : key === 'htmlFor' ? 'for' : key;
    if (value === true) { result += ` ${attrName}`; }
    else if (key === 'style' && typeof value === 'object') {
      const css = Object.entries(value).map(([p, v]) => `${p.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`)}: ${v}`).join('; ');
      result += ` style="${escapeHtml(css)}"`;
    } else {
      result += ` ${attrName}="${escapeHtml(String(value))}"`;
    }
  }
  return result;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function wrapDocumentDev(bodyHtml: string, opts: { title: string; meta: any[]; styles: string[]; scripts: string[]; head: string }): string {
  const metaTags = opts.meta.map((m: any) => `<meta ${Object.entries(m).map(([k, v]) => `${k}="${escapeHtml(String(v))}"`).join(' ')}>`).join('\n    ');
  const styleTags = opts.styles.map((s: string) => s.startsWith('http') ? `<link rel="stylesheet" href="${s}">` : `<style>${s}</style>`).join('\n    ');
  const scriptTags = opts.scripts.map((s: string) => `<script type="module" src="${s}"></script>`).join('\n    ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(opts.title)}</title>
    ${metaTags}
    ${styleTags}
    ${opts.head}
</head>
<body>
    <div id="app">${bodyHtml}</div>
    ${scriptTags}
</body>
</html>`;
}

// ─── Body Parser ───

const PLUGIN_MAX_BODY_SIZE = 1024 * 1024; // 1MB

function readBody(req: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const method = (req.method ?? 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD') {
      return resolve(null);
    }

    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > PLUGIN_MAX_BODY_SIZE) { req.destroy(); reject(new Error('Body too large')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const data = Buffer.concat(chunks).toString();
      if (!data) return resolve(null);
      const ct = req.headers['content-type'] ?? '';
      if (ct.includes('application/json')) {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      } else if (ct.includes('application/x-www-form-urlencoded')) {
        resolve(Object.fromEntries(new URLSearchParams(data)));
      } else {
        resolve(data);
      }
    });
    req.on('error', () => resolve(null));
  });
}

export default thenPlugin;
