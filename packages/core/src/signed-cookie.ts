/**
 * The signing and cookie primitives behind `cookieSession`, with no Node
 * built-ins.
 *
 * `auth.ts` used to reach `node:crypto` for `createHmac` and `@celsian/core`
 * for `serializeCookie`. Either one is enough to keep `cookieSession` out of
 * the runtime-shim group the Cloudflare and Lambda adapters bundle, which is
 * why the documented auth story could not be built for either target:
 *
 *   No matching export in "vura-core-runtime-shim:@celsian/vura-core"
 *   for import "cookieSession"
 *
 * `@celsian/core` is the larger of the two problems and the less obvious one.
 * Its package root is a Node HTTP server: bundling it with esbuild's
 * `platform: 'neutral'` fails on `node:fs`, `node:fs/promises`, `node:path` and
 * `node:http` before it ever reaches the cookie helpers, and the package
 * publishes no subpath that would let a caller take only those.
 *
 * ## Why this is synchronous, and why it is not Web Crypto
 *
 * The obvious Web-platform answer is `crypto.subtle.sign`, which workerd does
 * provide. It is also asynchronous, and the commit path in `auth.ts` cannot
 * await: the session cookie is produced inside a `Proxy` on `reply.headers`,
 * whose `get` / `ownKeys` / `getOwnPropertyDescriptor` traps are what put
 * `set-cookie` into the response for a handler that returns a plain object.
 * A trap returns a value, never a promise, so an async signer would silently
 * drop `Set-Cookie` from the documented plain-object return path — the failure
 * would be a session that stops persisting, not a build error.
 *
 * Avoiding that means either changing `cookieSession`'s public shape for every
 * user, Node included, or keeping the signer synchronous everywhere. There is
 * no synchronous hash anywhere in the Web platform, measured rather than
 * assumed: in workerd `crypto.subtle.digest` returns a Promise like the rest of
 * SubtleCrypto.
 *
 * ## Why the hash comes from @noble/hashes
 *
 * A portable synchronous hash does not have to be a hand-written one, and this
 * file briefly was: roughly a hundred lines of FIPS 180-4 arithmetic held to
 * `node:crypto` byte for byte by `test/signed-cookie.test.ts`. It was correct,
 * and correct was never the objection — hand-written cryptography in the
 * authorization path puts the arithmetic in front of every future reader who
 * only needed to check the constraint.
 *
 * `@noble/hashes` drops the arithmetic and keeps the constraint that forced it.
 * `hmac(sha256, key, message)` is synchronous, so the Proxy trap above still
 * works; the package has no runtime dependencies, so nothing arrives behind it;
 * and Cure53 audited it in 2022 at 1.0.0 with SHA-2 and HMAC in scope (blake3,
 * sha3-addons, sha1 and argon2 were not, and are not used here). Measured in
 * the real path rather than an isolated one: built through
 * `cloudflareAdapter().buildEnd()` under `platform: 'neutral'` it leaves no
 * `node:` import in the emitted worker, and that worker runs in workerd at
 * `compatibility_date = "2026-06-01"`.
 *
 * The parity test outlived the arithmetic it was written for, because what it
 * pins was never an implementation detail: a session cookie sitting in a
 * browser right now was signed by `node:crypto` and has no expiry by default,
 * so the first request after any deploy that changes the signer is where a
 * mismatch logs every user out. That is why the implementation could be swapped
 * underneath the test rather than alongside it.
 *
 * ## Why not `nodejs_compat`
 *
 * A Worker can be given Node built-ins, and on a recent enough compatibility
 * date it has them without asking. That was measured too, and it is exactly why
 * it is not the mechanism: at `compatibility_date = "2026-06-01"` workerd has
 * no `Buffer`, no `process` and no `node:crypto`, and Cloudflare's own advice
 * is to pin a compatibility date. Building auth on a runtime default that a
 * pinned date turns off would work in a fresh scaffold and fail in every
 * project older than the cutover, at runtime, in the authorization layer.
 */

import { hmac } from '@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';

// ─── SHA-256 ────────────────────────────────────────────────────────────────

/**
 * SHA-256 of `message`, as 32 bytes.
 *
 * Wrappers rather than re-exports: they hold this module's surface at the shape
 * `auth.ts` and the parity test already import, so which library is underneath
 * stays a fact about this file and not a name anything else has to know.
 */
export function sha256(message: Uint8Array): Uint8Array {
  return nobleSha256(message);
}

/** HMAC-SHA-256 (RFC 2104) of `message` under `key`, as 32 bytes. */
export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  return hmac(nobleSha256, key, message);
}

// ─── base64url and UTF-8 ────────────────────────────────────────────────────

const B64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * Reverse lookup for decoding. `+` and `/` are accepted alongside `-` and `_`
 * so a value written by standard base64 still reads back, which is what
 * `Buffer.from(s, 'base64url')` did.
 */
const B64URL_LOOKUP = (() => {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < B64URL_ALPHABET.length; i++) table[B64URL_ALPHABET.charCodeAt(i)] = i;
  table['+'.charCodeAt(0)] = 62;
  table['/'.charCodeAt(0)] = 63;
  return table;
})();

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

export function encodeUtf8(text: string): Uint8Array {
  return utf8Encoder.encode(text);
}

/** Unpadded base64url, the encoding `Buffer#toString('base64url')` produces. */
export function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64URL_ALPHABET[(n >>> 18) & 63]! + B64URL_ALPHABET[(n >>> 12) & 63]! +
      B64URL_ALPHABET[(n >>> 6) & 63]! + B64URL_ALPHABET[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += B64URL_ALPHABET[(n >>> 18) & 63]! + B64URL_ALPHABET[(n >>> 12) & 63]!;
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += B64URL_ALPHABET[(n >>> 18) & 63]! + B64URL_ALPHABET[(n >>> 12) & 63]! +
      B64URL_ALPHABET[(n >>> 6) & 63]!;
  }
  return out;
}

/**
 * Decode base64url to bytes. Padding is optional and unknown characters are
 * skipped, matching what `Buffer.from(s, 'base64url')` tolerates: a session
 * cookie that survived a proxy's mangling should read back or fail signature
 * verification, not throw out of the request path.
 */
export function fromBase64Url(text: string): Uint8Array {
  const out = new Uint8Array((text.length * 3) >> 2);
  let length = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const value = code < 128 ? B64URL_LOOKUP[code]! : -1;
    if (value < 0) continue;
    acc = (acc << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[length++] = (acc >>> bits) & 0xff;
    }
  }
  return out.subarray(0, length);
}

// ─── The signing surface `auth.ts` uses ─────────────────────────────────────

/** HMAC-SHA-256 of `payload` under `secret`, base64url-encoded. */
export function signPayload(secret: string, payload: string): string {
  return toBase64Url(hmacSha256(encodeUtf8(secret), encodeUtf8(payload)));
}

/**
 * Whether `signature` is the signature of `payload` under `secret`.
 *
 * The comparison runs over the whole expected signature whatever it finds, so
 * the time it takes does not reveal how much of a forged signature was right.
 * A length mismatch answers early, which is what `node:crypto`'s
 * `timingSafeEqual` does too (it refuses unequal lengths outright); the length
 * of a signature is fixed and public, so there is nothing there to leak.
 */
export function verifyPayload(secret: string, payload: string, signature: string): boolean {
  const expected = signPayload(secret, payload);
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}

/** base64url-encode a UTF-8 string. */
export function encodePayload(text: string): string {
  return toBase64Url(encodeUtf8(text));
}

/** Decode a base64url payload back to a UTF-8 string. */
export function decodePayload(text: string): string {
  return utf8Decoder.decode(fromBase64Url(text));
}

// ─── Cookies ────────────────────────────────────────────────────────────────

/** Keys a cookie jar must never carry onto an object. */
const BLOCKED_COOKIE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** RFC 6265 separators, which a cookie name may not contain. */
const NAME_SEPARATORS = new Set([
  '(', ')', '<', '>', '@', ',', ';', ':', '\\', '"', '/', '[', ']', '?', '=', '{', '}', ' ', '\t',
]);

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** Cookie attributes, the subset `cookieSession` accepts. */
export interface SessionCookieOptions {
  domain?: string;
  expires?: Date;
  httpOnly?: boolean;
  maxAge?: number;
  path?: string;
  sameSite?: 'strict' | 'lax' | 'none';
  secure?: boolean;
}

/**
 * Parse a `cookie` header into a null-prototype record.
 *
 * Stands in for `@celsian/core`'s `parseCookies`, and is held to it by
 * `test/signed-cookie.test.ts` rather than to a reading of it.
 */
export function parseCookieHeader(header: string | null | undefined): Record<string, string> {
  const cookies: Record<string, string> = Object.create(null);
  if (!header) return cookies;
  for (const pair of header.split(';')) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (!key || BLOCKED_COOKIE_KEYS.has(key)) continue;
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      // A malformed percent-escape is one bad cookie, not a bad request.
      cookies[key] = value;
    }
  }
  return cookies;
}

/**
 * Serialize a `Set-Cookie` value.
 *
 * Stands in for `@celsian/core`'s `serializeCookie` called with no request
 * context, which is how `cookieSession` has always called it, down to its
 * three defaults. `httpOnly` and `sameSite` are spread over rather than
 * `??`-ed, because that is what the original does and the two differ: an
 * explicit `{ sameSite: undefined }` clears the default instead of keeping it.
 *
 * `secure` defaults to `true` because that is what Celsian's context-free
 * default resolves to. It is worth knowing about rather than worth changing
 * here: a session cookie served over plain HTTP is accepted by the browser and
 * then never sent back, so a dev server on `http://localhost` needs
 * `cookie: { secure: false }` to hold a session at all. That was true before
 * this module existed, and the parity test pins it so a change has to be
 * deliberate rather than a side effect of rewriting the serialiser.
 */
export function serializeSessionCookie(
  name: string,
  value: string,
  options: SessionCookieOptions = {},
): string {
  if (!name || hasControlChar(name) || [...name].some(ch => NAME_SEPARATORS.has(ch))) {
    throw new Error(`Invalid cookie name: ${JSON.stringify(name)} (contains illegal characters)`);
  }
  for (const [label, attr] of [['domain', options.domain], ['path', options.path]] as const) {
    if (attr && (hasControlChar(attr) || attr.includes(';'))) {
      throw new Error(`Invalid cookie ${label}: ${JSON.stringify(attr)} (contains illegal characters)`);
    }
  }

  const opts: SessionCookieOptions = {
    httpOnly: true,
    sameSite: 'lax',
    ...options,
    secure: options.secure ?? true,
  };

  let cookie = `${name}=${encodeURIComponent(value)}`;
  if (opts.domain) cookie += `; Domain=${opts.domain}`;
  if (opts.expires) cookie += `; Expires=${opts.expires.toUTCString()}`;
  if (opts.httpOnly) cookie += '; HttpOnly';
  if (opts.maxAge !== undefined) cookie += `; Max-Age=${opts.maxAge}`;
  if (opts.path) cookie += `; Path=${opts.path}`;
  if (opts.sameSite) {
    cookie += `; SameSite=${opts.sameSite.charAt(0).toUpperCase()}${opts.sameSite.slice(1)}`;
  }
  if (opts.secure) cookie += '; Secure';
  return cookie;
}
