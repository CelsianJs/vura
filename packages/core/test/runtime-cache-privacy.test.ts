import { describe, it, expect } from 'vitest';
import { h } from 'what-framework';
import { buildWhatRoutes, createPagesHandler } from '../src/runtime/pages.js';
import { createVuraCache } from '../src/runtime/cache.js';
import { useLoaderData } from '../src/runtime/loader.js';

function personalizedHandler(vary: unknown) {
  const config = { revalidate: 60, vary };
  let renders = 0;
  const routes = buildWhatRoutes([{
    urlPattern: '/account', mode: 'server', config,
    filePath: 'src/pages/account.tsx', layouts: [], hasGetServerData: false,
    module: {
      loader: ({ request, query }) => {
        renders++;
        return {
          identity: request?.headers.get('cookie') ?? request?.headers.get('authorization') ?? request?.headers.get('accept-language'),
          query,
        };
      },
      default: () => h('p', null, JSON.stringify(useLoaderData())),
    },
  }]);
  const { engine } = createVuraCache({});
  return { routes, handle: createPagesHandler({ routes, cache: engine }), renders: () => renders };
}

describe('Vura ISR privacy policy survives route mapping', () => {
  it.each([
    ['cookie array', ['cookie:session'], 'cookie', 'session=alice', 'session=bob', 'Cookie'],
    ['cookie shorthand', 'cookie:session', 'cookie', 'session=alice', 'session=bob', 'Cookie'],
    ['authorization', ['authorization'], 'authorization', 'Bearer alice', 'Bearer bob', 'authorization'],
    ['header source', ['header:accept-language'], 'accept-language', 'en', 'fr', 'accept-language'],
  ])('keeps %s visitors separate and non-public', async (_label, vary, header, alice, bob, expectedVary) => {
    const app = personalizedHandler(vary);
    const visit = (value: string) => app.handle(new Request('http://test/account', { headers: { [header as string]: value } }));
    const first = await visit(alice as string);
    expect(await first.text()).toContain(alice as string);
    const second = await visit(bob as string);
    const body = await second.text();
    const payload = JSON.parse(body.match(/<script id="__VURA_LOADER__" type="application\/json">(.*?)<\/script>/s)![1]!);
    expect(payload.page.identity).toBe(bob);
    expect(payload.page.identity).not.toBe(alice);
    expect(app.routes[0]!.page).toHaveProperty('vary', vary);
    expect(second.headers.get('cache-control')).toBe('private, no-store');
    expect(second.headers.get('vary')?.toLowerCase()).toBe((expectedVary as string).toLowerCase());
    const repeat = await visit(bob as string);
    expect(repeat.headers.get('x-what-cache')).toBe('HIT');
    expect(app.renders()).toBe(2);
  });

  it.each([
    { vary: false }, { vary: 42 }, { vary: {} },
    { vary: ['cookie:session', 42] }, { vary: [''] }, { vary: ['query:tenant'] },
  ])(
    'fails closed for unsupported vary declaration $vary', async ({ vary }) => {
      const app = personalizedHandler(vary);
      const first = await app.handle(new Request('http://test/account', { headers: { cookie: 'session=alice' } }));
      await first.text();
      const second = await app.handle(new Request('http://test/account', { headers: { cookie: 'session=bob' } }));
      expect(await second.text()).toContain('session=bob');
      expect(second.headers.get('x-what-cache')).toBe('BYPASS');
      expect(second.headers.get('cache-control')).toBe('private, no-store');
      expect(app.renders()).toBe(2);
    },
  );

  it('retains query identity, including repeated value order, within a cookie variant', async () => {
    const app = personalizedHandler(['cookie:session']);
    const visit = (query: string) => app.handle(new Request(`http://test/account?${query}`, { headers: { cookie: 'session=alice' } }));
    const first = await visit('filter=a&filter=b');
    const original = await first.text();
    const reversed = await visit('filter=b&filter=a');
    expect(await reversed.text()).not.toBe(original);
    expect(reversed.headers.get('x-what-cache')).toBe('MISS');
    const repeat = await visit('filter=a&filter=b');
    expect(await repeat.text()).toBe(original);
    expect(repeat.headers.get('x-what-cache')).toBe('HIT');
    expect(app.renders()).toBe(2);
  });
});
