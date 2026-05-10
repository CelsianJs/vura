/**
 * `then dev` — Start the local development server.
 *
 * Uses Vite under the hood with @then/vite-plugin for:
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

import { buildManifest, matchRoute, compileRoutes, getLogger } from '@then/core';
import type { PageRoute, ThenRequest, ThenReply, CompiledRoute } from '@then/core';

interface DevOptions {
  port: number;
  projectRoot: string;
}

export async function devCommand(args: string[]): Promise<void> {
  const portArg = args.find((_, i) => args[i - 1] === '--port');
  const opts: DevOptions = {
    port: portArg ? parseInt(portArg, 10) : 3000,
    projectRoot: process.cwd(),
  };

  console.log('\n  then dev\n');

  // Scan routes for initial info
  const manifest = await buildManifest(opts.projectRoot);
  console.log(`  Found ${manifest.api.length} API routes, ${manifest.pages.length} pages`);

  // Try to use Vite with our plugin
  try {
    const vite = await import('vite');
    // @ts-ignore — resolved at runtime via workspace link
    const pluginMod = await import('@then/vite-plugin');
    const thenPlugin = pluginMod.thenPlugin ?? pluginMod.default;

    const server = await vite.createServer({
      root: opts.projectRoot,
      server: {
        port: opts.port,
        host: true,
      },
      plugins: [
        thenPlugin({ root: opts.projectRoot }),
      ],
    });

    await server.listen();
    server.printUrls();
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
  let jsxImportSource = '@then/core';
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

    // Health check
    if (url.pathname === '/__health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, framework: 'ThenJS', mode: 'dev' }));
      return;
    }

    // Task management endpoints
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
          input: body?.input,
          attempt: 1,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'completed', result }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // Route info
    if (url.pathname === '/' && manifest.pages.length === 0) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        framework: 'ThenJS',
        mode: 'dev',
        routes: manifest.api.map(r => r.methods.map(m => `${m} ${r.urlPattern}`)).flat(),
      }));
      return;
    }

    // Try API route matching (uses pre-compiled regexes)
    const match = matchRoute(compiledRoutes, method, url.pathname);
    if (match) {
      try {
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
        };

        await handlerFn(cReq, cReply);
      } catch (err: any) {
        log.error(`handler error in ${method} ${url.pathname}`, { error: err.message });
        if (!res.writableEnded) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal Server Error', message: err.message }));
        }
      }
      return;
    }

    // Try server-mode page matching (uses pre-compiled regexes)
    if (method === 'GET' && !/\.\w+$/.test(url.pathname)) {
      const pageMatch = matchDevPageRoute(compiledPages, url.pathname);
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

            const vnode = Component({ ...serverData, params: pageMatch.params });
            const bodyHtml = devRenderToString(vnode);
            const html = devWrapDocument(bodyHtml, {
              title: pageConfig.title ?? 'ThenJS App',
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
          log.error(`page render error ${url.pathname}`, { error: err.message });
          if (!res.writableEnded) {
            res.writeHead(500, { 'Content-Type': 'text/html' });
            res.end(`<h1>500 — Server Error</h1><pre>${devEscapeHtml(err.message)}</pre>`);
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
        const { buildManifest: rescan, compileRoutes: recompile } = await import('@then/core');
        manifest = await rescan(opts.projectRoot);
        compiledRoutes = recompile(manifest.api);
        compiledPages = compilePageRoutes(
          manifest.pages.filter(p => p.mode === 'server' || p.mode === 'hybrid'),
        );
      });
      process.on('SIGINT', () => { watcher.close(); process.exit(0); });
    } catch {
      // Watch may fail if directory doesn't exist yet
    }
  }

  server.listen(opts.port, () => {
    console.log(`  Server listening on http://localhost:${opts.port}\n`);
    printRouteTable(manifest);
  });

  // Keep process alive
  await new Promise(() => {});
}

// ─── Dev-mode Helpers ───

interface CompiledPageRoute {
  page: PageRoute;
  regex: RegExp;
  paramNames: string[];
}

function compilePageRoutes(pages: PageRoute[]): CompiledPageRoute[] {
  return pages.map(page => {
    const paramNames: string[] = [];
    let regexStr = '';
    let i = 0;
    const pattern = page.urlPattern;
    while (i < pattern.length) {
      if (pattern[i] === ':' && i > 0 && pattern[i - 1] === '/') {
        let name = ''; i++;
        while (i < pattern.length && /[a-zA-Z0-9_]/.test(pattern[i])) { name += pattern[i]; i++; }
        paramNames.push(name); regexStr += '([^/]+)';
      } else if (pattern[i] === '*') {
        paramNames.push('*'); regexStr += '(.*)'; i++;
      } else {
        const ch = pattern[i];
        if ('.+?^${}()|[]\\'.includes(ch)) regexStr += '\\' + ch;
        else regexStr += ch;
        i++;
      }
    }
    return { page, regex: new RegExp(`^${regexStr}$`), paramNames };
  });
}

function matchDevPageRoute(
  compiled: CompiledPageRoute[],
  pathname: string,
): { page: PageRoute; params: Record<string, string> } | null {
  for (const { page, regex, paramNames } of compiled) {
    const match = pathname.match(regex);
    if (match) {
      const params: Record<string, string> = {};
      paramNames.forEach((name, idx) => { try { params[name] = decodeURIComponent(match[idx + 1]); } catch { params[name] = match[idx + 1]; } });
      return { page, params };
    }
  }
  return null;
}

function devRenderToString(vnode: any): string {
  if (vnode == null || typeof vnode === 'boolean') return '';
  if (typeof vnode === 'string') return devEscapeHtml(vnode);
  if (typeof vnode === 'number') return String(vnode);
  if (typeof vnode === 'function' && !vnode.type && !vnode.tag) return devRenderToString(vnode());
  if (Array.isArray(vnode)) return vnode.map(devRenderToString).join('');
  // Support both What Framework vnodes ({ tag }) and standard ({ type })
  const type = vnode.type ?? vnode.tag;
  const { props = {}, children } = vnode;
  if (typeof type === 'function') return devRenderToString(type({ ...props, children }));
  if (typeof type === 'string') {
    const attrs = devRenderAttrs(props);
    const VOID = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
    if (VOID.has(type)) return `<${type}${attrs}>`;
    let childHtml = '';
    if (props.dangerouslySetInnerHTML) childHtml = props.dangerouslySetInnerHTML.__html ?? '';
    else if (children != null) {
      childHtml = Array.isArray(children) ? children.map(devRenderToString).join('') : devRenderToString(children);
    }
    return `<${type}${attrs}>${childHtml}</${type}>`;
  }
  if ((!type || typeof type === 'symbol') && children) {
    return Array.isArray(children) ? children.map(devRenderToString).join('') : devRenderToString(children);
  }
  return '';
}

function devRenderAttrs(props: Record<string, any>): string {
  let result = '';
  for (const [key, value] of Object.entries(props)) {
    if (key === 'children' || key === 'dangerouslySetInnerHTML') continue;
    if (key.startsWith('on') && key.length > 2) continue;
    if (value == null || value === false) continue;
    const attrName = key === 'className' ? 'class' : key === 'htmlFor' ? 'for' : key;
    if (value === true) result += ` ${attrName}`;
    else if (key === 'style' && typeof value === 'object') {
      const css = Object.entries(value).map(([p, v]) => `${p.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`)}: ${v}`).join('; ');
      result += ` style="${devEscapeHtml(css)}"`;
    } else result += ` ${attrName}="${devEscapeHtml(String(value))}"`;
  }
  return result;
}

function devEscapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function devWrapDocument(bodyHtml: string, opts: { title: string; meta: any[]; styles: string[]; scripts: string[]; head: string }): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${devEscapeHtml(opts.title)}</title>
    ${opts.head}
</head>
<body>
    <div id="app">${bodyHtml}</div>
</body>
</html>`;
}

const DEV_MAX_BODY_SIZE = 1024 * 1024; // 1MB

function parseNodeBody(req: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const method = (req.method ?? 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD') return resolve(null);

    // Pre-check Content-Length before starting to buffer
    const contentLength = req.headers['content-length'];
    if (contentLength != null) {
      const declared = parseInt(contentLength, 10);
      if (!isNaN(declared) && declared > DEV_MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error('Content-Length exceeds limit'));
        return;
      }
    }

    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > DEV_MAX_BODY_SIZE) { req.destroy(); reject(new Error('Body too large')); return; }
      chunks.push(chunk);
    });
    req.on('error', () => resolve(null));
    req.on('end', () => {
      const data = Buffer.concat(chunks).toString();
      if (!data) return resolve(null);
      const ct = req.headers['content-type'] ?? '';
      if (ct.includes('application/json')) {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      } else { resolve(data); }
    });
  });
}
