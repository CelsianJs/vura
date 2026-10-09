import { expect, it } from 'vitest';
import { h } from 'what-framework';
import { fileToUrlPattern } from '../src/manifest.js';
import { buildWhatRoutes, createPagesHandler } from '../src/runtime/pages.js';

it('dispatches a scanner-generated named catch-all through streaming, not buffered ISR', async () => {
  const handler = createPagesHandler({ routes: buildWhatRoutes([{
    filePath: 'src/pages/docs/[...rest].tsx',
    urlPattern: fileToUrlPattern('docs/[...rest].tsx', ''),
    mode: 'server', config: { streaming: true, revalidate: 60 }, layouts: [],
    module: { default: ({ params }: { params: Record<string, string> }) => h('p', null, `REST:${params.rest}`) },
  }]) });
  const response = await handler(new Request('http://localhost/docs/a/b'));
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toContain('no-store');
  expect(await response.text()).toContain('REST:a/b');
});
