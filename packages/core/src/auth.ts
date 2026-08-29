// @celsian/vura-core — Auth helpers: onRequest hook factory for signed cookie sessions (A2.7)
//
// This module has no Node built-ins, and neither has anything it pulls in;
// that is a requirement rather than an accident. `cookieSession` is on the
// runtime-shim allowlist the Cloudflare and Lambda adapters bundle with
// esbuild's `platform: 'neutral'`, where an import of `node:crypto` — or of
// `@celsian/core`, whose package root is a Node HTTP server — does not resolve
// and takes the whole build down with it. The signing and cookie primitives
// live in ./signed-cookie.ts, which explains at length why they are
// synchronous and where the hash comes from. The short version is that the
// commit seam below is a Proxy trap, and a Proxy trap cannot await Web Crypto.
//
// `jwt` and `createJWTGuard` are re-exported from ./auth-jwt.ts, not from here.
// They come from `@celsian/jwt`, which imports `@celsian/core`, so anything
// importing them inherits that Node dependency; keeping them in a separate
// module is what lets `cookieSession` be bundled for a Worker without them.
//
// Persistence mechanism — dual seam (synchronous HMAC, see ./signed-cookie.ts):
//
//   SEAM 1 — Proxy on reply.headers (covers celsian's auto-serialize plain-object/string paths):
//     app.ts:856-868 builds the response by spreading reply.headers:
//       { "content-type": ..., ...reply.headers }
//     We override reply.headers to return a Proxy of the underlying headers dict.
//     The Proxy's ownKeys/getOwnPropertyDescriptor/get traps inject 'set-cookie' iff
//     session changed vs the onRequest snapshot — computed synchronously via signPayload.
//     Refs: app.ts:856-868 (auto-serialize spread), reply.ts:48-50 (reply.headers getter)
//
//   SEAM 2 — Synchronous method wrapping (covers reply.json / reply.html / reply.send):
//     reply.ts:70-116 spreads the closure-private `headers` variable directly (not reply.headers),
//     so the Proxy above is bypassed. We wrap the three methods to call reply.header('set-cookie')
//     before delegating, writing the cookie into the inner headers dict so it lands in the spread.
//     Refs: reply.ts:70-116 (send/html/json), reply.ts:64-67 (reply.header writes inner dict)
//
//   Covered paths: plain-object return, string return, reply.json, reply.html, reply.send.
//   Documented limitation: handler returning a raw Response object bypasses reply.headers and
//   the wrapping entirely; Set-Cookie is NOT emitted in that case (celsian app.ts:852-853 takes
//   the instanceof Response branch before header merging).

import {
  decodePayload,
  encodePayload,
  parseCookieHeader,
  serializeSessionCookie,
  signPayload,
  verifyPayload,
} from './signed-cookie.js';
// Type-only, so esbuild erases it before it can be resolved. The runtime shape
// is identical to SessionCookieOptions in ./signed-cookie.ts; the alias is kept
// so the published `CookieSessionOpts.cookie` type does not change.
import type { CookieOptions } from '@celsian/core';

// ─── Public types ───────────────────────────────────────────────────────────

export interface CookieSessionOpts {
  /**
   * HMAC-SHA-256 signing secret. Must be ≥ 32 characters.
   * Throws synchronously at factory call if too short.
   */
  secret: string;
  /**
   * Cookie name. Default: 'vura_session'.
   * Sessions are signed (not encrypted) — keep payloads small (< 4 KB).
   * No expiry by default; valid until secret rotation. Pass cookie.maxAge for expiry.
   */
  cookieName?: string;
  /** Cookie attributes merged over { httpOnly: true, sameSite: 'lax', path: '/' }. */
  cookie?: CookieOptions;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_COOKIE_NAME = 'vura_session';
const MIN_SECRET_LEN = 32;
const MAX_COOKIE_BYTES = 4096;
/** Keys stripped on both read (incoming cookie) and write (outgoing session data). */
const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// ─── cookieSession ─────────────────────────────────────────────────────────

/**
 * Returns a celsian onRequest hook that populates `req.session` with a signed,
 * auto-persisted cookie session.
 *
 * @example
 * ```ts
 * app.addHook('onRequest', cookieSession({ secret: process.env.SESSION_SECRET! }));
 *
 * app.post('/login', (req: any, reply) => {
 *   req.session.user = 'kirby';
 *   return reply.json({ ok: true });  // Set-Cookie emitted automatically
 * });
 *
 * // Plain-object return also works:
 * app.get('/status', (req: any) => {
 *   req.session.visited = true;
 *   return { ok: true };  // Set-Cookie emitted automatically
 * });
 * ```
 *
 * The session is committed automatically when the response is built by celsian,
 * covering plain-object returns, string returns, and explicit reply.json/html/send calls.
 * No Set-Cookie is emitted for unchanged sessions.
 *
 * **Limitation**: handlers that return a raw `new Response(...)` object bypass celsian's
 * header-merging path; Set-Cookie is NOT emitted in that case.
 *
 * No expiry by default — valid until secret rotation. Pass `cookie.maxAge` for expiry.
 * Keep session data small (< 4 KB total).
 */
export function cookieSession(opts: CookieSessionOpts): (req: any, reply: any) => void {
  const { secret, cookieName = DEFAULT_COOKIE_NAME } = opts;

  if (secret.length < MIN_SECRET_LEN) {
    throw new Error(
      `[vura cookieSession] secret must be at least ${MIN_SECRET_LEN} characters ` +
      `(got ${secret.length}). Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
    );
  }

  const cookieOpts: CookieOptions = { httpOnly: true, sameSite: 'lax', path: '/', ...opts.cookie };

  return function cookieSessionHook(req: any, reply: any): void {
    // ── Parse incoming session cookie ─────────────────────────────────────
    const cookieHeader: string =
      typeof req.headers?.get === 'function'
        ? (req.headers.get('cookie') ?? '')
        : (req.headers?.cookie ?? '');

    const cookies = parseCookieHeader(cookieHeader);
    const raw: string | undefined = cookies[cookieName];

    let data: Record<string, unknown> = Object.create(null);
    let originalJson = '{}';

    if (raw) {
      const dotIdx = raw.lastIndexOf('.');
      if (dotIdx !== -1) {
        const payload = raw.slice(0, dotIdx);
        const sig = raw.slice(dotIdx + 1);
        const valid = verifyPayload(secret, payload, sig);
        if (valid) {
          try {
            const parsed = JSON.parse(decodePayload(payload));
            // Prototype safety: null-prototype copy, strip poisoning keys on read
            data = Object.create(null);
            for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
              if (!PROTO_KEYS.has(k)) data[k] = v;
            }
            originalJson = JSON.stringify(data);
          } catch {
            data = Object.create(null);
          }
        }
        // Invalid sig → fresh session (tamper/splice resistance)
      }
      // No dot → malformed → fresh session
    }

    (req as any).session = data;

    // ── Synchronous commit helper ─────────────────────────────────────────
    // Computes the serialized Set-Cookie value iff session changed vs snapshot.
    // Strips prototype-poisoning keys before signing (write-side safety).
    function computeSetCookie(): string | undefined {
      const safe: Record<string, unknown> = Object.create(null);
      for (const [k, v] of Object.entries(data)) {
        if (!PROTO_KEYS.has(k)) safe[k] = v;
      }
      const current = JSON.stringify(safe);
      if (current === originalJson) return undefined; // unchanged — no Set-Cookie

      const encodedPayload = encodePayload(current);
      const sig = signPayload(secret, encodedPayload);
      const signed = `${encodedPayload}.${sig}`;
      const serialized = serializeSessionCookie(cookieName, signed, cookieOpts);

      if (serialized.length > MAX_COOKIE_BYTES) {
        console.warn(
          `[vura cookieSession] cookie '${cookieName}' is ${serialized.length} bytes (limit: ${MAX_COOKIE_BYTES}). ` +
          `Keep sessions small.`,
        );
      }

      return serialized;
    }

    // ── SEAM 1: Proxy on reply.headers ────────────────────────────────────
    // Covers the auto-serialize plain-object/string return path (app.ts:856-868)
    // which spreads reply.headers to build the Response. The Proxy injects
    // 'set-cookie' into ownKeys/get only when the session has changed, so
    // unchanged sessions emit no header.
    //
    // Override the reply.headers instance property so it returns the Proxy
    // instead of the inner closure dict (reply.ts:48-50).
    //
    // A reply without a `headers` record gets seam 2 only. Vura's own three
    // generated entries (Cloudflare, Lambda, core's dist/functions/) all expose
    // one and are held to it by their adapter tests — they did not, which is
    // how `new Proxy(undefined, ...)` came to be the first thing this hook did
    // on a Worker, throwing before any handler ran. The guard is for a
    // hand-rolled reply from outside Vura: losing the plain-object commit path
    // is bad, and taking down every request in the app's authorization hook is
    // worse.
    const innerHeaders: Record<string, string> | undefined =
      reply.headers && typeof reply.headers === 'object' ? reply.headers : undefined;

    if (innerHeaders) installHeaderProxy(innerHeaders);

    function installHeaderProxy(headers: Record<string, string>): void {
      const headersProxy = new Proxy(headers, {
        ownKeys(target) {
          const keys = Reflect.ownKeys(target);
          const sc = computeSetCookie();
          if (sc !== undefined && !keys.includes('set-cookie')) {
            keys.push('set-cookie');
          }
          return keys;
        },

        has(target, key) {
          if (key === 'set-cookie') return computeSetCookie() !== undefined;
          return Reflect.has(target, key);
        },

        get(target, key, receiver) {
          if (key === 'set-cookie') return computeSetCookie();
          return Reflect.get(target, key, receiver);
        },

        getOwnPropertyDescriptor(target, key) {
          if (key === 'set-cookie') {
            const sc = computeSetCookie();
            if (sc === undefined) return undefined;
            return { value: sc, enumerable: true, configurable: true, writable: true };
          }
          return Reflect.getOwnPropertyDescriptor(target, key);
        },

        set(target, key, value, receiver) {
          return Reflect.set(target, key, value, receiver);
        },

        deleteProperty(target, key) {
          return Reflect.deleteProperty(target, key);
        },
      });

      Object.defineProperty(reply, 'headers', {
        get() { return headersProxy; },
        configurable: true,
        enumerable: true,
      });
    }

    // ── SEAM 2: Synchronous method wrapping ───────────────────────────────
    // reply.json/html/send spread the closure-private `headers` variable directly
    // (reply.ts:70-116), bypassing reply.headers and the Proxy above. We wrap each
    // method to call reply.header('set-cookie', ...) before delegating, so the
    // cookie value lands in the inner headers dict before the spread fires.
    // Signing is synchronous on every runtime (see ./signed-cookie.ts), so the
    // wrappers are fully sync — no async/await, no change to the return type.
    function commitToReplyHeader(): void {
      const sc = computeSetCookie();
      if (sc !== undefined) reply.header('set-cookie', sc);
    }

    const origJson = reply.json?.bind(reply);
    if (origJson) {
      reply.json = (body: unknown) => { commitToReplyHeader(); return origJson(body); };
    }

    const origHtml = reply.html?.bind(reply);
    if (origHtml) {
      reply.html = (content: string) => { commitToReplyHeader(); return origHtml(content); };
    }

    const origSend = reply.send?.bind(reply);
    if (origSend) {
      reply.send = (body: unknown) => { commitToReplyHeader(); return origSend(body); };
    }
  };
}
