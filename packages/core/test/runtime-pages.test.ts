import { describe, it, expect } from 'vitest';
import { buildWhatRoutes, createPagesHandler } from '../src/runtime/pages.js';
import { h } from 'what-framework';

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
