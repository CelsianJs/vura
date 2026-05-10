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

import {
  buildManifest,
  matchRoute,
  matchPageRoute as coreMatchPageRoute,
  builtinRenderToString,
  wrapDocument,
  escapeHtml,
  parseNodeBody,
  executeWithHooks,
  createHookRegistry,
  validateRequest,
  sendErrorResponse,
  reportError,
  formatErrorResponse,
  HttpError,
  getLogger,
} from '@then/core';
import type {
  RouteManifest,
  PageRoute,
  ThenRequest,
  ThenReply,
  HookRegistry,
  RouteHooks,
} from '@then/core';
import type { Plugin, ViteDevServer } from 'vite';

export interface ThenPluginOptions {
  /** Project root (default: process.cwd()) */
  root?: string;
}

type TaskAdminHeaders = {
  authorization?: string | string[];
};

function normalizeSocketRemoteAddress(remoteAddress: string | undefined): string {
  const addr = remoteAddress || '';
  return addr.startsWith('::ffff:') ? addr.slice(7) : addr;
}

export function isTaskAdminRequestAuthorized(
  headers: TaskAdminHeaders,
  remoteAddress: string | undefined,
  env: { THEN_TASK_SECRET?: string; NODE_ENV?: string } = process.env,
): boolean {
  const taskSecret = (env.THEN_TASK_SECRET || '').trim();
  const authHeader = headers.authorization;
  const authorization = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (taskSecret && authorization === `Bearer ${taskSecret}`) return true;

  const nodeEnv = (env.NODE_ENV || '').toLowerCase();
  const isExplicitNonProduction = nodeEnv === 'development' || nodeEnv === 'dev' || nodeEnv === 'test';
  const normalizedRemoteAddr = normalizeSocketRemoteAddress(remoteAddress);
  const isLocal = normalizedRemoteAddr === '127.0.0.1' || normalizedRemoteAddr === '::1';
  return !taskSecret && isExplicitNonProduction && isLocal;
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

      // Hook registry for the Vite dev server
      const logger = getLogger();
      const hookRegistry = createHookRegistry();
      hookRegistry.setLogger(logger);

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

        if (!isTaskAdminRequestAuthorized(req.headers, req.socket?.remoteAddress)) {
          res.statusCode = 403;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Forbidden' }));
          return;
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

            const body = await parseNodeBody(req);
            const input = body && typeof body === 'object' && 'input' in body
              ? (body as { input?: unknown }).input
              : undefined;
            const result = await handlerFn({
              taskId: String(Date.now()),
              input,
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

          // Parse body if needed (uses shared body parser from @then/core)
          const body = await parseNodeBody(req);

          // Create CelsianJS-compatible req/reply
          const cReq: ThenRequest = {
            method,
            url: url.pathname,
            headers: req.headers as Record<string, string>,
            params: matched.params,
            query: Object.fromEntries(url.searchParams.entries()),
            body,
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
            redirect(url: string, status?: number) {
              res.statusCode = status || 302;
              res.setHeader('location', url);
              res.end('Redirecting to ' + url);
              return null;
            },
          };

          // Validate request if route exports a schema
          if (mod.schema) {
            const validationError = validateRequest(cReq, mod.schema);
            if (validationError) {
              res.statusCode = validationError.statusCode;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(validationError.body));
              return;
            }
          }

          // Extract route-level hooks if the module exports them
          const routeHooks: RouteHooks | undefined = mod.hooks;

          // Execute handler with full hook lifecycle
          const hookResult = await executeWithHooks(hookRegistry, cReq, cReply, async () => {
            const result = await handlerFn(cReq, cReply);

            // If handler returned a Response object (Web Standard)
            if (result instanceof Response) {
              res.statusCode = result.status;
              result.headers.forEach((v: string, k: string) => res.setHeader(k, v));
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
          }, routeHooks);

          // If hooks/handler errored and response wasn't sent, send structured error
          if (hookResult.hadError && !res.writableEnded) {
            const error = new HttpError(hookResult.statusCode, 'HANDLER_ERROR', 'Internal Server Error');
            const { statusCode: errStatus, body: errBody } = formatErrorResponse(error, 'development');
            reportError(error, { method, path: url.pathname }, logger);
            res.statusCode = errStatus;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(errBody));
          }
        } catch (err: any) {
          const error = err instanceof Error ? err : new Error(String(err));
          reportError(error, { method, path: url.pathname }, logger);
          if (!res.writableEnded) {
            const { statusCode: errStatus, body: errBody } = formatErrorResponse(error, 'development');
            res.statusCode = errStatus;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(errBody));
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

        // Find matching server-mode page (uses shared matchPageRoute from @then/core)
        const serverPages = manifest.pages.filter(p => p.mode === 'server' || p.mode === 'hybrid');
        const matched = coreMatchPageRoute(serverPages, url.pathname);
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

          // Render with shared renderer from @then/core
          let vnode = Component({ ...serverData, params: matched.params });

          // Wrap in layout chain if layouts are defined (outermost first)
          if (matched.page.layouts && matched.page.layouts.length > 0) {
            for (let li = matched.page.layouts.length - 1; li >= 0; li--) {
              const layoutPath = `/${matched.page.layouts[li]}`;
              const layoutMod = await server.ssrLoadModule(layoutPath);
              const LayoutComponent = layoutMod.default;
              if (typeof LayoutComponent === 'function') {
                vnode = LayoutComponent({ children: vnode, params: matched.params });
              }
            }
          }

          const bodyHtml = builtinRenderToString(vnode);

          const html = wrapDocument(bodyHtml, {
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
          const error = err instanceof Error ? err : new Error(String(err));
          reportError(error, { method: 'GET', path: url.pathname }, logger);
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

// All rendering, matching, parsing, and escaping utilities are now imported
// from @then/core — no local copies needed. See:
//   builtinRenderToString, wrapDocument, escapeHtml — from static-render.ts
//   coreMatchPageRoute (matchPageRoute) — from match.ts
//   parseNodeBody — from body-parser.ts

export default thenPlugin;
