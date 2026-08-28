/**
 * The signing and cookie primitives behind `cookieSession`, with no Node
 * built-ins and no dependencies.
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
 * SubtleCrypto. So the signer is implemented here, in about a hundred lines of
 * arithmetic that runs identically on Node, workerd, Lambda and a browser.
 *
 * ## Why writing SHA-256 by hand is defensible here
 *
 * It normally is not. It is defensible for this one function because the
 * output is fully specified and cheap to check against the implementation it
 * replaces: `test/signed-cookie.test.ts` compares this HMAC byte for byte with
 * `node:crypto`'s `createHmac` over the FIPS 180-4 and RFC 4231 vectors and
 * over randomised inputs, and compares `serializeSessionCookie` and
 * `parseCookieHeader` against the `@celsian/core` functions they stand in for.
 * Those tests are the reason there is one implementation here rather than a
 * fast Node path and a portable adapter path that would drift apart.
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

// ─── SHA-256 ────────────────────────────────────────────────────────────────

/** FIPS 180-4 §4.2.2 round constants. */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** FIPS 180-4 §5.3.3 initial hash value. */
const H0 = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const SHA256_BLOCK_BYTES = 64;
const SHA256_DIGEST_BYTES = 32;

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

/** SHA-256 of `message`, as 32 bytes. */
export function sha256(message: Uint8Array): Uint8Array {
  // Padding: 0x80, then zeroes, then the message length in bits as a 64-bit
  // big-endian integer. `+ 9` is that one byte plus the eight length bytes;
  // rounding up to a whole block is the rest of FIPS 180-4 §5.1.1.
  const totalBytes = Math.ceil((message.length + 9) / SHA256_BLOCK_BYTES) * SHA256_BLOCK_BYTES;
  const buf = new Uint8Array(totalBytes);
  buf.set(message);
  buf[message.length] = 0x80;

  const view = new DataView(buf.buffer);
  // `length * 8` stays an exact double well past any cookie, so the high word
  // is a division rather than a shift: `>>>` would have truncated to 32 bits
  // and hashed long inputs wrongly.
  view.setUint32(totalBytes - 8, Math.floor(message.length / 0x20000000), false);
  view.setUint32(totalBytes - 4, (message.length * 8) >>> 0, false);

  const H = new Uint32Array(H0);
  const W = new Uint32Array(64);

  for (let offset = 0; offset < totalBytes; offset += SHA256_BLOCK_BYTES) {
    for (let t = 0; t < 16; t++) W[t] = view.getUint32(offset + t * 4, false);
    for (let t = 16; t < 64; t++) {
      const w15 = W[t - 15]!;
      const w2 = W[t - 2]!;
      const s0 = (rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3)) >>> 0;
      const s1 = (rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10)) >>> 0;
      W[t] = (W[t - 16]! + s0 + W[t - 7]! + s1) >>> 0;
    }

    let a = H[0]!, b = H[1]!, c = H[2]!, d = H[3]!;
    let e = H[4]!, f = H[5]!, g = H[6]!, h = H[7]!;

    for (let t = 0; t < 64; t++) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const t1 = (h + S1 + ch + K[t]! + W[t]!) >>> 0;
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }

    H[0] = (H[0]! + a) >>> 0; H[1] = (H[1]! + b) >>> 0;
    H[2] = (H[2]! + c) >>> 0; H[3] = (H[3]! + d) >>> 0;
    H[4] = (H[4]! + e) >>> 0; H[5] = (H[5]! + f) >>> 0;
    H[6] = (H[6]! + g) >>> 0; H[7] = (H[7]! + h) >>> 0;
  }

  const digest = new Uint8Array(SHA256_DIGEST_BYTES);
  const out = new DataView(digest.buffer);
  for (let i = 0; i < 8; i++) out.setUint32(i * 4, H[i]!, false);
  return digest;
}

/** HMAC-SHA-256 (RFC 2104) of `message` under `key`, as 32 bytes. */
export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  const block = new Uint8Array(SHA256_BLOCK_BYTES);
  block.set(key.length > SHA256_BLOCK_BYTES ? sha256(key) : key);

  const inner = new Uint8Array(SHA256_BLOCK_BYTES + message.length);
  const outer = new Uint8Array(SHA256_BLOCK_BYTES + SHA256_DIGEST_BYTES);
  for (let i = 0; i < SHA256_BLOCK_BYTES; i++) {
    inner[i] = block[i]! ^ 0x36;
    outer[i] = block[i]! ^ 0x5c;
  }
  inner.set(message, SHA256_BLOCK_BYTES);
  outer.set(sha256(inner), SHA256_BLOCK_BYTES);
  return sha256(outer);
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
