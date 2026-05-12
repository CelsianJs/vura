/**
 * `then dev` — Start the local development server.
 *
 * Uses Vite under the hood with @celsian/then-vite-plugin for:
 * - API route hot-reloading (CelsianJS-compatible req/reply)
 * - Server-mode page rendering (SSR with getServerData)
 * - Task management endpoints (/__tasks/*)
 * - File-based routing with automatic route scanning
 * - TypeScript compilation via Vite's esbuild transform
 *
 * Usage:
 *   then dev              — Start dev server on port 3000
 *   then dev --port 8080  — Start on custom port
 */

import {
  buildManifest,
  matchRoute,
  compileRoutes,
  compilePageRoutes,
  matchPageRoute,
  getLogger,
  builtinRenderToString,
  wrapDocument,
  escapeHtml,
  parseNodeBody,
  executeWithHooks,
  finalizeNodeHandlerResult,
  createHookRegistry,
  validateRequest,
  sendErrorResponse,
  reportError,
  formatErrorResponse,
  HttpError,
  getMimeType,
} from '@celsian/then-core';
import type {
  PageRoute,
  ThenRequest,
  ThenReply,
  CompiledRoute,
  CompiledPageRoute,
  HookRegistry,
  RouteHooks,
} from '@celsian/then-core';

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

  console.log('\n  then dev\n');

  // Load .env files (.env.local > .env.{NODE_ENV} > .env)
  await loadEnvFiles(opts.projectRoot);

  // Scan routes for initial info
  const manifest = await buildManifest(opts.projectRoot);
  console.log(`  Found ${manifest.api.length} API routes, ${manifest.pages.length} pages`);

  // Try to use Vite with our plugin
  try {
    const vite = await import('vite');
    // @ts-ignore — resolved at runtime via workspace link
    const pluginMod = await import('@celsian/then-vite-plugin');
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
  const { readFile: readFileAsync, writeFile: writeFileAsync, mkdir: mkdirAsync } = await import('node:fs/promises');
  const { join, resolve } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const { build: esbuild } = await import('esbuild');

  const tmpDir = join(opts.projectRoot, 'node_modules', '.then-dev-cache');
  await mkdirAsync(tmpDir, { recursive: true });

  // Determine JSX import source
  let jsxImportSource = '@celsian/then-core';
  try {
    // @ts-ignore — optional dependency
    await import('what-framework/jsx-runtime');
    jsxImportSource = 'what-framework';
  } catch {}

  async function loadHandler(filePath: string): Promise<any> {
    const absPath = resolve(opts.projectRoot, filePath);
    const isPage = filePath.endsWith('.tsx') || filePath.endsWith('.jsx');
    const result = await esbuild({
      entryPoints: [absPath],
      bundle: true,
      format: 'esm',
      target: 'es2022',
      platform: 'node',
      write: false,
      outfile: 'handler.mjs',
      ...(isPage ? { jsx: 'automatic', jsxImportSource } : {}),
    });
    const hash = Date.now().toString(36);
    const outPath = join(tmpDir, `${filePath.replace(/[/\\:]/g, '_')}_${hash}.mjs`);
    await writeFileAsync(outPath, result.outputFiles[0].text);
    return import(pathToFileURL(outPath).href);
  }

  const logger = getLogger();

  // Hook registry for the dev server — routes can register hooks via exports
  const hookRegistry = createHookRegistry();
  hookRegistry.setLogger(logger);

  // Pre-compile route regexes at startup — recompiled only on file change
  let compiledRoutes: CompiledRoute[] = compileRoutes(manifest.api);
  let compiledPages: CompiledPageRoute[] = compilePageRoutes(
    manifest.pages.filter(p => p.mode === 'server' || p.mode === 'hybrid'),
  );

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

    // Try API route matching (uses pre-compiled regexes)
    const match = matchRoute(compiledRoutes, method, url.pathname);
    if (match) {
      const mod = await loadHandler(match.route.filePath);
      const handlerFn = mod[method];

      if (typeof handlerFn !== 'function') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Method ${method} not exported` }));
        return;
      }

      const body = await parseNodeBody(req);

      const cReq: ThenRequest = {
        method,
        url: url.pathname,
        headers: req.headers,
        params: match.params,
        query: Object.fromEntries(url.searchParams.entries()),
        body,
        parsedBody: body,
      };

      let statusCode = 200;
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      const cReply: ThenReply = {
        status(code: number) { statusCode = code; return cReply; },
        header(name: string, value: string) { headers[name] = value; return cReply; },
        json(data: unknown) {
          res.writeHead(statusCode, headers);
          res.end(JSON.stringify(data));
          return null;
        },
        send(data: string) {
          res.writeHead(statusCode, headers);
          res.end(data);
          return null;
        },
        redirect(url: string, status?: number) {
          res.writeHead(status || 302, { 'location': url });
          res.end('Redirecting to ' + url);
          return null;
        },
      };

      // Extract route-level hooks if the module exports them
      const routeHooks: RouteHooks | undefined = mod.hooks;

      // Validate request if route exports a schema
      if (mod.schema) {
        const validationError = validateRequest(cReq, mod.schema);
        if (validationError) {
          res.writeHead(validationError.statusCode, { 'content-type': 'application/json' });
          res.end(JSON.stringify(validationError.body));
          return;
        }
      }

      // Execute handler with full hook lifecycle
      const result = await executeWithHooks(hookRegistry, cReq, cReply, async () => {
        return handlerFn(cReq, cReply);
      }, routeHooks);

      // If hooks/handler errored and response wasn't sent, send structured error
      if (result.hadError && !res.writableEnded) {
        const error = new HttpError(result.statusCode, 'HANDLER_ERROR', 'Internal Server Error');
        const { statusCode: errStatus, body: errBody } = formatErrorResponse(error, 'development');
        reportError(error, { method, path: url.pathname, requestId: reqCtx.requestId }, logger);
        res.writeHead(errStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify(errBody));
      }

      if (!result.hadError) {
        await finalizeNodeHandlerResult(result.result, res, { statusCode, headers });
      }
      return;
    }

    // Try server-mode page matching (uses shared compilePageRoutes/matchPageRoute)
    if (method === 'GET' && !/\.\w+$/.test(url.pathname)) {
      const pageMatch = matchPageRoute(compiledPages, url.pathname);
      if (pageMatch) {
        try {
          const mod = await loadHandler(pageMatch.page.filePath);
          const Component = mod.default;
          const pageConfig = mod.page ?? {};

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
              scripts: pageConfig.scripts ?? [],
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
        console.log(`  [then] ${event}: ${prefix}/${filename} — re-scanning routes`);
        const { buildManifest: rescan, compileRoutes: recompile, compilePageRoutes: recompilePages } = await import('@celsian/then-core');
        manifest = await rescan(opts.projectRoot);
        compiledRoutes = recompile(manifest.api);
        compiledPages = recompilePages(
          manifest.pages.filter(p => p.mode === 'server' || p.mode === 'hybrid'),
        );
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
// from @celsian/then-core — no local copies needed. See:
//   builtinRenderToString, wrapDocument, escapeHtml — from static-render.ts
//   compilePageRoutes, matchPageRoute — from match.ts
//   parseNodeBody — from body-parser.ts
