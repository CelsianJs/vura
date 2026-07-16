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
import { createWsUpgradeHandler, createNoServerWebSocketServer } from './ws-upgrade.js';
import { compileRoutes, type CompiledRoute } from '../match.js';
import {
  runTaskOnce,
  buildTaskEnvelope,
  createTaskResultStore,
  isTaskAdminAuthorized,
  registerTaskCrons,
  readOptionalJsonBody,
  type TaskRunDefinition,
  type TaskAdminJob,
} from './tasks.js';
import type { LocalChildDispatch, StepRecord } from './steps.js';
import { validateTaskInput } from '../validation.js';

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

export function shouldStartInProcessTaskCron(registeredTasks: Array<{ schedule?: string }>, env: { VURA_DISABLE_IN_PROCESS_CRON?: string } = process.env): boolean {
  return !/^(1|true|yes)$/i.test((env.VURA_DISABLE_IN_PROCESS_CRON ?? '').trim()) && registeredTasks.some((task) => task.schedule);
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

export interface VuraServerOptions {
  port?: number;
  /** Host/interface to bind; production defaults to 0.0.0.0. */
  host?: string;
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

function resolveListenHost(host?: string): string | undefined {
  return host || process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : undefined);
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

  // ── Task cron + admin store ──
  const taskRoutes = opts.apiRoutes.filter((r) => r.kind === 'task');
  const taskStore = createTaskResultStore();

  // Derive task name from urlPattern: strip /api/ prefix, replace / with .
  function taskNameFromPattern(urlPattern: string): string {
    return urlPattern.replace(/^\/api\//, '').replace(/\//g, '.');
  }

  // Off-platform child dispatcher for `step.waitForTask` (Phase 2). Runs the
  // named child task in-process and returns its terminal result. Only consulted
  // when no durable platform is present (local `node dist/server`); on a real
  // deployment the platform enqueues+links children and the run suspends.
  const localChildDispatch: LocalChildDispatch = async (childName, payload) => {
    const childRoute = taskRoutes.find((r) => taskNameFromPattern(r.urlPattern) === childName);
    if (!childRoute) return { ok: false, error: `Task not found: ${childName}` };
    const childHandler = (childRoute.module as { POST?: TaskRunDefinition['handler'] }).POST;
    if (typeof childHandler !== 'function') return { ok: false, error: 'Task must export POST handler' };
    const childRes = await runTaskOnce(
      {
        name: childName,
        config: {
          retries: typeof childRoute.config.retries === 'number' ? childRoute.config.retries : 0,
          timeout: typeof childRoute.config.timeout === 'number' ? childRoute.config.timeout : 30000,
        },
        handler: childHandler,
      },
      { input: payload, hasPlatform: false, localChildDispatch },
    );
    return childRes.status === 'completed'
      ? { ok: true, result: childRes.result }
      : { ok: false, error: childRes.error };
  };

  // Register cron jobs and collect registered task defs for admin list
  const registeredTasks = taskRoutes.length > 0
    ? registerTaskCrons(app, taskRoutes, taskStore, taskNameFromPattern)
    : [];

  if (shouldStartInProcessTaskCron(registeredTasks)) {
    app.startCron();
  }

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

      // ── Task admin endpoints ──
      if (url.pathname === '/__tasks' || url.pathname.startsWith('/__tasks/')) {
        const remoteAddr = nodeReq.socket?.remoteAddress ?? '';
        const normalised = remoteAddr.startsWith('::ffff:') ? remoteAddr.slice(7) : remoteAddr;
        const webHeaders = new Headers(nodeReq.headers as Record<string, string>);
        if (!isTaskAdminAuthorized(webHeaders, normalised)) {
          nodeRes.writeHead(403, { 'content-type': 'application/json' });
          nodeRes.end(JSON.stringify({ error: 'Forbidden' }));
          return;
        }

        const method = (nodeReq.method ?? 'GET').toUpperCase();

        // GET /__tasks → list registered tasks
        if (url.pathname === '/__tasks' && method === 'GET') {
          nodeRes.writeHead(200, { 'content-type': 'application/json' });
          nodeRes.end(JSON.stringify({ tasks: registeredTasks }));
          return;
        }

        // POST /__tasks/:name → trigger task immediately
        if (url.pathname.startsWith('/__tasks/') && method === 'POST') {
          const taskName = url.pathname.slice('/__tasks/'.length);
          const taskRoute = taskRoutes.find(
            (r) => taskNameFromPattern(r.urlPattern) === taskName,
          );
          if (!taskRoute) {
            nodeRes.writeHead(404, { 'content-type': 'application/json' });
            nodeRes.end(JSON.stringify({ error: `Task not found: ${taskName}` }));
            return;
          }

          const handler = (taskRoute.module as any).POST as ((ctx: { attempt: number; input: unknown }) => Promise<unknown>) | undefined;
          if (typeof handler !== 'function') {
            nodeRes.writeHead(400, { 'content-type': 'application/json' });
            nodeRes.end(JSON.stringify({ error: 'Task must export POST handler' }));
            return;
          }

          // Fix #11: read optional JSON body from the POST request (size-capped 64 KB)
          const bodyResult = await readOptionalJsonBody(nodeReq);
          if (!bodyResult.ok) {
            nodeRes.writeHead(bodyResult.status, { 'content-type': 'application/json' });
            nodeRes.end(JSON.stringify({ error: bodyResult.message }));
            return;
          }

          // ── Platform dispatch header protocol ──
          // The Vura control-plane (cron scheduler + manual-run API) POSTs a
          // WRAPPER body `{ taskId, input, attempt }` and sets headers:
          //   X-Vura-Task-Id: <id>  → platform dispatch; the real payload is
          //                           `body.input`, not the body itself.
          //   X-Vura-Cron: true     → synthetic input (scheduled runs, and
          //                           today's platform manual runs); SKIP input
          //                           validation, exactly like in-process cron.
          // A raw local/manual trigger (no headers) posts the payload AS the
          // body and is validated as-is. The upcoming enqueue() path sends
          // X-Vura-Task-Id with a real user payload at `.input` and IS validated.
          const isPlatformDispatch = (webHeaders.get('x-vura-task-id') ?? '') !== '';
          const isPlatformCron = (webHeaders.get('x-vura-cron') ?? '').toLowerCase() === 'true';
          const wrapper = isPlatformDispatch && bodyResult.value && typeof bodyResult.value === 'object'
            ? (bodyResult.value as { input?: unknown; runId?: unknown; steps?: unknown })
            : undefined;
          const rawPayload = isPlatformDispatch ? wrapper?.input : bodyResult.value;
          // ── Dispatch body v2 (Phase 2) ──
          // The platform wrapper additionally carries `runId` + `steps` for
          // durable replay. Both are tolerated-absent (missing steps = {}).
          const runId = typeof wrapper?.runId === 'string' ? wrapper.runId : undefined;
          const dispatchSteps: Record<string, StepRecord> =
            wrapper?.steps && typeof wrapper.steps === 'object'
              ? (wrapper.steps as Record<string, StepRecord>)
              : {};

          // Phase 1: validate the payload against the task's optional `input`
          // schema before accepting the run — unless this is a cron/synthetic
          // dispatch. A failure short-circuits with 400 (no job, no attempts).
          const inputSchema = (taskRoute.module as Record<string, unknown>).input;
          let runInput: unknown = rawPayload;
          if (!isPlatformCron) {
            const validation = validateTaskInput(rawPayload, inputSchema);
            if (!validation.ok) {
              nodeRes.writeHead(validation.status, { 'content-type': 'application/json' });
              nodeRes.end(JSON.stringify(validation.body));
              return;
            }
            runInput = validation.value;
          }

          const def: TaskRunDefinition = {
            name: taskName,
            config: {
              retries: typeof taskRoute.config.retries === 'number' ? taskRoute.config.retries : 0,
              timeout: typeof taskRoute.config.timeout === 'number' ? taskRoute.config.timeout : 30000,
            },
            handler,
          };
          const runOptions = {
            input: runInput,
            runId,
            steps: dispatchSteps,
            hasPlatform: isPlatformDispatch ? true : undefined,
            localChildDispatch,
          };

          // Function runtimes cannot expose the dedicated runtime's in-memory
          // polling store across invocations. When explicitly enabled, execute
          // the same task runner inline and return the same terminal envelope as
          // the generated serverless task entry. Dedicated runtimes keep the
          // established 202 + job-id contract unless this exact flag is set.
          if (process.env.VURA_TASK_SYNC === '1') {
            const runResult = await runTaskOnce(def, runOptions);
            const envelope = buildTaskEnvelope(taskName, runResult);
            nodeRes.writeHead(envelope.ok ? 200 : 500, { 'content-type': 'application/json' });
            nodeRes.end(JSON.stringify(envelope));
            return;
          }

          const jobId = taskStore.nextId();
          const job: TaskAdminJob = { id: jobId, taskName, status: 'running', startedAt: Date.now() };
          taskStore.add(job);

          // Kick off in background; return jobId immediately. Input was validated
          // above (or exempted for cron), so the run uses the resolved value.
          // Phase 2: thread the dispatch runId + persisted steps for durable
          // replay; a platform dispatch implies a durable platform (suspend on
          // waits), otherwise fall back to env detection + local child dispatch.
          runTaskOnce(def, runOptions).then((runResult) => {
            job.status = runResult.status;
            job.result = runResult.result;
            job.error = runResult.error;
            job.ok = runResult.status !== 'failed';
            job.attempts = runResult.attemptRecords;
            job.suspended = runResult.suspended;
            job.steps = runResult.steps;
            job.completedAt = Date.now();
          }).catch((_err) => {
            job.status = 'failed';
            job.error = 'unexpected error';
            job.ok = false;
            job.completedAt = Date.now();
          });

          nodeRes.writeHead(202, { 'content-type': 'application/json' });
          nodeRes.end(JSON.stringify({ id: jobId, status: 'running' }));
          return;
        }

        // GET /__tasks/:id → job status
        if (url.pathname.startsWith('/__tasks/') && method === 'GET') {
          const jobId = url.pathname.slice('/__tasks/'.length);
          const job = taskStore.results.get(jobId);
          if (!job) {
            nodeRes.writeHead(404, { 'content-type': 'application/json' });
            nodeRes.end(JSON.stringify({ error: `Job not found: ${jobId}` }));
            return;
          }
          nodeRes.writeHead(200, { 'content-type': 'application/json' });
          nodeRes.end(JSON.stringify(job));
          return;
        }

        nodeRes.writeHead(404, { 'content-type': 'application/json' });
        nodeRes.end(JSON.stringify({ error: 'Not found' }));
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
      wsRegistry = app.wsRegistry;
      const wss = createNoServerWebSocketServer(wsMod);

      // Register each hot ws route via app.ws() so celsian-level connection
      // tracking is aware of the route.  Event wiring goes through HotPeer.
      for (const route of wsRoutes) {
        app.ws(route.urlPattern, {
          // Lifecycle callbacks omitted — handled via HotPeer/raw ws events
        });
      }

      // Per-upgrade work (match, 503/403/404 rejections, HotPeer wiring,
      // registry registration/eviction) lives in the shared factory — the
      // same handler the dev servers (vite-plugin, standalone) consume.
      server.on('upgrade', createWsUpgradeHandler({
        wss,
        getWsRoutes: () => compiledWsRoutes,
        // Prod modules are bundled into the route table — identity load.
        loadModule: async (route) => (route as RuntimeApiRoute).module,
        getWsRegistry: () => wsRegistry,
        isShuttingDown: () => shuttingDown,
        onUnmatched: 'reject',
        // Drain-set tracking so closeWebSockets() can drain open sockets.
        onOpen: (ws) => { openRawSockets.add(ws as RawWsHandle); },
        onClose: (ws) => { openRawSockets.delete(ws as RawWsHandle); },
      }));
    }
  }

  // ── Listen ──
  const listenHost = resolveListenHost(opts.host);
  await new Promise<void>((resolve) => {
    if (listenHost) server.listen(opts.port ?? 3000, listenHost, resolve);
    else server.listen(opts.port ?? 3000, resolve);
  });
  const port = (server.address() as { port: number }).port;

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
      // Stop cron before draining so no new task invocations are scheduled.
      app.stopCron();
      // Drain WebSockets before closing the HTTP server so upgrade traffic
      // receives a clean close frame rather than a TCP RST.
      closeWebSockets(1001, 'shutting down').then(() => {
        server.close(() => resolve());
      });
    });

  const drain = (): void => {
    shuttingDown = true;
    app.stopCron();

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
