import { describe, it, expect } from 'vitest';
import { buildWhatRoutes, createPagesHandler } from '../src/runtime/pages.js';
import { h } from 'what-framework';
import { useLoaderData } from '../src/runtime/loader.js';

const pageModule = {
  default: (props: { params: Record<string, string>; name?: string }) =>
    h('h1', null, `Hello ${props.name ?? props.params.slug}`),
  getServerData: async ({ params }: { params: Record<string, string> }) => ({ name: params.slug.toUpperCase() }),
  page: { title: 'Post' },
};

describe('buildWhatRoutes', () => {
  it('maps vura patterns and ISR config to what-router routes', () => {
    const routes = buildWhatRoutes([
      { urlPattern: '/blog/:slug', mode: 'server', config: { revalidate: 60, tags: 'blog' },
        filePath: 'src/pages/blog/[slug].tsx', hasGetServerData: true, module: pageModule, layouts: [] },
      { urlPattern: '/docs/*rest', mode: 'server', config: {},
        filePath: 'src/pages/docs/[...rest].tsx', hasGetServerData: false, module: pageModule, layouts: [] },
    ]);
    expect(routes[0]!.path).toBe('/blog/:slug');
    expect(routes[0]!.page).toEqual({ mode: 'static', revalidate: 60, tags: ['blog'] });
    expect(routes[1]!.path).toBe('/docs/*:rest');
    expect(routes[1]!.page).toEqual({ mode: 'server' });
  });
});

describe('createPagesHandler', () => {
  it('renders a server page through createRequestHandler with vura semantics', async () => {
    const handler = createPagesHandler({
      routes: buildWhatRoutes([
        { urlPattern: '/blog/:slug', mode: 'server', config: {},
          filePath: 'src/pages/blog/[slug].tsx', hasGetServerData: true, module: pageModule, layouts: [] },
      ]),
    });
    const res = await handler(new Request('http://localhost/blog/hi'));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<h1>Hello HI</h1>');     // getServerData ran
    expect(html).toContain('<title>Post</title>');   // wrapDocument ran
    expect(res.headers.get('cache-control')).toContain('no-store'); // server mode
  });

  it('returns 404 HTML for unknown paths', async () => {
    const handler = createPagesHandler({ routes: [] });
    const res = await handler(new Request('http://localhost/nope'));
    expect(res.status).toBe(404);
  });

  it('wraps page in layout chain when layoutModules provided', async () => {
    const layoutModule = { default: ({ children }: any) => h('div', { id: 'layout' }, children) };
    const handler = createPagesHandler({
      routes: buildWhatRoutes([
        {
          urlPattern: '/layout-test',
          mode: 'server',
          config: {},
          filePath: 'src/pages/layout-test.tsx',
          hasGetServerData: false,
          module: {
            default: () => h('h1', null, 'Inner'),
            page: { title: 'Layout Test' },
          },
          layoutModules: [layoutModule],
        },
      ]),
    });
    const res = await handler(new Request('http://localhost/layout-test'));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<div id="layout">');
    expect(html).toContain('<h1>Inner</h1>');
  });

  it('returns status 500 when getServerData throws', async () => {
    const handler = createPagesHandler({
      routes: buildWhatRoutes([
        {
          urlPattern: '/boom',
          mode: 'server',
          config: {},
          filePath: 'src/pages/boom.tsx',
          hasGetServerData: true,
          module: {
            default: () => h('h1', null, 'ok'),
            getServerData: async () => { throw new Error('db exploded'); },
          },
        },
      ]),
    });
    const res = await handler(new Request('http://localhost/boom'));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).toContain('Server Error');
  });

  it('flows tags through buildWhatRoutes for ISR pages', () => {
    const routes = buildWhatRoutes([
      {
        urlPattern: '/tagged',
        mode: 'server',
        config: { revalidate: 60, tags: 'blog,post' },
        filePath: 'src/pages/tagged.tsx',
        hasGetServerData: false,
        module: { default: () => h('div', null, '') },
      },
    ]);
    expect(routes[0]!.page.tags).toEqual(['blog', 'post']);
  });
});

describe('loaders (RFC 0001)', () => {
  const route = (module: any, layoutModules?: any[]) =>
    buildWhatRoutes([
      {
        urlPattern: '/posts/:id',
        mode: 'server',
        config: {},
        filePath: 'src/pages/posts/[id].tsx',
        hasLoader: true,
        hasGetServerData: false,
        module,
        layouts: [],
        ...(layoutModules ? { layoutModules } : {}),
      } as any,
    ]);

  it('runs a page loader and renders with its data, no prop drilling', async () => {
    const handler = createPagesHandler({
      routes: route({
        loader: async (ctx: any) => ({ post: { title: `Post ${ctx.params.id}` } }),
        default: () => {
          const { post } = useLoaderData<{ post: { title: string } }>();
          return h('h1', null, post.title);
        },
        page: { title: 'Post' },
      }),
    });
    const res = await handler(new Request('http://localhost/posts/42'));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<h1>Post 42</h1>');
  });

  it('gives a layout and its page each their own data', async () => {
    const handler = createPagesHandler({
      routes: route(
        {
          loader: () => ({ invoices: 3 }),
          default: () => h('p', null, `invoices: ${(useLoaderData<{ invoices: number }>()).invoices}`),
        },
        [
          {
            loader: () => ({ user: 'kirby' }),
            default: ({ children }: any) =>
              h('main', null, h('span', null, (useLoaderData<{ user: string }>()).user), children),
          },
        ],
      ),
    });
    const html = await (await handler(new Request('http://localhost/posts/42'))).text();
    expect(html).toContain('<main><span>kirby</span><p>invoices: 3</p></main>');
  });

  it('serializes loader data into the document, outside the app root', async () => {
    const handler = createPagesHandler({
      routes: route({
        loader: () => ({ post: { title: 'Hello' } }),
        default: () => h('h1', null, (useLoaderData<{ post: { title: string } }>()).post.title),
      }),
    });
    const html = await (await handler(new Request('http://localhost/posts/42'))).text();
    expect(html).toContain('<script id="__VURA_LOADER__" type="application/json">');
    expect(html).toContain('{"page":{"post":{"title":"Hello"}}}');
    // Inside #app it would be an extra node the client tree never produces,
    // which is a hydration mismatch on every hybrid page.
    const appDiv = html.slice(html.indexOf('<div id="app">'), html.indexOf('</div>') + 6);
    expect(appDiv).not.toContain('__VURA_LOADER__');
  });

  it('answers ctx.notFound() with a 404, not a 500', async () => {
    const handler = createPagesHandler({
      routes: route({
        loader: (ctx: any) => { throw ctx.notFound(); },
        default: () => h('h1', null, 'never'),
      }),
    });
    const res = await handler(new Request('http://localhost/posts/999'));
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('404');
  });

  it('answers ctx.redirect() with a real Location header', async () => {
    const handler = createPagesHandler({
      routes: route({
        loader: (ctx: any) => { throw ctx.redirect('/login', 307); },
        default: () => h('h1', null, 'never'),
      }),
    });
    const res = await handler(new Request('http://localhost/posts/42'));
    expect(res.status).toBe(307);
    // A 3xx with no Location is worse than no redirect: the browser renders an
    // empty page and nothing says why.
    expect(res.headers.get('location')).toBe('/login');
  });

  it('still spreads getServerData into props AND exposes it to useLoaderData', async () => {
    const handler = createPagesHandler({
      routes: route({
        getServerData: async ({ params }: any) => ({ name: `legacy-${params.id}` }),
        default: (props: any) =>
          h('h1', null, `${props.name}/${(useLoaderData<{ name: string }>()).name}`),
      }),
    });
    const html = await (await handler(new Request('http://localhost/posts/7'))).text();
    expect(html).toContain('<h1>legacy-7/legacy-7</h1>');
  });

  it('reports a loader that throws for real as a 500, unchanged', async () => {
    const handler = createPagesHandler({
      routes: route({
        loader: () => { throw new Error('database is on fire'); },
        default: () => h('h1', null, 'never'),
      }),
    });
    const errors: unknown[] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      const res = await handler(new Request('http://localhost/posts/42'));
      expect(res.status).toBe(500);
    } finally {
      console.error = consoleError;
    }
    expect(errors.length).toBe(1);
  });
});
