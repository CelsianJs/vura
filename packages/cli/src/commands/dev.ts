/**
 * `vura dev` — Start the local development server.
 *
 * Uses Vite under the hood with @celsian/vura-vite-plugin for:
 * - API route hot-reloading (CelsianJS-compatible req/reply)
 * - Server-mode page rendering (SSR with getServerData)
 * - Task management endpoints (/__tasks/*)
 * - File-based routing with automatic route scanning
 * - TypeScript compilation via Vite's esbuild transform
 *
 * Usage:
 *   vura dev              — Start dev server on port 3000
 *   vura dev --port 8080  — Start on custom port
 */

import { renderToString as builtinRenderToString } from 'what-framework/server';
import { importRouteModule } from './shared.js';
import {
  buildManifest,
  compilePageRoutes,
  matchPageRoute,
  compileRoutes,
  matchApiPath,
  getLogger,
  wrapDocument,
  escapeHtml,
  parseNodeBody,
  reportError,
  getMimeType,
  createApiApp,
  GLOBAL_HOOKS_FILENAMES,
  nodeToWebRequest,
  writeWebResponse,
  generateClientPageEntry,
} from '@celsian/vura-core';
import type {
  PageRoute,
  CompiledPageRoute,
  RuntimeApiRoute,
  GlobalHooks,
} from '@celsian/vura-core';

interface DevOptions {
  port: number;
  host: string;
  projectRoot: string;
}

export function parseDevOptions(args: string[], projectRoot: string = process.cwd()): DevOptions {
  const portArg = args.find((_, i) => args[i - 1] === '--port');
  const hostArg = args.find((_, i) => args[i - 1] === '--host');
  return {
    port: portArg ? parseInt(portArg, 10) : 3000,
    host: hostArg || '127.0.0.1',
    projectRoot,
  };
}

export function isLanDevHost(host: string): boolean {
  return host === '0.0.0.0' || host === '::' || (!['127.0.0.1', 'localhost', '::1'].includes(host));
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

/**
 * Load .env files into process.env without overriding existing values.
 * Priority order: .env.local > .env.{NODE_ENV} > .env
 * (earlier files take precedence — later files don't override)
 */
async function loadEnvFiles(projectRoot: string): Promise<void> {
  const { readFile: rf } = await import('node:fs/promises');
  const { join: pjoin } = await import('node:path');

  const nodeEnv = process.env.NODE_ENV || 'development';
  const envFiles = ['.env.local', `.env.${nodeEnv}`, '.env'];

  for (const envFile of envFiles) {
    try {
      const content = await rf(pjoin(projectRoot, envFile), 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIndex = trimmed.indexOf('=');
        if (eqIndex === -1) continue;
        const key = trimmed.slice(0, eqIndex).trim();
        let value = trimmed.slice(eqIndex + 1).trim();
        // Strip surrounding quotes
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        // Don't override existing env vars (earlier files take precedence)
        if (process.env[key] === undefined) {
          process.env[key] = value;
        }
      }
    } catch {
      // File doesn't exist — skip silently
    }
  }
}

export async function devCommand(args: string[]): Promise<void> {
  const opts = parseDevOptions(args);

  console.log('\n  vura dev\n');

  // Load .env files (.env.local > .env.{NODE_ENV} > .env)
  await loadEnvFiles(opts.projectRoot);

  // Scan routes for initial info
  const manifest = await buildManifest(opts.projectRoot);
  console.log(`  Found ${manifest.api.length} API routes, ${manifest.pages.length} pages`);

  // Try to use Vite with our plugin
  try {
    const vite = await import('vite');
    // @ts-ignore — resolved at runtime via workspace link
    const pluginMod = await import('@celsian/vura-vite-plugin');
    const thenPlugin = pluginMod.thenPlugin ?? pluginMod.default;

    const server = await vite.createServer({
      root: opts.projectRoot,
      server: {
        port: opts.port,
        host: opts.host,
      },
      plugins: [
        thenPlugin({ root: opts.projectRoot }),
      ],
    });

    await server.listen();
    server.printUrls();
    if (isLanDevHost(opts.host)) {
      console.warn(`  [vura] Dev server exposed on ${opts.host}. Only use --host for trusted LAN testing.`);
    }
    console.log();

    // Print route table
    printRouteTable(manifest);
  } catch (err: any) {
    // Vite not available — fall back to standalone Node server
    if (err.code === 'ERR_MODULE_NOT_FOUND' || err.message?.includes('Cannot find')) {
      console.log('  Vite not found, starting standalone dev server...\n');
      await startStandaloneServer(manifest, opts);
    } else {
      throw err;
    }
  }
}

function printRouteTable(manifest: Awaited<ReturnType<typeof buildManifest>>): void {
  console.log('  API Routes:');
  for (const route of manifest.api) {
    const methods = route.methods.join(', ');
    const icon = route.kind === 'serverless' ? 'λ' : route.kind === 'hot' ? '●' : '⏳';
    console.log(`    ${icon} ${methods.padEnd(18)} ${route.urlPattern}`);
  }
  if (manifest.pages.length > 0) {
    console.log('  Pages:');
    for (const page of manifest.pages) {
      const icon = page.mode === 'static' ? '◆' : page.mode === 'server' ? '◈' : page.mode === 'client' ? '◇' : '⬡';
      console.log(`    ${icon} ${page.mode.padEnd(18)} ${page.urlPattern}`);
    }
  }
  console.log();
}

/**
 * Standalone dev server without Vite — for backend-only projects (CelsianJS).
 * Uses Node's built-in HTTP server with file watching.
 */
async function startStandaloneServer(
  manifest: Awaited<ReturnType<typeof buildManifest>>,
  opts: DevOptions,
): Promise<void> {
  const { createServer } = await import('node:http');
  const { watch } = await import('node:fs');
  const { join } = await import('node:path');

  // Thin wrapper so call-sites inside this function keep the same shape
  async function loadHandler(filePath: string): Promise<any> {
    return importRouteModule(opts.projectRoot, filePath);
  }

  const logger = getLogger();

  const { existsSync } = await import('node:fs');

  function findGlobalHooksFile(): string | null {
    for (const filename of GLOBAL_HOOKS_FILENAMES) {
      if (existsSync(join(opts.projectRoot, filename))) return filename;
    }
    return null;
  }

  /**
   * Build a CelsianApp from the current manifest by loading each non-task route
   * module via esbuild + dynamic import. Called on startup and on file changes.
   */
  async function buildStandaloneApiApp(): Promise<{
    app: ReturnType<typeof createApiApp>;
    compiledApiRoutes: ReturnType<typeof compileRoutes>;
  }> {
    const routes: RuntimeApiRoute[] = [];
    for (const route of manifest.api) {
      if (route.kind === 'task') continue;
      const mod = await loadHandler(route.filePath);
      routes.push({ ...route, module: mod as Record<string, unknown> });
    }

    let globalHooks: GlobalHooks | undefined;
    const hooksFile = findGlobalHooksFile();
    if (hooksFile) {
      const hooksMod = await loadHandler(hooksFile);
      const normalize = (v: unknown) =>
        v == null ? [] : Array.isArray(v) ? v : [v];
      globalHooks = {
        onRequest: normalize(hooksMod.onRequest) as GlobalHooks['onRequest'],
        onError: normalize(hooksMod.onError) as GlobalHooks['onError'],
        onResponse: normalize(hooksMod.onResponse) as GlobalHooks['onResponse'],
      };
    }

    // Inject a dev-only onError hook (appended after any user hooks) that prints
    // handler errors to the terminal via reportError so they aren't swallowed by
    // celsian's logger:false + 500 JSON response.
    const devErrorHook = (err: unknown, req: any, _reply: any) => {
      const path: string = req?.url ?? req?.raw?.url ?? '(unknown path)';
      const error = err instanceof Error ? err : new Error(String(err));
      reportError(error, { method: 'handler', path }, logger);
    };

    const mergedHooks: GlobalHooks = {
      onRequest: globalHooks?.onRequest ?? [],
      // Append dev hook after user hooks — never clobbers user hooks.
      onError: [...(globalHooks?.onError ?? []), devErrorHook],
      onResponse: globalHooks?.onResponse ?? [],
    };

    // Compile route regexes for the path-existence pre-check (method-agnostic).
    const compiledApiRoutes = compileRoutes(routes);

    return { app: createApiApp({ routes, globalHooks: mergedHooks }), compiledApiRoutes };
  }

  // Build initial CelsianApp and page route table
  let { app: apiApp, compiledApiRoutes } = await buildStandaloneApiApp();
  // In dev mode, compile ALL page routes — not just server/hybrid.
  // Static and server pages are SSR'd on the fly; client pages are served as
  // a shell + on-demand browser bundle (SSR'ing them would run hooks like
  // useSignal outside a component context and throw).
  let compiledPages: CompiledPageRoute[] = compilePageRoutes(manifest.pages);

  // ── Browser page bundles (client/hybrid) — on-demand esbuild, dev cache ──
  const browserScriptPath = (page: PageRoute): string =>
    '/_then/pages/' + page.filePath.replace(/^src\/pages\//, '').replace(/\.(tsx|jsx|ts|js)$/, '.js');

  const browserBundleCache = new Map<string, string>();

  async function bundleBrowserPage(page: PageRoute): Promise<string> {
    const cached = browserBundleCache.get(page.filePath);
    if (cached !== undefined) return cached;

    const { build: esbuild } = await import('esbuild');
    const { dirname, basename, resolve } = await import('node:path');
    const absPath = resolve(opts.projectRoot, page.filePath);

    let jsxImportSource = '@celsian/vura-core';
    try {
      // @ts-ignore — optional peer dep
      await import('what-framework/jsx-runtime');
      jsxImportSource = 'what-framework';
    } catch { /* not installed — keep default */ }

    const result = await esbuild({
      stdin: {
        contents: generateClientPageEntry(`./${basename(absPath)}`, page.mode as 'client' | 'hybrid'),
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
      nodePaths: [join(opts.projectRoot, 'node_modules')],
    });

    const text = result.outputFiles[0]!.text;
    browserBundleCache.set(page.filePath, text);
    return text;
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const method = (req.method ?? 'GET').toUpperCase();
    const reqCtx = logger.requestStart(method, url.pathname);
    const log = logger.child(reqCtx.requestId);

    // Track response to log at end
    res.on("finish", () => {
      logger.requestEnd(reqCtx, res.statusCode);
    });

    // CORS headers are opt-in for dev mode; no wildcard CORS by default.
    const corsOrigin = process.env.THEN_CORS_ORIGIN;
    if (corsOrigin) {
      res.setHeader('Access-Control-Allow-Origin', corsOrigin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
      res.setHeader('Access-Control-Max-Age', '86400');
    }

    // Handle CORS preflight
    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Static file serving from public/ directory
    if (method === 'GET' || method === 'HEAD') {
      const publicDir = join(opts.projectRoot, 'public');
      const safePath = url.pathname.replace(/\.\./g, ''); // basic traversal guard
      const staticPath = join(publicDir, safePath);
      // Only serve if path is within publicDir (prevent traversal)
      const { normalize: normPath, resolve: resolvePath } = await import('node:path');
      const normalizedStatic = normPath(resolvePath(staticPath));
      const normalizedPublic = normPath(resolvePath(publicDir));
      if (normalizedStatic.startsWith(normalizedPublic + '/') || normalizedStatic === normalizedPublic) {
        try {
          const { stat: statAsync } = await import('node:fs/promises');
          const fileStat = await statAsync(normalizedStatic);
          if (fileStat.isFile()) {
            const { createReadStream } = await import('node:fs');
            const contentType = getMimeType(normalizedStatic);
            res.writeHead(200, {
              'Content-Type': contentType,
              'Content-Length': fileStat.size.toString(),
              'Cache-Control': 'no-cache',
            });
            if (method === 'HEAD') { res.end(); return; }
            const stream = createReadStream(normalizedStatic);
            stream.pipe(res);
            stream.on('error', () => { if (!res.writableEnded) res.end(); });
            return;
          }
        } catch {
          // File doesn't exist — fall through to route matching
        }
      }
    }

    // Health check
    if (url.pathname === '/__health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, framework: 'Vura', mode: 'dev' }));
      return;
    }

    // Task management endpoints
    if (url.pathname.startsWith('/__tasks')) {
      if (!isTaskAdminRequestAuthorized(req.headers, req.socket?.remoteAddress)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden' }));
        return;
      }
    }

    if (url.pathname === '/__tasks' && method === 'GET') {
      const taskRoutes = manifest.api.filter(r => r.kind === 'task');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        tasks: taskRoutes.map(r => ({ name: r.urlPattern, config: r.config })),
      }));
      return;
    }

    if (url.pathname.startsWith('/__tasks/') && method === 'POST') {
      const taskName = url.pathname.slice('/__tasks/'.length);
      const taskRoutes = manifest.api.filter(r => r.kind === 'task');
      const taskRoute = taskRoutes.find(r =>
        r.urlPattern.replace(/^\/api\//, '').replace(/\//g, '.') === taskName
      );
      if (!taskRoute) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Task not found: ' + taskName }));
        return;
      }
      try {
        const mod = await loadHandler(taskRoute.filePath);
        const body = await parseNodeBody(req);
        const result = await mod.POST({
          taskId: String(Date.now()),
          input: (body as any)?.input,
          attempt: 1,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'completed', result }));
      } catch (err: any) {
        reportError(err instanceof Error ? err : new Error(String(err.message)), { method, path: url.pathname, requestId: reqCtx.requestId }, logger);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // Route info
    if (url.pathname === '/' && manifest.pages.length === 0) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        framework: 'Vura',
        mode: 'dev',
        routes: manifest.api.map(r => r.methods.map(m => `${m} ${r.urlPattern}`)).flat(),
      }));
      return;
    }

    // Try API route matching via CelsianApp.handle (A1.3 dev/prod parity)
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/__vura/')) {
      // Route-existence pre-check (method-agnostic): if no manifest API route
      // pattern matches this pathname, skip celsian entirely and fall through to
      // pages/404. This also correctly passes through intentional handler 404s —
      // if the route exists but returns 404, that response is delivered as-is.
      if (matchApiPath(compiledApiRoutes, url.pathname)) {
        try {
          const webReq = nodeToWebRequest(req, url);
          const webRes = await apiApp.handle(webReq);
          // A matched route's response is always delivered — including intentional
          // 404s from the handler. The pre-check above guarantees the route exists.
          await writeWebResponse(res, webRes);
          return;
        } catch (err: any) {
          const error = err instanceof Error ? err : new Error(String(err));
          reportError(error, { method, path: url.pathname, requestId: reqCtx.requestId }, logger);
          if (!res.writableEnded) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
          }
          return;
        }
      }
      // No manifest route matched — fall through to pages/404.
    }

    // Serve on-demand browser bundles for client/hybrid pages (mirrors the
    // production /_then/pages/*.js layout emitted by `vura build`).
    if (method === 'GET' && url.pathname.startsWith('/_then/pages/') && url.pathname.endsWith('.js')) {
      const target = manifest.pages.find(
        p => (p.mode === 'client' || p.mode === 'hybrid') && browserScriptPath(p) === url.pathname,
      );
      if (target) {
        try {
          const code = await bundleBrowserPage(target);
          res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(code);
        } catch (err: any) {
          const error = err instanceof Error ? err : new Error(String(err));
          reportError(error, { method: 'GET', path: url.pathname, requestId: reqCtx.requestId }, logger);
          if (!res.writableEnded) {
            res.writeHead(500, { 'Content-Type': 'text/javascript' });
            res.end(`console.error(${JSON.stringify('[vura] client bundle failed: ' + error.message)});`);
          }
        }
        return;
      }
    }

    // Try server-mode page matching (uses shared compilePageRoutes/matchPageRoute)
    if (method === 'GET' && !/\.\w+$/.test(url.pathname)) {
      const pageMatch = matchPageRoute(compiledPages, url.pathname);
      if (pageMatch) {
        try {
          const mod = await loadHandler(pageMatch.page.filePath);
          const Component = mod.default;
          const pageConfig = mod.page ?? {};

          // Client pages render entirely in the browser: serve the shell +
          // bundle. SSR'ing them here would call hooks (useSignal, useState)
          // outside a component context and 500.
          if (pageMatch.page.mode === 'client') {
            const html = wrapDocument('<div id="loading">Loading...</div>', {
              title: pageConfig.title ?? 'Vura App',
              meta: pageConfig.meta ?? [],
              styles: pageConfig.styles ?? [],
              scripts: [...(pageConfig.scripts ?? []), browserScriptPath(pageMatch.page)],
              head: pageConfig.head ?? '',
            });
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(html);
            return;
          }

          if (typeof Component === 'function') {
            let serverData: Record<string, unknown> = {};
            if (typeof mod.getServerData === 'function') {
              serverData = await mod.getServerData({
                params: pageMatch.params,
                url: url.pathname,
                query: Object.fromEntries(url.searchParams.entries()),
              });
            }

            let vnode = Component({ ...serverData, params: pageMatch.params });

            // Wrap in layout chain if layouts are defined (outermost first)
            if (pageMatch.page.layouts && pageMatch.page.layouts.length > 0) {
              // Load layouts innermost-last, wrap from inside out
              for (let li = pageMatch.page.layouts.length - 1; li >= 0; li--) {
                const layoutMod = await loadHandler(pageMatch.page.layouts[li]);
                const LayoutComponent = layoutMod.default;
                if (typeof LayoutComponent === 'function') {
                  vnode = LayoutComponent({ children: vnode, params: pageMatch.params });
                }
              }
            }

            const bodyHtml = builtinRenderToString(vnode);
            const html = wrapDocument(bodyHtml, {
              title: pageConfig.title ?? 'Vura App',
              meta: pageConfig.meta ?? [],
              styles: pageConfig.styles ?? [],
              // Hybrid pages also load their browser bundle so hydrate() runs
              // against the SSR'd DOM — same contract as the production build.
              scripts: [
                ...(pageConfig.scripts ?? []),
                ...(pageMatch.page.mode === 'hybrid' ? [browserScriptPath(pageMatch.page)] : []),
              ],
              head: pageConfig.head ?? '',
            });

            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(html);
            return;
          }
        } catch (err: any) {
          const error = err instanceof Error ? err : new Error(String(err));
          reportError(error, { method: 'GET', path: url.pathname, requestId: reqCtx.requestId }, logger);
          log.error(`page render error ${url.pathname}`, { error: err.message });
          if (!res.writableEnded) {
            res.writeHead(500, { 'Content-Type': 'text/html' });
            res.end(`<h1>500 — Server Error</h1><pre>${escapeHtml(err.message)}</pre>`);
          }
          return;
        }
      }
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found', path: url.pathname }));
  });

  // Watch for file changes and re-scan manifest
  const apiDir = join(opts.projectRoot, 'src', 'api');
  const pagesDir = join(opts.projectRoot, 'src', 'pages');
  const watchDirs = [apiDir, pagesDir];
  for (const dir of watchDirs) {
    try {
      const watcher = watch(dir, { recursive: true }, async (event, filename) => {
        const prefix = dir === apiDir ? 'src/api' : 'src/pages';
        console.log(`  [vura] ${event}: ${prefix}/${filename} — re-scanning routes`);
        const { buildManifest: rescan, compilePageRoutes: recompilePages } = await import('@celsian/vura-core');
        manifest = await rescan(opts.projectRoot);
        compiledPages = recompilePages(manifest.pages);
        browserBundleCache.clear();
        // Rebuild CelsianApp and route regexes with fresh modules after manifest rescan
        ({ app: apiApp, compiledApiRoutes } = await buildStandaloneApiApp());
      });
      process.on('SIGINT', () => { watcher.close(); process.exit(0); });
    } catch {
      // Watch may fail if directory doesn't exist yet
    }
  }

  server.listen(opts.port, opts.host, () => {
    console.log(`  Server listening on http://${opts.host}:${opts.port}\n`);
    // Warn once at startup when the user explicitly exposes the dev server beyond loopback.
    if (isLanDevHost(opts.host)) {
      console.warn(`  [vura] Dev server exposed on ${opts.host}. Only use --host for trusted LAN testing.`);
    }
    printRouteTable(manifest);
  });

  // Keep process alive
  await new Promise(() => {});
}

// All rendering, matching, parsing, and escaping utilities are now imported
// from @celsian/vura-core — no local copies needed. See:
//   wrapDocument, escapeHtml — from static-render.ts; renderToString — from what-framework/server
//   compilePageRoutes, matchPageRoute — from match.ts
//   createApiApp, nodeToWebRequest, writeWebResponse — A1.3 celsian API path
