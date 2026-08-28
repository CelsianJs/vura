/**
 * The contract that keeps `signed-cookie.ts` honest.
 *
 * That module exists so `cookieSession` can be bundled for Cloudflare and
 * Lambda, and it gets there by reimplementing three things that used to come
 * from elsewhere: HMAC-SHA-256 (was `node:crypto`), cookie serialisation and
 * cookie parsing (were `@celsian/core`). Reimplementing a signature scheme is
 * the kind of change that passes its own tests and still silently rejects every
 * session cookie a deployed app already issued, so the tests below do not check
 * the new code against a description of the old code. They run the old code.
 *
 * `node:crypto` and `@celsian/core` are imported here and only here, in a test
 * that never runs in a Worker, and every assertion is an equality against what
 * they produce. If the two implementations ever diverge, this file is what
 * says so — which is the difference between one implementation with a
 * reference and two implementations that drift.
 *
 * The cross-version case has its own describe block at the end, because it is
 * the one that matters on the day of the upgrade: a cookie signed by the
 * `node:crypto` build must still verify under this one, or every logged-in user
 * of an upgraded app is logged out.
 */

import { describe, it, expect } from 'vitest';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { extname } from 'node:path';
import { parseCookies, serializeCookie } from '@celsian/core';
import type { CookieOptions } from '@celsian/core';

import {
  decodePayload,
  encodePayload,
  fromBase64Url,
  hmacSha256,
  parseCookieHeader,
  serializeSessionCookie,
  sha256,
  signPayload,
  toBase64Url,
  verifyPayload,
} from '../src/signed-cookie.js';
import { getMimeType } from '../src/streaming-headers.js';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

/**
 * Lengths chosen around SHA-256's 64-byte block and its 56-byte padding
 * threshold, which is where a hand-written implementation goes wrong: at 55
 * bytes the length field still fits the first block, at 56 it does not and a
 * second block appears.
 */
const BOUNDARY_LENGTHS = [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000, 100_000];

describe('sha256, against node:crypto', () => {
  it('matches on every length around the block and padding boundaries', () => {
    for (const length of BOUNDARY_LENGTHS) {
      const message = randomBytes(length);
      expect(hex(sha256(message)), `length ${length}`).toBe(
        createHash('sha256').update(message).digest('hex'),
      );
    }
  });

  it('matches the FIPS 180-4 example digests', () => {
    // Published vectors, not node's answers: a shared bug in both would pass
    // the comparison above and fail here.
    expect(hex(sha256(new TextEncoder().encode('abc')))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(hex(sha256(new Uint8Array(0)))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});

describe('hmacSha256, against node:crypto', () => {
  it('matches across key lengths that straddle the 64-byte block', () => {
    // A key longer than the block is hashed first; a shorter one is zero-padded.
    // Getting that branch backwards produces a signer that is self-consistent
    // and wrong, which only a comparison catches.
    for (const keyLength of [0, 1, 32, 63, 64, 65, 100, 200]) {
      for (const messageLength of [0, 1, 64, 65, 500]) {
        const key = randomBytes(keyLength);
        const message = randomBytes(messageLength);
        expect(hex(hmacSha256(key, message)), `key ${keyLength} message ${messageLength}`).toBe(
          createHmac('sha256', key).update(message).digest('hex'),
        );
      }
    }
  });

  it('matches the RFC 4231 test vectors', () => {
    expect(hex(hmacSha256(new Uint8Array(20).fill(0x0b), new TextEncoder().encode('Hi There')))).toBe(
      'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
    );
    expect(
      hex(hmacSha256(
        new TextEncoder().encode('Jefe'),
        new TextEncoder().encode('what do ya want for nothing?'),
      )),
    ).toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
  });
});

describe('base64url, against Buffer', () => {
  it('encodes and decodes byte strings identically', () => {
    for (let length = 0; length < 40; length++) {
      const bytes = randomBytes(length);
      expect(toBase64Url(bytes), `length ${length}`).toBe(bytes.toString('base64url'));
      expect(hex(fromBase64Url(bytes.toString('base64url')))).toBe(bytes.toString('hex'));
    }
  });

  it('round-trips UTF-8 payloads including astral characters', () => {
    // The session payload is JSON, and JSON carries whatever the user put in a
    // session value. A byte-oriented encoder that assumed one char per byte
    // would pass every ASCII test above and corrupt this one.
    for (const text of ['', 'hello', '{"a":1}', '☃ ünïcode 😀', 'x'.repeat(9000)]) {
      expect(encodePayload(text)).toBe(Buffer.from(text, 'utf-8').toString('base64url'));
      expect(decodePayload(encodePayload(text))).toBe(text);
    }
  });

  it('tolerates the padding and standard alphabet Buffer accepts', () => {
    // A cookie makes a round trip through a browser and possibly a proxy. The
    // decoder Buffer replaced accepted `+`, `/` and `=`, so this one does too.
    expect(decodePayload('aGVsbG8=')).toBe('hello');
    expect(hex(fromBase64Url('+/=='))).toBe(hex(fromBase64Url('-_')));
  });
});

describe('signPayload and verifyPayload', () => {
  it('produce the base64url digest node:crypto produces', () => {
    for (const secret of ['a'.repeat(32), 'k'.repeat(80), 'sécret-ünïcode-secret-secret-1234']) {
      for (const payload of ['', 'hello', JSON.stringify({ user: 'kirby', snow: '☃' }), 'x'.repeat(5000)]) {
        expect(signPayload(secret, payload)).toBe(
          createHmac('sha256', secret).update(payload).digest('base64url'),
        );
      }
    }
  });

  it('accepts its own signature and rejects every neighbour of it', () => {
    const secret = 'a-very-long-test-secret-32chars!!';
    const payload = encodePayload(JSON.stringify({ user: 'kirby' }));
    const signature = signPayload(secret, payload);

    expect(verifyPayload(secret, payload, signature)).toBe(true);
    expect(verifyPayload(secret, payload, signature.slice(0, -1))).toBe(false);
    expect(verifyPayload(secret, payload, `${signature}x`)).toBe(false);
    expect(verifyPayload(secret, payload, '')).toBe(false);
    expect(verifyPayload(secret, `${payload}x`, signature)).toBe(false);
    expect(verifyPayload(`${secret}x`, payload, signature)).toBe(false);
    // One flipped character, same length: the case a length check alone passes.
    const flipped = signature.slice(0, -1) + (signature.endsWith('A') ? 'B' : 'A');
    expect(verifyPayload(secret, payload, flipped)).toBe(false);
  });
});

describe('serializeSessionCookie, against @celsian/core', () => {
  /**
   * `cookieSession` calls the Celsian serialiser with no request context, and
   * that call shape is the whole contract: it is what makes `secure` default to
   * true. The matrix below is every attribute `CookieSessionOpts.cookie`
   * exposes, because a dropped attribute is a silently weaker cookie.
   */
  const OPTION_MATRIX: CookieOptions[] = [
    {},
    { httpOnly: true, sameSite: 'lax', path: '/' },
    { httpOnly: true, sameSite: 'strict', path: '/admin' },
    { httpOnly: true, sameSite: 'none', path: '/', secure: true },
    { httpOnly: true, sameSite: 'lax', path: '/', secure: false },
    { httpOnly: false, path: '/', maxAge: 3600 },
    { path: '/', maxAge: 0 },
    { domain: 'example.com', path: '/', expires: new Date('2030-01-02T03:04:05Z') },
    { domain: 'sub.example.com', httpOnly: true, maxAge: 86400, path: '/a', sameSite: 'strict', secure: true },
  ];

  it('emits the same header for every documented option combination', () => {
    for (const options of OPTION_MATRIX) {
      expect(
        serializeSessionCookie('vura_session', 'payload.signature', options),
        JSON.stringify(options),
      ).toBe(serializeCookie('vura_session', 'payload.signature', options));
    }
  });

  it('escapes cookie values the same way', () => {
    for (const value of ['a b/c=d', 'plain', '☃', 'a;b', 'a"b', '%%%', 'a\\b']) {
      expect(serializeSessionCookie('s', value, { path: '/' })).toBe(
        serializeCookie('s', value, { path: '/' }),
      );
    }
  });

  it('defaults Secure on, which is what the Celsian call with no context does', () => {
    // Pinned explicitly rather than left to the matrix, because it is a
    // surprising default with a visible consequence: a session cookie served
    // over plain http:// is accepted by the browser and never sent back, so a
    // dev server needs `cookie: { secure: false }`. Changing it should be a
    // decision, not a diff nobody noticed.
    expect(serializeSessionCookie('s', 'v', {})).toContain('; Secure');
    expect(serializeSessionCookie('s', 'v', { secure: false })).not.toContain('Secure');
  });

  it('refuses names and attributes that would inject a header', () => {
    expect(() => serializeSessionCookie('bad name', 'v')).toThrow(/Invalid cookie name/);
    expect(() => serializeSessionCookie('a=b', 'v')).toThrow(/Invalid cookie name/);
    expect(() => serializeSessionCookie('a\nb', 'v')).toThrow(/Invalid cookie name/);
    expect(() => serializeSessionCookie('s', 'v', { path: '/a;Secure' })).toThrow(/Invalid cookie path/);
    expect(() => serializeSessionCookie('s', 'v', { domain: 'a\r\nb' })).toThrow(/Invalid cookie domain/);
  });
});

describe('parseCookieHeader, against @celsian/core', () => {
  const HEADERS = [
    '',
    'a=1',
    'a=1; b=2',
    '  a = 1 ;  b = 2  ',
    'a=1; a=2',
    'novalue',
    'a=',
    '=novalue',
    'a=%20%2F%3D',
    'a=%ZZ',
    'vura_session=eyJhIjoxfQ.sig; other=x',
    '__proto__=polluted; a=1',
    'constructor=x; prototype=y; b=2',
    'a=1;;b=2',
  ];

  it('produces the same jar for every header shape', () => {
    for (const header of HEADERS) {
      expect({ ...parseCookieHeader(header) }, JSON.stringify(header)).toEqual({
        ...parseCookies(header),
      });
    }
  });

  it('returns a null-prototype object that prototype keys cannot reach', () => {
    const jar = parseCookieHeader('__proto__=polluted; a=1');
    expect(Object.getPrototypeOf(jar)).toBe(null);
    expect(jar['__proto__']).toBeUndefined();
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(jar['a']).toBe('1');
  });

  it('treats a null or missing header as an empty jar', () => {
    expect({ ...parseCookieHeader(null) }).toEqual({});
    expect({ ...parseCookieHeader(undefined) }).toEqual({});
  });
});

describe('getMimeType extension parsing, against node:path', () => {
  /**
   * `getMimeType` stopped importing `node:path` so that it could be bundled for
   * a Worker. `extname` is small enough to inline and full of edge cases, so it
   * is held to the real one across the shapes that distinguish them.
   */
  const PATHS = [
    'file.txt', 'file.TXT', 'a/b/c.png', '/abs/path/to/x.json', 'noext', '/a/noext',
    '.bashrc', '/etc/.bashrc', 'a.', 'a..', '.a.b', '/a.b/c', '/a.b/c.d',
    'archive.tar.gz', '', '.', '..', 'dir/', 'C:\\win\\file.pdf', 'C:\\a.b\\c',
  ];

  it('classifies every path the way node:path would', () => {
    for (const path of PATHS) {
      // Windows separators are the one deliberate difference: node:path's posix
      // extname does not treat `\` as a separator and this one does, so those
      // two paths are compared against the basename node would have taken.
      const reference = path.includes('\\') ? extname(path.split('\\').pop()!) : extname(path);
      const expected = mimeFor(reference.toLowerCase());
      expect(getMimeType(path), path).toBe(expected);
    }
  });

  function mimeFor(ext: string): string {
    const table: Record<string, string> = {
      '.txt': 'text/plain', '.png': 'image/png', '.json': 'application/json',
      '.gz': 'application/gzip', '.pdf': 'application/pdf', '.b': 'application/octet-stream',
    };
    return table[ext] ?? 'application/octet-stream';
  }
});

describe('upgrade compatibility with the node:crypto implementation', () => {
  /**
   * The pre-change signer, verbatim: `createHmac(...).digest('base64url')` and
   * `Buffer.from(payload, 'base64url')`. A session cookie in a browser right
   * now was made by these two lines, and it has no expiry by default, so the
   * first request after a deploy is where a mismatch would show up.
   */
  const legacySign = (secret: string, payload: string) =>
    createHmac('sha256', secret).update(payload).digest('base64url');
  const legacyEncode = (json: string) => Buffer.from(json, 'utf-8').toString('base64url');
  const legacyDecode = (payload: string) => Buffer.from(payload, 'base64url').toString('utf-8');

  const secret = 'a-very-long-test-secret-32chars!!';

  it('verifies a cookie the node:crypto build issued', () => {
    for (const session of [{}, { user: 'kirby' }, { deep: { a: [1, 2, '☃'] } }]) {
      const json = JSON.stringify(session);
      const payload = legacyEncode(json);
      const signature = legacySign(secret, payload);
      expect(verifyPayload(secret, payload, signature)).toBe(true);
      expect(JSON.parse(decodePayload(payload))).toEqual(session);
    }
  });

  it('issues a cookie the node:crypto build would have verified', () => {
    for (const session of [{}, { user: 'kirby' }, { deep: { a: [1, 2, '☃'] } }]) {
      const json = JSON.stringify(session);
      const payload = encodePayload(json);
      expect(signPayload(secret, payload)).toBe(legacySign(secret, payload));
      expect(JSON.parse(legacyDecode(payload))).toEqual(session);
    }
  });
});
