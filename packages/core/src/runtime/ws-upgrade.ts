/**
 * WebSocket upgrade handling for hot routes.
 *
 * Home of the shared upgrade-handler factory (createWsUpgradeHandler) used by
 * the production server (startVuraServer), the Vite dev plugin, and the
 * standalone `vura dev` server — plus the pure Origin-allowlist helper.
 */

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { createWSConnection } from '@celsian/core';
import { createHotPeer } from './hot.js';
import type { ApiRoute } from '../manifest.js';
import type { CompiledRoute } from '../match.js';

/**
 * Decide whether a WebSocket upgrade request's `Origin` header is acceptable
 * for a hot route, based on the route's opt-in `origins` config:
 *
 * ```ts
 * export const route = { kind: 'hot', origins: ['https://app.example.com'] };
 * ```
 *
 * Semantics:
 *
 * - `allowlist === undefined` → **allow** (backward compatible: routes that
 *   never set `origins` keep today's accept-all behavior).
 * - `origin === undefined` with an allowlist set → **allow**. Rationale:
 *   browsers ALWAYS send an `Origin` header on WebSocket handshakes, and
 *   Cross-Site WebSocket Hijacking (CSWSH) — the attack this guard exists
 *   for — is strictly a browser attack riding on ambient cookies. A request
 *   with no `Origin` header is by definition a non-browser client, and a
 *   non-browser client can forge any `Origin` value anyway, so rejecting it
 *   adds no security — it only breaks curl/wscat/server-to-server clients.
 * - Otherwise both sides are normalized via `new URL(x).origin` when
 *   parseable and compared case-insensitively, so allowlist entries may
 *   carry trailing slashes, paths, or default ports
 *   (`'https://app.example.com/'` matches `Origin: https://app.example.com`).
 * - A malformed `Origin` header (unparseable, empty, or the literal opaque
 *   serialization `'null'` sent by sandboxed iframes / `file://` pages)
 *   with an allowlist set → **deny**.
 * - An empty allowlist `[]` → **deny all browser origins** (the user
 *   explicitly set it, so the explicit set wins; no-Origin clients still
 *   pass per the rule above).
 *
 * @param origin    Raw `Origin` header from the upgrade request, if any.
 * @param allowlist The route's `config.origins` value, if any.
 * @returns `true` when the upgrade should proceed, `false` to reject (403).
 */
export function isOriginAllowed(
  origin: string | undefined,
  allowlist: string[] | undefined,
): boolean {
  if (allowlist === undefined) return true; // opt-in feature: unset = open
  if (origin === undefined) return true; // non-browser client — see JSDoc

  const normalizedOrigin = normalizeOrigin(origin);
  if (normalizedOrigin === undefined) return false; // malformed header

  for (const entry of allowlist) {
    // Allowlist entries that don't parse as URLs fall back to a raw
    // lowercase comparison (the author may have written a bare origin form
    // the URL parser rejects); the header side is already validated above.
    const normalizedEntry = normalizeOrigin(entry) ?? entry.toLowerCase();
    if (normalizedEntry === normalizedOrigin) return true;
  }
  return false;
}

/**
 * Normalize a value to its lowercase URL origin, or `undefined` when it
 * cannot be treated as a concrete origin.
 *
 * Non-special schemes (e.g. `chrome-extension://…`) serialize their origin
 * as the literal string `'null'`; we fall back to the raw lowercase value in
 * that case so two unrelated opaque origins never compare equal via
 * `'null' === 'null'`.
 */
function normalizeOrigin(value: string): string | undefined {
  try {
    const o = new URL(value).origin;
    if (o === 'null') return value.toLowerCase();
    return o.toLowerCase();
  } catch {
    return undefined;
  }
}

// One-time (per entry, per process) warning for allowlist entries that don't
// URL-normalize — e.g. a bare `app.example.com` without a scheme. Such entries
// only ever hit the raw-lowercase fallback in isOriginAllowed, and a browser
// Origin header ALWAYS carries a scheme, so they can never match one.
const warnedAllowlistEntries = new Set<string>();
function warnUnnormalizableAllowlistEntries(allowlist: string[]): void {
  for (const entry of allowlist) {
    if (normalizeOrigin(entry) !== undefined || warnedAllowlistEntries.has(entry)) continue;
    warnedAllowlistEntries.add(entry);
    console.warn(
      `[vura] origins entry ${JSON.stringify(entry)} is not a parseable URL — ` +
      'it can never match a browser Origin header. Use a full origin like ' +
      `"https://${entry}".`,
    );
  }
}

// ─── Upgrade handler factory ───

/** The subset of ws.WebSocketServer the upgrade handler needs. */
interface NoServerWss {
  handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    cb: (ws: any) => void,
  ): void;
}

export interface WsUpgradeHandlerOptions {
  /** A `noServer: true` WebSocketServer — build one via createNoServerWebSocketServer(). */
  wss: NoServerWss;
  /**
   * Hot routes with websocket handlers, compiled. Re-evaluated on EVERY
   * upgrade so dev-server manifest rescans take effect without rewiring.
   */
  getWsRoutes(): CompiledRoute[];
  /**
   * Resolve the matched route's module. Prod: identity (module is bundled).
   * Dev: ssrLoadModule / importRouteModule, so edits apply on next connection.
   */
  loadModule(route: ApiRoute): Promise<Record<string, unknown>>;
  /** Latest celsian wsRegistry — a getter because dev rescans rebuild the app. */
  getWsRegistry(): any;
  isShuttingDown?: () => boolean;
  /**
   * What to do when no hot route matches the upgrade pathname:
   * - 'reject' (default): write 404 and destroy — vura owns the whole server.
   * - 'ignore': return without touching the socket — REQUIRED on a shared
   *   server (Vite dev) where another listener (e.g. Vite HMR) may own it.
   */
  onUnmatched?: 'reject' | 'ignore';
  /** Called with the raw ws socket after accept (prod: drain-set tracking). */
  onOpen?(ws: unknown): void;
  /** Called with the raw ws socket on close (prod: drain-set tracking). */
  onClose?(ws: unknown): void;
}

export type WsUpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

/**
 * Build a `noServer` WebSocketServer from a dynamically-imported `ws` module.
 * Centralizes the 1MB maxPayload cap (ws defaults to 100MB, which lets a
 * single client force large allocations on a public websocket server).
 */
export function createNoServerWebSocketServer(wsMod: unknown): NoServerWss {
  const WSS = (wsMod as any).WebSocketServer ?? (wsMod as any).default?.WebSocketServer;
  return new WSS({ noServer: true, maxPayload: 1 << 20 });
}

/**
 * Create an HTTP `'upgrade'` event handler that accepts WebSocket connections
 * for hot routes: route matching (incl. :params), shutdown 503, Origin
 * allowlist 403, registry registration/eviction, and HotPeer wiring.
 *
 * Pre-upgrade rejections are plain HTTP error responses (RFC 6455) written
 * BEFORE any ws handshake bytes; teardown is unconditional (finally-destroy).
 */
export function createWsUpgradeHandler(opts: WsUpgradeHandlerOptions): WsUpgradeHandler {
  const mode = opts.onUnmatched ?? 'reject';

  const reject = (socket: Duplex, statusLine: string): void => {
    try {
      socket.write(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\n\r\n`);
    } catch {
      /* socket already gone */
    } finally {
      // Unconditional teardown — even if write() threw.
      try { socket.destroy(); } catch { /* already destroyed */ }
    }
  };

  return (req, socket, head) => {
    // Tracks whether this upgrade is OURS. In 'ignore' mode an error thrown
    // before a route matches must NOT destroy a socket another listener owns.
    let claimed = mode === 'reject';

    (async () => {
      // Reject upgrades during shutdown so load-balancers get a clean 503
      // instead of an abrupt TCP RST mid-upgrade. In 'ignore' mode this check
      // runs after route matching — unmatched sockets are not ours to refuse.
      if (claimed && opts.isShuttingDown?.()) {
        reject(socket, '503 Service Unavailable');
        return;
      }

      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const pathname = url.pathname;

      // Match against compiled route patterns so :param routes are found.
      let matchedRoute: ApiRoute | undefined;
      const matchedParams: Record<string, string> = {};
      for (const { route, regex, paramNames } of opts.getWsRoutes()) {
        const m = pathname.match(regex);
        if (m) {
          matchedRoute = route;
          for (let i = 0; i < paramNames.length; i++) {
            try { matchedParams[paramNames[i]] = decodeURIComponent(m[i + 1]); }
            catch { matchedParams[paramNames[i]] = m[i + 1]; }
          }
          break;
        }
      }

      if (!matchedRoute) {
        if (mode === 'ignore') return; // leave the socket for the next listener
        reject(socket, '404 Not Found');
        return;
      }
      claimed = true;
      if (mode === 'ignore' && opts.isShuttingDown?.()) {
        reject(socket, '503 Service Unavailable');
        return;
      }

      // Origin allowlist (opt-in per route: `origins: ['https://app.example.com']`).
      const allowedOrigins = Array.isArray(matchedRoute.config?.origins)
        ? (matchedRoute.config.origins as string[])
        : undefined;
      if (allowedOrigins) warnUnnormalizableAllowlistEntries(allowedOrigins);
      if (!isOriginAllowed(req.headers.origin, allowedOrigins)) {
        reject(socket, '403 Forbidden');
        return;
      }

      // Load the module at connection time — in dev this picks up edits.
      const module = await opts.loadModule(matchedRoute);
      const handler = module.websocket;
      if (typeof handler !== 'function') {
        // Route matched but no websocket() export (e.g. removed mid-dev-session).
        reject(socket, '404 Not Found');
        return;
      }

      const wsRegistry = opts.getWsRegistry();
      opts.wss.handleUpgrade(req, socket, head, (ws: any) => {
        const conn = createWSConnection({
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
        opts.onOpen?.(ws);

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
        try {
          const result = (handler as Function)(peer, hotReq);
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
          opts.onClose?.(ws);
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
    })().catch((err: unknown) => {
      // Destroy on any failure including URL parse errors (unhandled
      // rejection otherwise) — but never touch a socket we haven't claimed.
      console.error('[vura] WebSocket upgrade error:', err);
      if (claimed) {
        try { socket.destroy(); } catch { /* ignore */ }
      }
    });
  };
}
