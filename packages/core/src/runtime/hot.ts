/**
 * Vura hot routes — WebSocket peer adapter (A2.5)
 *
 * This module bridges the Celsian WSRegistry/WSConnection primitives into the
 * Vura public contract for `kind: 'hot'` API routes.
 *
 * ## Public contract
 *
 * A `kind: 'hot'` route file may export:
 *
 * ```ts
 * export const route = { kind: 'hot' };
 *
 * // Called once per connection on open.
 * export function websocket(peer: HotPeer, req: HotRequest) {
 *   peer.on('message', (data) => peer.send(`echo:${data}`));
 * }
 * ```
 *
 * The `peer` object:
 * - `id`            — unique connection id (string)
 * - `send(data)`    — send string or ArrayBuffer to this peer; **no-op after close**
 * - `close(code?, reason?)` — close this connection
 * - `on('message' | 'close', cb)` — subscribe to connection events
 * - `broadcast(data, excludeSelf?)` — send to all peers on this concrete path.
 *   By default the sender IS excluded (excludeSelf=true). Pass false to
 *   also deliver to the sender.
 *
 * The `req` object passed to `websocket(peer, req)`:
 * - `url`     — full URL string of the upgrade request
 * - `headers` — Headers object from the upgrade request
 * - `query`   — parsed query-string as URLSearchParams
 * - `params`  — path params extracted from the route pattern (e.g. `{ id: '7' }` for `/api/rooms/:id`)
 *
 * ## Broadcast semantics
 *
 * `broadcast()` is keyed by the **concrete pathname** of the connection
 * (e.g. `/api/rooms/7`), NOT the route pattern (`/api/rooms/:id`). This means
 * broadcast reaches only peers connected to the same concrete URL — the
 * natural "room" semantic. Cross-room broadcast requires iterating peers
 * manually.
 *
 * Cross-instance fan-out (Redis pub/sub) is out of scope — see Celsian
 * ws-redis docs for multi-instance deployments.
 *
 * ## Backpressure limitation
 *
 * `send()` is fire-and-forget. There is no bufferedAmount cap: a slow consumer
 * will buffer unbounded data in the underlying socket write queue. This is a
 * known limitation planned for a future release. If you expect high-throughput
 * binary data, implement your own flow-control in the message handler.
 *
 * ## State
 *
 * State lives in module scope, per-process. There is no cross-instance
 * synchronisation. For multi-instance deployments use an external message bus.
 */

import type { WSConnection, WSRegistry } from '@celsian/core';

/**
 * The request-like object passed as the second argument to
 * `export function websocket(peer, req)`.
 *
 * Mirrors the subset of Web Request that is relevant during a WebSocket
 * upgrade (no body, no method).
 */
export interface HotRequest {
  /** Full URL of the upgrade request (includes query string). */
  readonly url: string;
  /** Headers from the HTTP upgrade request. */
  readonly headers: Headers;
  /** Parsed query string from the upgrade URL. */
  readonly query: URLSearchParams;
  /**
   * Path params extracted from the matched route pattern.
   *
   * For a route `/api/rooms/:id` and an upgrade to `/api/rooms/7`,
   * `params` will be `{ id: '7' }`.
   */
  readonly params: Record<string, string>;
}

/** Event map for a hot peer. */
export interface HotPeerEvents {
  message: (data: string | ArrayBuffer) => void;
  close: (code: number, reason: string) => void;
}

/**
 * The peer object passed to `export function websocket(peer, req)`.
 *
 * Extends WSConnection with an `on()` listener API and a `broadcast()` helper.
 */
export interface HotPeer {
  /** Unique connection identifier. */
  readonly id: string;
  /**
   * Send a message to this peer.
   *
   * **No-op after close** — calling `send()` on a closed or closing connection
   * is silently ignored; no exception is thrown.
   */
  send(data: string | ArrayBuffer): void;
  /** Close this peer connection. */
  close(code?: number, reason?: string): void;
  /**
   * Subscribe to peer events.
   *
   * - `'message'` — fired on every incoming frame. String frames deliver a
   *   `string`; binary frames deliver an `ArrayBuffer`.
   * - `'close'`   — fired when the connection closes, with close code and reason.
   *
   * **Additive**: each call to `on()` appends a new listener to the internal
   * array. Listeners are NOT deduped or replaced by subsequent `on()` calls.
   * Call `on()` once per event type per connection to avoid duplicate handling.
   */
  on(event: 'message', cb: (data: string | ArrayBuffer) => void): void;
  on(event: 'close', cb: (code: number, reason: string) => void): void;
  /**
   * Broadcast data to all connected peers on this route path.
   *
   * @param data        Message to broadcast.
   * @param excludeSelf When `true` (default), the calling peer does NOT receive
   *                    the broadcast. Pass `false` to include the sender too.
   */
  broadcast(data: string | ArrayBuffer, excludeSelf?: boolean): void;
}

/**
 * The websocket export signature for hot route files.
 *
 * @example
 * ```ts
 * export function websocket(peer: HotPeer, req: HotRequest) {
 *   peer.on('message', (data) => peer.send('pong'));
 * }
 * ```
 */
export type HotWebsocketHandler = (peer: HotPeer, req: HotRequest) => void | Promise<void>;

/**
 * Build a `HotPeer` from a Celsian `WSConnection`, wiring event listeners
 * through the raw `ws` socket events and delegating `broadcast()` to the
 * Celsian `WSRegistry`.
 *
 * This adapter is the ONLY place that knows about both the Celsian types and
 * the Vura public API — keep it thin.
 */
export function createHotPeer(
  conn: WSConnection,
  rawWs: {
    on(event: string, cb: (...args: any[]) => void): void;
  },
  registry: WSRegistry,
  /** The concrete pathname of the connection (e.g. `/api/rooms/7`). Registry keyed by this. */
  path: string,
): HotPeer {
  const messageListeners: Array<(data: string | ArrayBuffer) => void> = [];
  const closeListeners: Array<(code: number, reason: string) => void> = [];

  // Wire raw ws events → listener arrays.
  // The `ws` library passes (data, isBinary) to 'message' handlers.
  // `isBinary` is the authoritative signal — never rely on Buffer.isBuffer
  // alone because `ws` always delivers Buffer objects; without isBinary the
  // original code stringified every frame including actual binary payloads.
  rawWs.on('message', (data: Buffer | Buffer[], isBinary: boolean) => {
    let msg: string | ArrayBuffer;
    if (isBinary) {
      // Binary frame: present as ArrayBuffer (copied slice of the Buffer's
      // backing ArrayBuffer, respecting byteOffset for pooled allocations;
      // the copy is intentional — pooled Buffers share memory and a slice
      // could be overwritten before the caller reads it).
      const buf = Array.isArray(data) ? Buffer.concat(data) : data;
      msg = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    } else {
      // Text frame: join fragmented buffers (rare) then decode as UTF-8.
      msg = Array.isArray(data) ? Buffer.concat(data).toString() : (data as Buffer).toString();
    }
    for (const cb of messageListeners) {
      try { cb(msg); } catch { /* handler errors must not crash the server */ }
    }
  });

  rawWs.on('close', (code: number, reason: Buffer) => {
    const reasonStr = Buffer.isBuffer(reason) ? reason.toString() : String(reason ?? '');
    for (const cb of closeListeners) {
      try { cb(code, reasonStr); } catch { /* ignore */ }
    }
  });

  return {
    get id() { return conn.id; },
    send(data) { conn.send(data); },
    close(code, reason) { conn.close(code, reason); },
    on(event: 'message' | 'close', cb: any) {
      if (event === 'message') messageListeners.push(cb);
      else if (event === 'close') closeListeners.push(cb);
    },
    broadcast(data, excludeSelf = true) {
      registry.broadcast(path, data, excludeSelf ? conn.id : undefined);
    },
  };
}
