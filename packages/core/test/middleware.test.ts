import { describe, it, expect } from 'vitest';
import {
  createMiddlewareRunner,
  compileMatcher,
  parseCookies,
  type MiddlewareContext,
} from '../src/runtime/middleware.js';

const req = (url: string, init?: RequestInit) => new Request(url, init);

describe('compileMatcher', () => {
  const matches = (pattern: string, path: string) => compileMatcher(pattern).regex.test(path);

  it('matches an exact path', () => {
    expect(matches('/admin', '/admin')).toBe(true);
    expect(matches('/admin', '/admin/')).toBe(true);
    expect(matches('/admin', '/admins')).toBe(false);
    expect(matches('/admin', '/admin/users')).toBe(false);
  });

  it('matches a named segment and captures it', () => {
    const m = compileMatcher('/team/:id');
    expect(m.names).toEqual(['id']);
    expect(m.regex.exec('/team/42')?.[1]).toBe('42');
    // One segment, not two.
    expect(m.regex.test('/team/42/settings')).toBe(false);
  });

  it('matches a named catch-all, including the bare prefix', () => {
    const m = compileMatcher('/dashboard/:path*');
    expect(m.regex.exec('/dashboard/a/b')?.[1]).toBe('a/b');
    expect(m.regex.test('/dashboard')).toBe(true);
    expect(m.regex.test('/dashboards')).toBe(false);
  });

  it('matches an anonymous catch-all', () => {
    expect(matches('/assets/*', '/assets/app.css')).toBe(true);
    expect(matches('/assets/*', '/assets')).toBe(true);
    expect(matches('/assets/*', '/other/app.css')).toBe(false);
  });

  it('escapes regex metacharacters in literal segments', () => {
    // A literal dot must not match any character.
    expect(matches('/v1.0/docs', '/v1.0/docs')).toBe(true);
    expect(matches('/v1.0/docs', '/v1x0/docs')).toBe(false);
  });
});

describe('parseCookies', () => {
  it('parses a cookie header', () => {
    const c = parseCookies('session=abc; theme=dark');
    expect(c.get('session')).toBe('abc');
    expect(c.has('theme')).toBe(true);
    expect(c.get('missing')).toBeUndefined();
  });

  it('decodes percent-escapes and survives a malformed one', () => {
    expect(parseCookies('name=a%20b').get('name')).toBe('a b');
    // A bad escape keeps the raw value rather than throwing away every cookie.
    expect(parseCookies('bad=%E0%A4%A; ok=1').get('ok')).toBe('1');
  });

  it('treats no header as no cookies', () => {
    expect(parseCookies(null).get('anything')).toBeUndefined();
  });
});

describe('createMiddlewareRunner', () => {
  it('is disabled when the module has no handler', async () => {
    const runner = createMiddlewareRunner({});
    expect(runner.enabled).toBe(false);
    expect(await runner.run(req('https://x.test/'))).toEqual({});
  });

  it('accepts either a default or a named `middleware` export', () => {
    expect(createMiddlewareRunner({ default: () => {} }).enabled).toBe(true);
    expect(createMiddlewareRunner({ middleware: () => {} }).enabled).toBe(true);
  });

  it('short-circuits the request when it returns a Response', async () => {
    const runner = createMiddlewareRunner({
      default: (ctx: MiddlewareContext) => ctx.redirect('/login'),
    });
    const { response } = await runner.run(req('https://x.test/dashboard'));
    expect(response?.status).toBe(307);
    expect(response?.headers.get('location')).toBe('/login');
  });

  it('continues the request when it returns nothing', async () => {
    const runner = createMiddlewareRunner({ default: () => undefined });
    expect(await runner.run(req('https://x.test/'))).toEqual({});
  });

  it('collects headers set on the context without short-circuiting', async () => {
    const runner = createMiddlewareRunner({
      default: (ctx: MiddlewareContext) => { ctx.headers.set('x-req', '1'); },
    });
    const { response, headers } = await runner.run(req('https://x.test/'));
    expect(response).toBeUndefined();
    expect(headers?.get('x-req')).toBe('1');
  });

  it('carries collected headers onto a short-circuit response too', async () => {
    const runner = createMiddlewareRunner({
      default: (ctx: MiddlewareContext) => {
        ctx.headers.set('x-req', '1');
        return ctx.deny(401, 'nope');
      },
    });
    const { response } = await runner.run(req('https://x.test/'));
    expect(response?.status).toBe(401);
    expect(response?.headers.get('x-req')).toBe('1');
    expect(await response!.text()).toBe('nope');
  });

  it('gives the handler cookies, query and params', async () => {
    let seen: { session?: string; q?: unknown; id?: string } = {};
    const runner = createMiddlewareRunner({
      config: { matcher: '/team/:id' },
      default: (ctx: MiddlewareContext) => {
        seen = { session: ctx.cookies.get('session'), q: ctx.query.tab, id: ctx.params.id };
      },
    });
    await runner.run(req('https://x.test/team/42?tab=members', {
      headers: { cookie: 'session=abc' },
    }));
    expect(seen).toEqual({ session: 'abc', q: 'members', id: '42' });
  });

  it('runs for every path when there is no matcher', async () => {
    const seen: string[] = [];
    const runner = createMiddlewareRunner({
      default: (ctx: MiddlewareContext) => { seen.push(ctx.pathname); },
    });
    await runner.run(req('https://x.test/'));
    await runner.run(req('https://x.test/deep/path'));
    expect(seen).toEqual(['/', '/deep/path']);
  });

  it('skips paths the matcher does not cover', async () => {
    const seen: string[] = [];
    const runner = createMiddlewareRunner({
      config: { matcher: ['/admin', '/dashboard/:path*'] },
      default: (ctx: MiddlewareContext) => { seen.push(ctx.pathname); },
    });
    await runner.run(req('https://x.test/admin'));
    await runner.run(req('https://x.test/dashboard/billing'));
    await runner.run(req('https://x.test/about'));
    expect(seen).toEqual(['/admin', '/dashboard/billing']);
  });

  it('never runs for the framework\'s own control paths', async () => {
    // A project auth guard 401-ing its own cache purges would be a very
    // confusing afternoon.
    const seen: string[] = [];
    const runner = createMiddlewareRunner({
      default: (ctx: MiddlewareContext) => { seen.push(ctx.pathname); },
    });
    await runner.run(req('https://x.test/__vura/revalidate'));
    await runner.run(req('https://x.test/__tasks/abc'));
    expect(seen).toEqual([]);
  });

  it('propagates a throwing middleware rather than swallowing it', async () => {
    const runner = createMiddlewareRunner({
      default: () => { throw new Error('boom'); },
    });
    await expect(runner.run(req('https://x.test/'))).rejects.toThrow('boom');
  });
});
