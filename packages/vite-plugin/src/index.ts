/**
 * @celsian/vura-vite-plugin
 *
 * Vite plugin for Vura that:
 * 1. Adds dev middleware for API routes via CelsianApp.handle (A1.3)
 * 2. Adds dev middleware for ALL four page modes (static, server, hybrid, client),
 *    matching the production build and the standalone dev server:
 *      - static — SSR'd fresh per request (live reload; zero client JS)
 *      - server — SSR'd per request with getServerData
 *      - hybrid — SSR'd + client bundle for hydration
 *      - client — SPA shell + client bundle (boots in the browser)
 * 3. Serves on-demand client/hybrid browser bundles at /_then/pages/*.js
 *    (esbuild, mirroring the `vura build` output layout)
 * 4. Adds dev middleware for task management (/__tasks/*)
 * 5. Runs app middleware and server actions with browser fetch stubs
 * 6. Watches src/ for file changes and hot-reloads routes and browser bundles
 * 7. Scans file-based routes on startup
 */

import {
  buildManifest,
  matchPageRoute as coreMatchPageRoute,
  matchApiPath,
  compileRoutes,
  wrapDocument,
  escapeHtml,
  parseNodeBody,
  reportError,
  getLogger,
  runTaskOnce,
  buildTaskEnvelope,
  createApiApp,
  createWsUpgradeHandler,
  createNoServerWebSocketServer,
  GLOBAL_HOOKS_FILENAMES,
  nodeToWebRequest,
  writeWebResponse,
  generateClientPageEntry,
  vuraBrowserResolvePlugin,
  vuraActionsStubPlugin,
  registerActionModules,
  ACTION_ENDPOINT,
  createMiddlewareRunner,
  createVuraRenderRoute,
  createVuraStreamRoute,
  isStreamingPage,
} from '@celsian/vura-core';
import type {
  RouteManifest,
  PageRoute,
  RuntimeApiRoute,
  GlobalHooks,
  MiddlewareModule,
  RuntimePage,
} from '@celsian/vura-core';

// CelsianApp type derived from createApiApp return — avoids needing @celsian/core as a direct dep
type CelsianApp = ReturnType<typeof createApiApp>;
import type { Plugin, ViteDevServer } from 'vite';
import { existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

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

function findGlobalHooksFile(projectRoot: string): string | null {
  for (const filename of GLOBAL_HOOKS_FILENAMES) {
    if (existsSync(join(projectRoot, filename))) return filename;
  }
  return null;
}

/**
 * Build a CelsianApp from the current manifest by loading each non-task route
 * module via Vite's SSR module graph (gets HMR for free).
 *
 * Called once on startup and on every manifest rescan (file add/change/unlink).
 */
async function buildApiApp(
  manifest: RouteManifest,
  projectRoot: string,
  server: ViteDevServer,
): Promise<CelsianApp> {
  // Load each non-task route module
  const routes: RuntimeApiRoute[] = [];
  for (const route of manifest.api) {
    if (route.kind === 'task') continue; // tasks handled by /__tasks/* middleware
    const modulePath = `/${route.filePath}`;
    const mod = await server.ssrLoadModule(modulePath);
    routes.push({ ...route, module: mod as Record<string, unknown> });
  }

  // Load global hooks if the project has a _hooks.ts file
  let globalHooks: GlobalHooks | undefined;
  const hooksFile = findGlobalHooksFile(projectRoot);
  if (hooksFile) {
    const hooksMod = await server.ssrLoadModule(`/${hooksFile}`);
    const normalize = (v: unknown) =>
      v == null ? [] : Array.isArray(v) ? v : [v];
    globalHooks = {
      onRequest: normalize(hooksMod.onRequest) as GlobalHooks['onRequest'],
      onError: normalize(hooksMod.onError) as GlobalHooks['onError'],
      onResponse: normalize(hooksMod.onResponse) as GlobalHooks['onResponse'],
    };
  }

  // Inject a dev-only onError hook (appended after any user hooks) that prints
  // handler errors to the terminal so they aren't silently swallowed by celsian's
  // logger:false + 500 JSON response. Uses server.config.logger (same as Vite plugins).
  const devErrorHook = (err: unknown, req: any, _reply: any) => {
    const path: string = req?.url ?? req?.raw?.url ?? '(unknown path)';
    const message = err instanceof Error ? err.message : String(err);
    // Use Vite's logger so the output matches other Vite plugin messages.
    // server is captured by closure; logger is available after configureServer.
    server.config.logger.error(`  [then] Handler error on ${path}: ${message}`, {
      error: err instanceof Error ? err : new Error(message),
    });
  };

  const mergedHooks: GlobalHooks = {
    onRequest: globalHooks?.onRequest ?? [],
    // Append dev hook after user hooks — never clobbers user hooks.
    onError: [...(globalHooks?.onError ?? []), devErrorHook],
    onResponse: globalHooks?.onResponse ?? [],
  };

  const actionModules: Record<string, Record<string, unknown>> = {};
  for (const action of manifest.actions ?? []) {
    actionModules[action.moduleId] = await server.ssrLoadModule(`/${action.filePath}`);
  }
  const enableActions = Object.keys(actionModules).length > 0;
  if (enableActions) registerActionModules(actionModules);
  return createApiApp({ routes, globalHooks: mergedHooks, enableActions });
}

export function thenPlugin(options: ThenPluginOptions = {}): Plugin {
  let manifest: RouteManifest;
  let projectRoot: string;
  // The CelsianApp instance — rebuilt whenever the manifest is rescanned.
  let apiApp: CelsianApp | null = null;
  // Compiled API route regexes for path-existence pre-check (method-agnostic).
  // Kept in sync with apiApp — rebuilt together whenever manifest rescans.
  let compiledApiRoutes: ReturnType<typeof compileRoutes> = [];

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

      const logger = getLogger();

      // Build the initial CelsianApp and compile route regexes for 404 pre-check
      apiApp = await buildApiApp(manifest, projectRoot, server);
      compiledApiRoutes = compileRoutes(manifest.api.filter(r => r.kind !== 'task'));

      // ── Browser page bundles (client/hybrid) — on-demand esbuild, dev cache ──
      // Mirrors the standalone dev server and `vura build`: each client/hybrid
      // page gets a bundle served at /_then/pages/<file>.js, referenced from the
      // page shell. The bundle is a generateClientPageEntry() wrapper that calls
      // mount() (client) / hydrate() (hybrid) — bundling the raw page module
      // alone would leave the shell at "Loading..." forever.
      const browserScriptPath = (page: PageRoute): string =>
        '/_then/pages/' + page.filePath.replace(/^src\/pages\//, '').replace(/\.(tsx|jsx|ts|js)$/, '.js');

      const browserBundleCache = new Map<string, string>();

      async function bundleBrowserPage(page: PageRoute): Promise<string> {
        const cached = browserBundleCache.get(page.filePath);
        if (cached !== undefined) return cached;

        const { build: esbuild } = await import('esbuild');
        const { dirname, basename, resolve } = await import('node:path');
        const absPath = resolve(projectRoot, page.filePath);

        let jsxImportSource = '@celsian/vura-core';
        try {
          // @ts-ignore — optional peer dep
          await import('what-framework/jsx-runtime');
          jsxImportSource = 'what-framework';
        } catch { /* not installed — keep default */ }

        const result = await esbuild({
          stdin: {
            contents: generateClientPageEntry(`./${basename(absPath)}`, page.mode as 'client' | 'hybrid', {
              dev: true,
              layoutImportSpecifiers: (page.layouts ?? []).map((layout) => {
                const specifier = relative(dirname(absPath), resolve(projectRoot, layout)).replace(/\\/g, '/');
                return specifier.startsWith('.') ? specifier : `./${specifier}`;
              }),
            }),
            resolveDir: dirname(absPath),
            sourcefile: '__vura-client-entry__.js',
            loader: 'js',
          },
          bundle: true,
          format: 'esm',
          target: 'es2022',
          platform: 'browser',
          write: false,
          outfile: 'page.js',
          jsx: 'automatic',
          jsxImportSource,
          plugins: [vuraBrowserResolvePlugin(), vuraActionsStubPlugin({ projectRoot })],
          nodePaths: [join(projectRoot, 'node_modules')],
        });

        const text = result.outputFiles[0]!.text;
        browserBundleCache.set(page.filePath, text);
        return text;
      }

      // Watch route, action, middleware and shared browser dependencies.
      const apiDir = `${projectRoot}/src/api`;
      const pagesDir = `${projectRoot}/src/pages`;
      const actionsDir = `${projectRoot}/src/actions`;
      const srcDir = `${projectRoot}/src`;
      server.watcher.add(srcDir);

      // Open ws connection count — used by the rescan notice below.
      let openWsConnections = 0;
      const rescanOnChange = async (file: string) => {
        // Bundles can import shared components outside pages and actions too.
        if (file.startsWith(srcDir + '/')) browserBundleCache.clear();
        if ([apiDir, pagesDir, actionsDir].some(dir => file.startsWith(dir + '/')) ||
          /^middleware\.(ts|tsx|js|jsx|mts|mjs)$/.test(relative(srcDir, file))) {
          const rel = file.replace(projectRoot + '/', '');
          console.log(`  [then] Route changed: ${rel}`);
          try {
            const nextManifest = await buildManifest(projectRoot);
            // Rebuild the CelsianApp and route regexes with fresh modules,
            // swapping only on success — a broken edit (syntax error) must
            // not crash the dev server via an unhandled rejection.
            apiApp = await buildApiApp(nextManifest, projectRoot, server);
            manifest = nextManifest;
            compiledApiRoutes = compileRoutes(manifest.api.filter(r => r.kind !== 'task'));
            // Drop stale client/hybrid bundles so page edits apply on next request.
            browserBundleCache.clear();
            // The rebuilt app has a NEW wsRegistry; peers connected before this
            // rescan stay in the old one, so broadcasts split until reconnect.
            if (openWsConnections > 0) {
              console.log('  [then] routes re-scanned — open WebSocket clients keep their old room registry; reconnect to rejoin');
            }
          } catch (err) {
            console.error(`  [then] route re-scan failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      };

      server.watcher.on('change', rescanOnChange);
      server.watcher.on('add', rescanOnChange);
      server.watcher.on('unlink', rescanOnChange);

      // ─── WebSocket upgrades for hot routes ───
      // Vite's own HMR websocket shares this HTTP server: its listener only
      // claims upgrades whose sec-websocket-protocol is vite-hmr/vite-ping at
      // the HMR base path (vite@6 createWebSocketServer). Our handler returns
      // WITHOUT touching the socket for those — and for any path that matches
      // no hot route (onUnmatched: 'ignore') — so co-listeners stay functional.
      const hasHotWsRoutes = () =>
        manifest.api.some((r) => r.kind === 'hot' && r.hasWebsocket);
      let wsMod: unknown;
      try {
        wsMod = await import('ws');
      } catch {
        // 'ws' is an optional peer dep — warn only when the project actually
        // has websocket hot routes that would silently not work.
        if (hasHotWsRoutes()) {
          console.warn(
            '  [then] Hot routes export websocket() but the "ws" package is not installed. ' +
            'Install it with: pnpm add ws (or npm install ws). WebSocket upgrades are disabled in dev.',
          );
        }
      }
      if (wsMod !== undefined && server.httpServer) {
        const wss = createNoServerWebSocketServer(wsMod);
        const upgradeHandler = createWsUpgradeHandler({
          wss,
          // Re-read the manifest closure on every upgrade — rescanOnChange
          // keeps it fresh, so hot routes added/renamed mid-session connect
          // without rewiring.
          getWsRoutes: () =>
            compileRoutes(manifest.api.filter((r) => r.kind === 'hot' && r.hasWebsocket)),
          // ssrLoadModule → edits to the route file apply on next connection.
          loadModule: (route) => server.ssrLoadModule(`/${route.filePath}`),
          // apiApp is rebuilt on rescan — always use the LATEST app's registry.
          // Non-null: apiApp is built above before this handler is wired.
          getWsRegistry: () => apiApp!.wsRegistry,
          onUnmatched: 'ignore',
          onOpen: () => { openWsConnections++; },
          onClose: () => { openWsConnections--; },
        });
        server.httpServer.on('upgrade', (req, socket, head) => {
          // Vite HMR/ping traffic is Vite's — never touch it (cheap check
          // first). The header is a comma-separated subprotocol list: compare
          // exact trimmed tokens so e.g. `x-vite-hmr` is NOT mistaken for it.
          const protocol = req.headers['sec-websocket-protocol'];
          const isViteTraffic = typeof protocol === 'string' &&
            protocol.split(',').some((p) => {
              const token = p.trim();
              return token === 'vite-hmr' || token === 'vite-ping';
            });
          if (isViteTraffic) return;
          upgradeHandler(req, socket, head);
        });
      }

      // Middleware runs before Vura routes and Vite's static serving. Build a
      // headers-only Request: converting/reading a POST body here would consume
      // the stream before Celsian's API/action handler gets it.
      server.middlewares.use(async (req, res, next) => {
        try {
          if (!manifest.middleware) return next();
          const mod = await server.ssrLoadModule(`/${manifest.middleware}`);
          const runner = createMiddlewareRunner(mod as MiddlewareModule);
          const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
          const headers = new Headers();
          for (const [name, value] of Object.entries(req.headers)) {
            if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
          }
          const outcome = await runner.run(new Request(url, { method: req.method ?? 'GET', headers }), url);
          if (outcome.response) {
            await writeWebResponse(res, outcome.response);
            return;
          }
          // Apply to the Node response, not a Celsian fast-response snapshot.
          for (const [name, value] of outcome.headers ?? []) {
            if (!res.hasHeader(name)) res.setHeader(name, value);
          }
          next();
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          reportError(error, { method: req.method ?? 'GET', path: req.url ?? '/' }, logger);
          // A broken guard must not silently turn into an unguarded page.
          if (!res.writableEnded) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Cache-Control', 'private, no-store');
            res.end('Middleware failed');
          }
        }
      });

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
            // Accept both `{ input: ... }` (legacy admin convention + the
            // platform's `{ taskId, input, attempt }` wrapper) and a raw payload
            // posted directly as the body (enqueue()'s local fallback).
            const input = body && typeof body === 'object' && 'input' in body
              ? (body as { input?: unknown }).input
              : body;
            // Platform cron/synthetic dispatches (X-Vura-Cron: true) skip input
            // validation, mirroring the standalone server + in-process cron.
            const isCronDispatch = String(req.headers['x-vura-cron'] ?? '').toLowerCase() === 'true';

            const runResult = await runTaskOnce({
              name: taskName,
              config: {
                retries: typeof taskRoute.config.retries === 'number' ? taskRoute.config.retries : 0,
                timeout: typeof taskRoute.config.timeout === 'number' ? taskRoute.config.timeout : 30_000,
              },
              handler: handlerFn as (ctx: { attempt: number; input: unknown }) => unknown,
              inputSchema: isCronDispatch ? undefined : mod.input,
            }, { input });

            if (runResult.validationError) {
              res.statusCode = runResult.validationError.statusCode;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(runResult.validationError.body));
              return;
            }

            // Additive envelope + legacy status/result for backward compatibility.
            const envelope = buildTaskEnvelope(taskName, runResult);
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ...envelope, status: runResult.status, ...(runResult.error !== undefined ? { error: runResult.error } : {}) }));
          } catch (err: any) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: err.message }));
          }
          return;
        }

        return next();
      });

      // ─── API route middleware (served by CelsianApp.handle) ───
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

        // Only handle /api/* routes (and /__vura/revalidate which createApiApp registers)
        if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/__vura/')) {
          return next();
        }

        if (!apiApp) return next();

        // Route-existence pre-check (method-agnostic): if no manifest API route
        // pattern matches this pathname, skip celsian entirely and let next()
        // handle it. This avoids an unnecessary handle() call AND correctly
        // distinguishes "no route" (next()) from a route handler intentionally
        // returning 404 (pass the response through regardless of status).
        const isActionEndpoint = url.pathname === ACTION_ENDPOINT && (manifest.actions?.length ?? 0) > 0;
        if (!isActionEndpoint && !matchApiPath(compiledApiRoutes, url.pathname)) {
          return next();
        }

        try {
          const webReq = nodeToWebRequest(req, url);
          const webRes = await apiApp.handle(webReq);
          // A matched route's response is always delivered — including intentional
          // 404s from the handler. The pre-check above guarantees the route exists.
          await writeWebResponse(res, webRes);
        } catch (err: any) {
          const error = err instanceof Error ? err : new Error(String(err));
          reportError(error, { method: req.method ?? 'GET', path: url.pathname }, logger);
          if (!res.writableEnded) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: error.message }));
          }
        }
      });

      // ─── Browser page bundle middleware (client/hybrid) ───
      // Serves the on-demand esbuild bundles at /_then/pages/*.js, mirroring the
      // production /_then/pages/*.js layout emitted by `vura build`.
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
        const method = (req.method ?? 'GET').toUpperCase();
        if (method !== 'GET') return next();
        if (!url.pathname.startsWith('/_then/pages/') || !url.pathname.endsWith('.js')) {
          return next();
        }
        const target = manifest.pages.find(
          p => (p.mode === 'client' || p.mode === 'hybrid') && browserScriptPath(p) === url.pathname,
        );
        if (!target) return next();
        try {
          const code = await bundleBrowserPage(target);
          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.end(code);
        } catch (err: any) {
          const error = err instanceof Error ? err : new Error(String(err));
          reportError(error, { method: 'GET', path: url.pathname }, logger);
          if (!res.writableEnded) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'text/javascript');
            res.end(`console.error(${JSON.stringify('[vura] client bundle failed: ' + error.message)});`);
          }
        }
      });

      // ─── Page middleware (all four modes: static, server, hybrid, client) ───
      // Matches the standalone dev server and the production build:
      //   - client — serve the SPA shell + browser bundle (no SSR; SSR'ing a
      //     client page would run hooks like useSignal outside a component and 500)
      //   - static/server/hybrid — SSR the component fresh per request; hybrid
      //     also loads its browser bundle so hydrate() runs against the SSR'd DOM.
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
        const method = (req.method ?? 'GET').toUpperCase();

        if (method !== 'GET' && method !== 'HEAD') return next();
        // Skip API routes, static assets, Vite internals
        if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/@') || url.pathname.startsWith('/__')) {
          return next();
        }
        // Skip file requests (has extension)
        if (/\.\w+$/.test(url.pathname)) return next();

        // Match against ALL page modes (uses shared matchPageRoute from @celsian/vura-core)
        const matched = coreMatchPageRoute(manifest.pages, url.pathname);
        if (!matched) return next();

        try {
          const pageMode = matched.page.mode;
          const modulePath = `/${matched.page.filePath}`;
          const mod = await server.ssrLoadModule(modulePath);
          const pageConfig = mod.page ?? {};

          // Client pages render entirely in the browser: serve the shell +
          // bundle. SSR'ing them here would call hooks (useSignal, useState)
          // outside a component context and 500.
          if (pageMode === 'client') {
            const html = wrapDocument('<div id="loading">Loading...</div>', {
              title: pageConfig.title ?? 'Vura App',
              meta: pageConfig.meta ?? [],
              styles: pageConfig.styles ?? [],
              scripts: [...(pageConfig.scripts ?? []), browserScriptPath(matched.page)],
              head: pageConfig.head ?? '',
            });
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.setHeader('Cache-Control', 'private, no-store');
            res.end(method === 'HEAD' ? undefined : html);
            return;
          }

          const Component = mod.default;
          if (typeof Component !== 'function') {
            return next();
          }

          const layoutModules = [];
          for (const layout of matched.page.layouts ?? []) {
            layoutModules.push(await server.ssrLoadModule(`/${layout}`));
          }
          // Dev SSRs every non-client mode fresh, without ISR. Use the same
          // runtime as a built server for hooks, loaders, layouts and payloads.
          const runtimePage: RuntimePage = {
            ...matched.page,
            mode: 'server',
            config: { ...matched.page.config, revalidate: undefined },
            module: mod,
            layoutModules,
          };
          const query: Record<string, string | string[]> = Object.create(null);
          for (const key of new Set(url.searchParams.keys())) {
            const values = url.searchParams.getAll(key);
            query[key] = values.length > 1 ? values : values[0]!;
          }
          const routeMatch = {
            path: url.pathname,
            query,
            config: { mode: 'server' as const },
            route: { path: url.pathname, page: { mode: 'server' as const }, vura: runtimePage },
            params: matched.params,
            request: nodeToWebRequest(req, url),
          };
          const renderOptions = {
            extraScripts: () => pageMode === 'hybrid' ? [browserScriptPath(matched.page)] : [],
          };
          if (isStreamingPage(runtimePage)) {
            await writeWebResponse(res, await createVuraStreamRoute(renderOptions)(routeMatch));
            return;
          }
          const result = await createVuraRenderRoute(renderOptions)(routeMatch);
          res.statusCode = result.status;
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.setHeader('Cache-Control', 'private, no-store');
          for (const [name, value] of Object.entries(result.headers ?? {})) res.setHeader(name, value);
          res.end(method === 'HEAD' ? undefined : result.html);
        } catch (err: any) {
          const error = err instanceof Error ? err : new Error(String(err));
          reportError(error, { method: 'GET', path: url.pathname }, logger);
          if (!res.writableEnded) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'text/html');
            res.setHeader('Cache-Control', 'private, no-store');
            res.end(method === 'HEAD' ? undefined : `<h1>500 — Server Error</h1><pre>${escapeHtml(String(err.message))}</pre>`);
          }
        }
      });
    },
  };
}

// All rendering, matching, parsing, and escaping utilities are now imported
// from @celsian/vura-core — no local copies needed. See:
//   wrapDocument, escapeHtml — from static-render.ts; render callbacks — from runtime/pages.ts
//   coreMatchPageRoute (matchPageRoute) — from match.ts
//   createApiApp, nodeToWebRequest, writeWebResponse — A1.3 celsian API path

export default thenPlugin;
