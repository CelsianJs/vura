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
import { createHotPeer } from './hot.js';
import { compileRoutes, type CompiledRoute } from '../match.js';

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
  /**
   * Gracefully close all open WebSocket connections with the given close code
   * and reason, then resolve.
   *
   * Called automatically by `close()` and by the SIGTERM drain path.
   * Exposed on the interface so tests can trigger controlled teardown without
   * killing the process.
   *
   * @param code   WebSocket close code (default: 1001 "going away")
   * @param reason Human-readable close reason string
   */
  closeWebSockets(code?: number, reason?: string): Promise<void>;
  /**
   * Internal: the WSRegistry instance, exposed for testing eviction behaviour.
   * Typed as `any` to avoid coupling the public interface to celsian internals.
   */
  _wsRegistry: any;
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

  // ── WebSocket upgrade wiring ──
  // Collect hot routes that export a websocket handler. Wire the Node.js
  // 'upgrade' event BEFORE listen (Phase 0 lesson: upgrade fires synchronously
  // with the first request on some runtimes, must be registered pre-listen).
  const wsRoutes = opts.apiRoutes.filter(
    (r) => r.kind === 'hot' && r.hasWebsocket && typeof (r.module as any).websocket === 'function',
  );

  // Warn if a route exports websocket() but is not kind:'hot' — those
  // handlers will never fire because upgrade wiring only runs for hot routes.
  for (const r of opts.apiRoutes) {
    if (typeof (r.module as any).websocket === 'function' && r.kind !== 'hot') {
      console.warn(
        `[vura] Route ${r.urlPattern} exports websocket() but kind is "${r.kind}". ` +
        'WebSocket handlers require kind: \'hot\' — the handler will never fire.',
      );
    }
  }

  // Pre-compile ws route patterns so param routes (/api/rooms/:id) match correctly.
  // Compile against ApiRoute shape: RuntimeApiRoute satisfies ApiRoute so the cast is safe.
  const compiledWsRoutes: CompiledRoute[] = compileRoutes(wsRoutes as any);

  // Track all raw ws sockets so closeWebSockets() can drain them.
  // Stored as { rawWs, terminate } so drain can call terminate() on grace timeout.
  type RawWsHandle = { close(code: number, data: string): void; terminate(): void };
  const openRawSockets = new Set<RawWsHandle>();

  // Hoisted so _wsRegistry can be included in the returned VuraServer object
  // regardless of whether ws routes exist (null when no ws routes configured).
  let wsRegistry: any = null;

  if (wsRoutes.length > 0) {
    let wss: any = null;
    let createWSConnectionFn: any = null;

    // Import 'ws' in its own try/catch so only ERR_MODULE_NOT_FOUND triggers the
    // "not installed" warning.  Errors from WSS construction or app.ws() are
    // genuine bugs and must surface, not be swallowed silently.
    let wsMod: any;
    let wsImportError: unknown;
    try {
      wsMod = await import('ws');
    } catch (err) {
      wsImportError = err;
    }

    if (wsImportError !== undefined) {
      // Only emit the user-actionable hint when the module is absent.
      const code = (wsImportError as any)?.code ?? '';
      if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
        console.warn(
          '[vura] WebSocket routes are registered but the "ws" package is not installed. ' +
          'Install it with: pnpm add ws (or npm install ws). ' +
          'The server will still serve HTTP routes normally.',
        );
      } else {
        // Unexpected import error — surface it so it isn't silently lost.
        console.error('[vura] Failed to import "ws":', wsImportError);
      }
    } else {
      // 'ws' is available — set up WSS and upgrade handler.
      const coreMod = await import('@celsian/core');
      const WSS = (wsMod as any).WebSocketServer ?? (wsMod as any).default?.WebSocketServer;
      const { createWSConnection } = coreMod as any;
      createWSConnectionFn = createWSConnection;
      wsRegistry = app.wsRegistry;
      wss = new WSS({ noServer: true });

      // Register each hot ws route via app.ws() so celsian-level connection
      // tracking is aware of the route.  Event wiring goes through HotPeer.
      for (const route of wsRoutes) {
        app.ws(route.urlPattern, {
          // Lifecycle callbacks omitted — handled via HotPeer/raw ws events
        });
      }

      server.on('upgrade', async (req: import('node:http').IncomingMessage, socket: any, head: Buffer) => {
        // Reject upgrades during shutdown so load-balancers get a clean 503
        // instead of an abrupt TCP RST mid-upgrade.
        if (shuttingDown) {
          try {
            socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
            socket.destroy();
          } catch { /* socket already gone */ }
          return;
        }

        try {
          const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
          const pathname = url.pathname;

          // Match against compiled route patterns so :param routes are found.
          let matchedRoute: (typeof wsRoutes)[number] | undefined;
          let matchedParams: Record<string, string> = {};
          for (const { route, regex, paramNames } of compiledWsRoutes) {
            const m = pathname.match(regex);
            if (m) {
              matchedRoute = route as (typeof wsRoutes)[number];
              for (let i = 0; i < paramNames.length; i++) {
                try { matchedParams[paramNames[i]] = decodeURIComponent(m[i + 1]); }
                catch { matchedParams[paramNames[i]] = m[i + 1]; }
              }
              break;
            }
          }

          if (!matchedRoute) {
            // Unmatched upgrade path — destroy cleanly without crashing
            try { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); } catch { /* already closed */ }
            return;
          }

          wss.handleUpgrade(req, socket, head, (ws: any) => {
            const conn = createWSConnectionFn({
              send: (data: string | ArrayBuffer) => {
                try { ws.send(data); } catch { /* no-op on closed socket */ }
              },
              close: (code?: number, reason?: string) => {
                try { ws.close(code ?? 1000, reason ?? ''); } catch { /* ignore */ }
              },
            });

            // Key registry by the concrete pathname so broadcast() is scoped to
            // this specific room (e.g. /api/rooms/7), not the pattern.
            // WSRegistry.addConnection() is a no-op for paths that were never
            // register()ed.  For param routes the pattern (/api/rooms/:id) was
            // registered but not the concrete path (/api/rooms/7), so we must
            // register the concrete path on first use.
            if (!wsRegistry.hasPath(pathname)) {
              wsRegistry.register(pathname, {});
            }
            wsRegistry.addConnection(pathname, conn);
            openRawSockets.add(ws as RawWsHandle);

            // Build the HotPeer — delegates events through raw ws listeners
            const peer = createHotPeer(conn, ws, wsRegistry, pathname);

            // Build a HotRequest: web headers + parsed query + extracted params
            const hotReq = {
              url: url.toString(),
              headers: new Headers(req.headers as Record<string, string>),
              query: url.searchParams,
              params: matchedParams,
            };

            // Call the user's websocket(peer, req) handler
            const handler = (matchedRoute!.module as any).websocket as Function;
            try {
              const result = handler(peer, hotReq);
              if (result && typeof (result as any).catch === 'function') {
                (result as Promise<void>).catch((err: unknown) => {
                  console.error('[vura] websocket handler error:', err);
                });
              }
            } catch (err) {
              console.error('[vura] websocket handler threw synchronously:', err);
            }

            ws.on('close', () => {
              wsRegistry.removeConnection(pathname, conn);
              openRawSockets.delete(ws as RawWsHandle);
              // Evict ephemeral concrete-path entries (e.g. /api/rooms/7) once
              // the last peer leaves.  Startup-registered exact patterns (where
              // pathname === urlPattern) are never evicted so their handlers stay
              // available for future connections.  Without this, hot servers that
              // serve many unique room IDs accumulate one Map entry per room
              // indefinitely — an unbounded memory leak.
              // TODO: upstream an unregister(path) method to @celsian/core WSRegistry.
              if (
                pathname !== matchedRoute!.urlPattern &&
                wsRegistry.getConnectionCount(pathname) === 0
              ) {
                const reg = wsRegistry as unknown as {
                  handlers: Map<string, unknown>;
                  connections: Map<string, unknown>;
                };
                reg.handlers.delete(pathname);
                reg.connections.delete(pathname);
              }
            });

            ws.on('error', (err: Error) => {
              console.error('[vura] WebSocket error:', err.message);
            });
          });
        } catch (err) {
          // Wrap entire upgrade handler body in try/catch — destroy socket on
          // any failure including URL parse errors (unhandled rejection otherwise).
          console.error('[vura] WebSocket upgrade error:', err);
          try { socket.destroy(); } catch { /* ignore */ }
        }
      });
    }
  }

  // ── Listen ──
  await new Promise<void>((resolve) => server.listen(opts.port ?? 3000, resolve));
  const address = server.address() as { port: number };
  const port = address.port;

  // Signal readiness so child-process harnesses can detect startup.
  // Uses process.stdout.write to avoid NODE_ENV='test' log suppression.
  process.stdout.write(`[vura] listening on port ${port}\n`);

  // ── WebSocket drain helper ──
  /**
   * Gracefully close all open WebSocket connections.
   *
   * For each open socket:
   *   1. Send a close frame (code, reason).
   *   2. Wait for the 'close' event — a cooperative client will close fast.
   *   3. If the socket has not closed within `wsGraceMs` (default 3000ms),
   *      call `terminate()` to force-close it and move on.
   *
   * Resolves when ALL sockets have settled (closed or terminated).
   * Idempotent: a second call on an already-empty set resolves immediately.
   */
  const wsGraceMs = 3000;
  let drainPromise: Promise<void> | null = null;
  const closeWebSockets = (code = 1001, reason = 'going away'): Promise<void> => {
    // Idempotent — return the in-progress drain if one is already running.
    if (drainPromise) return drainPromise;
    if (openRawSockets.size === 0) return Promise.resolve();

    drainPromise = (async () => {
      const pending = [...openRawSockets];
      await Promise.all(pending.map((ws) =>
        new Promise<void>((resolve) => {
          // Per-socket grace timer — terminate if the peer doesn't respond.
          const timer = setTimeout(() => {
            try { (ws as any).terminate(); } catch { /* already gone */ }
            resolve();
          }, wsGraceMs);

          // Resolve immediately when the 'close' event fires.
          try {
            (ws as any).once('close', () => {
              clearTimeout(timer);
              resolve();
            });
            ws.close(code, reason);
          } catch {
            // Socket already in a closed state — nothing to wait for.
            clearTimeout(timer);
            resolve();
          }
        }),
      ));
      drainPromise = null;
    })();

    return drainPromise;
  };

  // ── Graceful shutdown helpers ──
  const close = (): Promise<void> =>
    new Promise((resolve) => {
      shuttingDown = true;
      // Drain WebSockets before closing the HTTP server so upgrade traffic
      // receives a clean close frame rather than a TCP RST.
      closeWebSockets(1001, 'shutting down').then(() => {
        server.close(() => resolve());
      });
    });

  const drain = (): void => {
    shuttingDown = true;

    const timeoutMs = opts.shutdownTimeoutMs ?? 30000;
    const force = setTimeout(() => process.exit(1), timeoutMs);
    if (typeof force.unref === 'function') force.unref();

    closeWebSockets(1001, 'going away').then(() => {
      server.close(() => process.exit(0));

      const poll = setInterval(() => {
        if (inFlight <= 0) {
          clearInterval(poll);
          clearTimeout(force);
          process.exit(0);
        }
      }, 100);
      if (typeof poll.unref === 'function') poll.unref();
    });
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

  return { server, port, close, closeWebSockets, _wsRegistry: wsRegistry };
}
