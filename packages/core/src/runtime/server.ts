/**
 * Vura runtime — startVuraServer composing celsian API + what-fw pages + ISR.
 *
 * Replaces the inline-codegen server in build.ts: instead of emitting a
 * self-contained JS string, the generated entry imports this module and
 * calls startVuraServer() with the route/page metadata.
 *
 * Signal-handler note:
 *   SIGTERM/SIGINT handlers call process.exit() — in vitest all tests share
 *   one process, so accumulating signal handlers across multiple
 *   startVuraServer() calls would corrupt the process.  Guard: handlers are
 *   only installed when `installSignalHandlers` is true (default: true in
 *   production, false when NODE_ENV === 'test').  Tests that need graceful-
 *   shutdown validation should fork a child process (as server-entry-runtime
 *   tests do) rather than relying on in-process signal delivery.
 */

import { createServer as createHttpServer, type Server } from 'node:http';
import { createReadStream, realpathSync, statSync } from 'node:fs';
import { extname, normalize, resolve, sep } from 'node:path';
import { nodeToWebRequest, writeWebResponse } from '@celsian/core';
import { createApiApp, type RuntimeApiRoute, type GlobalHooks } from './api-app.js';
import { buildWhatRoutes, createPagesHandler, type RuntimePage } from './pages.js';
import { createVuraCache, type VuraCacheConfig } from './cache.js';

// ─── MIME types (ported from STATIC_FILE_CODE in build.ts) ───

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.xml': 'application/xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.wasm': 'application/wasm',
};

function getMimeType(filePath: string): string {
  return MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Resolve a static file within `baseDir`, guarded against symlink path
 * traversal (same algorithm as STATIC_FILE_CODE in build.ts).
 *
 * Returns the real resolved path when a file exists and is within bounds,
 * or null otherwise.
 */
function tryResolveStaticFile(
  baseDir: string,
  realBaseDir: string,
  pathname: string,
  allowIndexFallback: boolean,
): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch (_) {
    return null;
  }

  const candidates: string[] = [normalize(resolve(baseDir, '.' + decoded))];
  if (allowIndexFallback) {
    if (decoded.endsWith('/')) {
      candidates.push(normalize(resolve(baseDir, '.' + decoded, 'index.html')));
    } else if (extname(decoded) === '') {
      candidates.push(normalize(resolve(baseDir, '.' + decoded, 'index.html')));
    }
  }

  for (const filePath of candidates) {
    try {
      const realFilePath = realpathSync(filePath);
      // Symlink traversal guard: realpath must be under the real base dir
      if (!realFilePath.startsWith(realBaseDir + sep) && realFilePath !== realBaseDir) continue;
      if (statSync(realFilePath).isFile()) return realFilePath;
    } catch (_) {
      // file not found or lstat error — try next candidate
    }
  }
  return null;
}

function sendStaticFile(
  realFilePath: string,
  method: string,
  res: import('node:http').ServerResponse,
  cacheControl: string,
): boolean {
  try {
    const st = statSync(realFilePath);
    if (!st.isFile()) return false;
    const ct = getMimeType(realFilePath);
    res.writeHead(200, {
      'content-type': ct,
      'content-length': st.size.toString(),
      'cache-control': cacheControl,
    });
    if (method === 'HEAD') {
      res.end();
      return true;
    }
    const stream = createReadStream(realFilePath);
    stream.pipe(res);
    stream.on('error', () => { if (!res.writableEnded) res.end(); });
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Attempt to serve a static file from one of `staticDirs`.
 *
 * Dirs are tried in order: first match wins.  The first dir (globalIndex 0,
 * i.e. public/) uses immutable caching; subsequent dirs use must-revalidate
 * (dist/static SSG output).
 *
 * `globalIndexOffset` lets callers pass a subset of dirs (e.g. slice(1)) while
 * preserving the correct cache-control and allowIndexFallback semantics for
 * each dir's position in the original full array.
 *
 * Returns true if a file was found and the response was started; false if the
 * caller should continue to page/API routing.
 */
export async function serveStaticIfFound(
  staticDirs: string[],
  pathname: string,
  method: string,
  res: import('node:http').ServerResponse,
  globalIndexOffset = 0,
): Promise<boolean> {
  if (method !== 'GET' && method !== 'HEAD') return false;

  for (let i = 0; i < staticDirs.length; i++) {
    const dir = staticDirs[i]!;
    // Resolve real base once; eat errors if dir doesn't exist
    let realDir = dir;
    try { realDir = realpathSync(dir); } catch (_) { continue; }

    const globalI = i + globalIndexOffset;
    // First dir overall (globalI === 0) = public/ → immutable (long-lived user assets)
    // Others = dist/static → must-revalidate (SSG output, may redeploy)
    const cacheControl = globalI === 0
      ? 'public, max-age=31536000, immutable'
      : 'public, max-age=0, must-revalidate';

    // Allow index.html fallback only for dirs beyond public/ (SSG-style dirs)
    const realFile = tryResolveStaticFile(dir, realDir, pathname, globalI > 0);
    if (realFile && sendStaticFile(realFile, method, res, cacheControl)) return true;
  }

  return false;
}

// ─── Public API ───

export interface VuraServerOptions {
  port?: number;
  apiRoutes: RuntimeApiRoute[];
  pages: RuntimePage[];
  cache?: VuraCacheConfig;
  globalHooks?: GlobalHooks;
  /**
   * Directories to serve static assets from (tried in order).
   * Typically: [path/to/public, path/to/dist/static]
   * If omitted, no static files are served.
   */
  staticDirs?: string[];
  /**
   * Graceful-shutdown drain timeout (ms).  Default: 30 000.
   */
  shutdownTimeoutMs?: number;
  /**
   * Whether to install SIGTERM/SIGINT handlers that call process.exit().
   *
   * Default: true when NODE_ENV !== 'test', false otherwise.
   * Set to false in tests to avoid signal-handler accumulation across
   * multiple startVuraServer() calls in a single vitest process.
   */
  installSignalHandlers?: boolean;
}

export interface VuraServer {
  /** Underlying Node.js HTTP server (for advanced use: attach WebSocket etc.) */
  server: Server;
  /** Port the server is actually listening on (useful when port: 0 is passed). */
  port: number;
  /** Stop accepting new connections and close the server. Resolves when done. */
  close(): Promise<void>;
}

/**
 * Start the Vura production server.
 *
 * Composes a Celsian-backed API app, a what-fw pages handler, and an ISR
 * cache engine, all listening on one HTTP port.
 *
 * @example
 * ```ts
 * import { startVuraServer } from '@celsian/vura-core';
 * await startVuraServer({
 *   port: 3000,
 *   apiRoutes: [...],
 *   pages: [...],
 *   cache: { store: 'memory' },
 * });
 * ```
 */
export async function startVuraServer(opts: VuraServerOptions): Promise<VuraServer> {
  // ── ISR cache + revalidation webhook ──
  const { engine, webhook } = createVuraCache(opts.cache ?? {});

  // ── Celsian API app ──
  const app = createApiApp({
    routes: opts.apiRoutes,
    globalHooks: opts.globalHooks,
    revalidateWebhook: webhook,
  });

  // ── what-fw pages handler (server + hybrid modes only) ──
  const serverPages = opts.pages.filter(
    (p) => p.mode === 'server' || p.mode === 'hybrid',
  );
  const pagesHandler = createPagesHandler({
    routes: buildWhatRoutes(serverPages),
    cache: engine,
  });

  // ── In-flight tracking for graceful shutdown ──
  let inFlight = 0;
  let shuttingDown = false;

  // ── HTTP server ──
  const server = createHttpServer(async (nodeReq, nodeRes) => {
    if (shuttingDown) {
      nodeRes.writeHead(503, {
        'content-type': 'application/json',
        connection: 'close',
      });
      nodeRes.end(JSON.stringify({ error: 'Service shutting down' }));
      return;
    }

    inFlight++;
    // Register 'close' before any async work so the decrement cannot be
    // skipped if an early throw unwinds the stack before the handler exits.
    nodeRes.on('close', () => { inFlight--; });

    try {
      const url = new URL(
        nodeReq.url ?? '/',
        `http://${nodeReq.headers.host ?? 'localhost'}`,
      );

      // ── Health check ──
      if (url.pathname === '/__health') {
        nodeRes.writeHead(200, { 'content-type': 'application/json' });
        nodeRes.end(JSON.stringify({ ok: true, framework: 'Vura' }));
        return;
      }

      // Request-dispatch ordering:
      //   1. public/ (first staticDir) — long-lived user assets, served before API
      //      so static files are never shadowed by API route matching.
      //   2. API routes (/api/*) + ISR webhook (/__vura/*).
      //   3. Remaining staticDirs (dist/static SSG output) — after API so
      //      framework-generated assets don't shadow application handlers.
      //   4. SSR pages (what-fw pagesHandler).

      // ── Static files: public/ only (first dir, globalIndex 0) ──
      if (opts.staticDirs && opts.staticDirs.length > 0) {
        if (await serveStaticIfFound([opts.staticDirs[0]!], url.pathname, nodeReq.method ?? 'GET', nodeRes, 0)) {
          return;
        }
      }

      // ── Convert to Web Request ──
      const webReq = nodeToWebRequest(nodeReq, url);

      // ── API + ISR webhook routes ──
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/__vura/')) {
        await writeWebResponse(nodeRes, await app.handle(webReq));
        return;
      }

      // ── Static files: dist/static and beyond (remaining dirs, globalIndex 1+) ──
      if (opts.staticDirs && opts.staticDirs.length > 1) {
        if (await serveStaticIfFound(opts.staticDirs.slice(1), url.pathname, nodeReq.method ?? 'GET', nodeRes, 1)) {
          return;
        }
      }

      // ── SSR pages ──
      await writeWebResponse(nodeRes, await pagesHandler(webReq));
    } catch (err) {
      console.error('[vura] unhandled request error:', err);
      if (!nodeRes.writableEnded) {
        try {
          nodeRes.writeHead(500, { 'content-type': 'application/json' });
          nodeRes.end(JSON.stringify({ error: 'Internal Server Error' }));
        } catch { /* headers already sent mid-stream — destroy */ nodeRes.destroy(); }
      }
    }
  });

  // ── Listen ──
  await new Promise<void>((resolve) => server.listen(opts.port ?? 3000, resolve));
  const address = server.address() as { port: number };
  const port = address.port;

  // Signal readiness so child-process harnesses can detect startup.
  // Uses process.stdout.write to avoid NODE_ENV='test' log suppression.
  process.stdout.write(`[vura] listening on port ${port}\n`);

  // ── Graceful shutdown helpers ──
  const close = (): Promise<void> =>
    new Promise((resolve) => {
      shuttingDown = true;
      server.close(() => resolve());
    });

  const drain = (): void => {
    shuttingDown = true;
    server.close(() => process.exit(0));

    const timeoutMs = opts.shutdownTimeoutMs ?? 30000;
    const force = setTimeout(() => process.exit(1), timeoutMs);
    // Allow the process to exit if nothing else is keeping the loop alive
    if (typeof force.unref === 'function') force.unref();

    const poll = setInterval(() => {
      if (inFlight <= 0) {
        clearInterval(poll);
        clearTimeout(force);
        process.exit(0);
      }
    }, 100);
    if (typeof poll.unref === 'function') poll.unref();
  };

  // Install OS signal handlers only outside vitest (default) or when caller
  // explicitly requests them.  Prevents accumulation across multiple
  // startVuraServer() calls in one vitest worker process.
  const shouldInstall = opts.installSignalHandlers ??
    (process.env.NODE_ENV !== 'test');
  if (shouldInstall) {
    process.once('SIGTERM', drain);
    process.once('SIGINT', drain);
  }

  return { server, port, close };
}
