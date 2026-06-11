/**
 * Tests for auth helpers — cookieSession hook factory + @celsian/jwt re-exports (A2.7).
 *
 * cookieSession returns a celsian onRequest hook that:
 *   - sets req.session to a parsed (or fresh) null-prototype object on every request
 *   - auto-commits a signed Set-Cookie when the session is mutated and a reply method fires
 *   - skips Set-Cookie when the session is unchanged
 *
 * jwt + createJWTGuard are re-exported from @celsian/jwt for convenience.
 */

import { describe, it, expect } from 'vitest';
import { createApp } from '@celsian/core';
import { cookieSession, jwt, createJWTGuard } from '../src/auth.js';

// A 32+ char secret satisfying the minimum
const SECRET = 'a-very-long-test-secret-32chars!!';

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Extract the full set-cookie header value from a Response. */
function getCookie(res: Response): string | null {
  return res.headers.get('set-cookie');
}

/** Build a cookie header string from a set-cookie value (strips attributes). */
function cookieHeaderFrom(setCookie: string): string {
  // Take only the name=value part (first segment before ';')
  return setCookie.split(';')[0]!;
}

// ─── Plan acceptance test ──────────────────────────────────────────────────

describe('cookieSession — plan acceptance test (Task 13)', () => {
  it('full round-trip: login → read → tamper', async () => {
    const app = createApp({ logger: false });
    app.addHook('onRequest', cookieSession({ secret: SECRET }));
    app.post('/login', (req: any, reply: any) => {
      req.session.user = 'kirby';
      return reply.json({ ok: true });
    });
    app.get('/me', (req: any, reply: any) => reply.json({ user: req.session.user ?? null }));

    const login = await app.handle(new Request('http://x/login', { method: 'POST' }));
    const cookie = login.headers.get('set-cookie')!;

    expect(cookie).toContain('vura_session=');
    expect(cookie).toContain('HttpOnly');

    const me = await app.handle(new Request('http://x/me', { headers: { cookie } }));
    expect(await me.json()).toEqual({ user: 'kirby' });

    // Tamper: replace the cookie value prefix with garbage, keep the format
    const tampered = cookie.replace(/vura_session=([^;]+)/, 'vura_session=ev1l');
    const bad = await app.handle(new Request('http://x/me', { headers: { cookie: tampered } }));
    expect(await bad.json()).toEqual({ user: null });
  });
});

// ─── Integration tests ─────────────────────────────────────────────────────

describe('cookieSession — integration tests', () => {
  it('unchanged session emits no Set-Cookie', async () => {
    const app = createApp({ logger: false });
    app.addHook('onRequest', cookieSession({ secret: SECRET }));

    // First request: set something
    app.post('/set', (req: any, reply: any) => {
      req.session.x = 1;
      return reply.json({ ok: true });
    });
    // Second request: read only
    app.get('/read', (req: any, reply: any) => {
      void req.session.x; // read-only
      return reply.json({ x: req.session.x });
    });

    const set = await app.handle(new Request('http://x/set', { method: 'POST' }));
    const cookie = set.headers.get('set-cookie')!;
    expect(cookie).toContain('vura_session=');

    const read = await app.handle(new Request('http://x/read', {
      headers: { cookie: cookieHeaderFrom(cookie) },
    }));
    expect(read.headers.get('set-cookie')).toBeNull();
  });

  it('mutation + reply.html → set-cookie present', async () => {
    const app = createApp({ logger: false });
    app.addHook('onRequest', cookieSession({ secret: SECRET }));
    app.get('/html', (req: any, reply: any) => {
      req.session.page = 'home';
      return reply.html('<h1>Hello</h1>');
    });

    const res = await app.handle(new Request('http://x/html'));
    expect(res.headers.get('set-cookie')).toContain('vura_session=');
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('mutation + reply.json → set-cookie present', async () => {
    const app = createApp({ logger: false });
    app.addHook('onRequest', cookieSession({ secret: SECRET }));
    app.post('/action', (req: any, reply: any) => {
      req.session.count = (req.session.count ?? 0) as number + 1;
      return reply.json({ count: req.session.count });
    });

    const res = await app.handle(new Request('http://x/action', { method: 'POST' }));
    expect(res.headers.get('set-cookie')).toContain('vura_session=');
  });

  it('mutation + plain-object return (auto-serialize path) → set-cookie present', async () => {
    const app = createApp({ logger: false });
    app.addHook('onRequest', cookieSession({ secret: SECRET }));
    app.post('/plain', (req: any) => {
      req.session.role = 'user';
      return { ok: true }; // celsian auto-serializes this — spread reply.headers triggers Proxy
    });

    const res = await app.handle(new Request('http://x/plain', { method: 'POST' }));
    expect(res.headers.get('set-cookie')).toContain('vura_session=');
  });

  it('mutation + string return (auto-serialize path) → set-cookie present', async () => {
    const app = createApp({ logger: false });
    app.addHook('onRequest', cookieSession({ secret: SECRET }));
    app.get('/text', (req: any) => {
      req.session.hit = true;
      return 'hello'; // celsian auto-serializes as text/plain — spread reply.headers triggers Proxy
    });

    const res = await app.handle(new Request('http://x/text'));
    expect(res.headers.get('set-cookie')).toContain('vura_session=');
  });

  it('mutation + raw Response return → set-cookie ABSENT (documented limitation)', async () => {
    // Handlers returning `new Response(...)` bypass celsian's reply.headers entirely.
    // Set-Cookie is NOT emitted. This is a known limitation documented in auth.ts.
    const app = createApp({ logger: false });
    app.addHook('onRequest', cookieSession({ secret: SECRET }));
    app.get('/raw', (req: any) => {
      req.session.x = 1;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const res = await app.handle(new Request('http://x/raw'));
    // Documented: raw Response return does not emit Set-Cookie
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('delete key → session rewritten', async () => {
    const app = createApp({ logger: false });
    app.addHook('onRequest', cookieSession({ secret: SECRET }));
    app.post('/set', (req: any, reply: any) => {
      req.session.x = 1;
      return reply.json({ ok: true });
    });
    app.post('/del', (req: any, reply: any) => {
      delete req.session.x;
      return reply.json({ ok: true });
    });

    const set = await app.handle(new Request('http://x/set', { method: 'POST' }));
    const cookie = cookieHeaderFrom(set.headers.get('set-cookie')!);

    const del = await app.handle(new Request('http://x/del', {
      method: 'POST',
      headers: { cookie },
    }));
    expect(del.headers.get('set-cookie')).toContain('vura_session=');
  });

  it('option override — sameSite:strict + custom name appears in cookie', async () => {
    const app = createApp({ logger: false });
    app.addHook('onRequest', cookieSession({
      secret: SECRET,
      cookieName: 'my_sess',
      cookie: { sameSite: 'strict' },
    }));
    app.get('/set', (req: any, reply: any) => {
      req.session.k = 'v';
      return reply.json({ ok: true });
    });

    const res = await app.handle(new Request('http://x/set'));
    const sc = res.headers.get('set-cookie')!;
    expect(sc).toContain('my_sess=');
    expect(sc).toContain('SameSite=Strict');
  });

  it('invalid signature (stripped) → fresh session, no throw', async () => {
    const app = createApp({ logger: false });
    app.addHook('onRequest', cookieSession({ secret: SECRET }));
    app.get('/me', (req: any, reply: any) => reply.json({ user: req.session.user ?? null }));

    // No dot in cookie value — stripped sig
    const res = await app.handle(new Request('http://x/me', {
      headers: { cookie: 'vura_session=eyJrIjoidiJ9' },
    }));
    expect(await res.json()).toEqual({ user: null });
  });

  it('splice attack (payload A + sig B) → fresh session', async () => {
    // Build two different sessions signed with the same key
    const app = createApp({ logger: false });
    app.addHook('onRequest', cookieSession({ secret: SECRET }));
    app.post('/a', (req: any, reply: any) => { req.session.role = 'user'; return reply.json({ ok: true }); });
    app.post('/b', (req: any, reply: any) => { req.session.role = 'admin'; return reply.json({ ok: true }); });
    app.get('/me', (req: any, reply: any) => reply.json({ role: req.session.role ?? null }));

    const [ra, rb] = await Promise.all([
      app.handle(new Request('http://x/a', { method: 'POST' })),
      app.handle(new Request('http://x/b', { method: 'POST' })),
    ]);

    const cookieA = cookieHeaderFrom(ra.headers.get('set-cookie')!).replace('vura_session=', '');
    const cookieB = cookieHeaderFrom(rb.headers.get('set-cookie')!).replace('vura_session=', '');

    // Splice: take payload from A, sig from B
    const dotA = cookieA.lastIndexOf('.');
    const dotB = cookieB.lastIndexOf('.');
    const spliced = `vura_session=${cookieA.slice(0, dotA)}.${cookieB.slice(dotB + 1)}`;

    const spliceRes = await app.handle(new Request('http://x/me', {
      headers: { cookie: spliced },
    }));
    // Spliced cookie fails HMAC verify → fresh session
    expect(await spliceRes.json()).toEqual({ role: null });
  });

  it('short secret throws at factory call', () => {
    expect(() => cookieSession({ secret: 'tooshort' })).toThrow();
  });

  it('Path=/ is present in the emitted cookie', async () => {
    const app = createApp({ logger: false });
    app.addHook('onRequest', cookieSession({ secret: SECRET }));
    app.get('/set', (req: any, reply: any) => {
      req.session.x = 1;
      return reply.json({ ok: true });
    });

    const res = await app.handle(new Request('http://x/set'));
    expect(res.headers.get('set-cookie')).toContain('Path=/');
  });

  it('cookie name uses underscore (vura_session) not dot', async () => {
    const app = createApp({ logger: false });
    app.addHook('onRequest', cookieSession({ secret: SECRET }));
    app.get('/set', (req: any, reply: any) => {
      req.session.x = 1;
      return reply.json({ ok: true });
    });

    const res = await app.handle(new Request('http://x/set'));
    expect(res.headers.get('set-cookie')).toContain('vura_session=');
    expect(res.headers.get('set-cookie')).not.toContain('vura.session=');
  });
});

// ─── Crypto unit tests ─────────────────────────────────────────────────────

describe('cookieSession — crypto / pure unit tests', () => {
  it('round-trip: manual sign + verify', async () => {
    // Exercise the crypto path indirectly via a full app round-trip
    const app = createApp({ logger: false });
    app.addHook('onRequest', cookieSession({ secret: SECRET }));
    app.post('/write', (req: any, reply: any) => {
      req.session.userId = 42;
      return reply.json({ ok: true });
    });
    app.get('/read', (req: any, reply: any) => reply.json({ userId: req.session.userId ?? null }));

    const w = await app.handle(new Request('http://x/write', { method: 'POST' }));
    const cookie = cookieHeaderFrom(w.headers.get('set-cookie')!);
    expect(cookie).toMatch(/^vura_session=.+\..+/); // payload.sig format

    const r = await app.handle(new Request('http://x/read', { headers: { cookie } }));
    expect(await r.json()).toEqual({ userId: 42 });
  });

  it('tampered value → fresh session (HMAC verify fails)', async () => {
    const app = createApp({ logger: false });
    app.addHook('onRequest', cookieSession({ secret: SECRET }));
    app.get('/me', (req: any, reply: any) => reply.json({ user: req.session.user ?? 'none' }));

    // Malformed / tampered cookie
    const res = await app.handle(new Request('http://x/me', {
      headers: { cookie: 'vura_session=tampered.invalidsig' },
    }));
    expect(await res.json()).toEqual({ user: 'none' });
  });
});

// ─── jwt + createJWTGuard re-exports ───────────────────────────────────────

describe('@celsian/jwt re-exports', () => {
  it('jwt is a function (plugin factory)', () => {
    expect(typeof jwt).toBe('function');
  });

  it('createJWTGuard is a function (hook factory)', () => {
    expect(typeof createJWTGuard).toBe('function');
  });
});
