/**
 * Streaming SSR unit tests.
 *
 * These cover the parts the self-host audit cannot reach cheaply: the document
 * shell's equivalence with the buffered renderer, the opt-in predicate, and the
 * control flow that has to be settled before the first byte goes out.
 */

import { describe, it, expect, vi } from 'vitest';
import { documentShell, wrapDocument } from '../src/static-render.js';
import { isStreamingPage, createVuraStreamRoute } from '../src/runtime/pages.js';

const shellOpts = {
  title: 'T',
  meta: [{ name: 'description', content: 'd' }],
  styles: ['/a.css'],
  scripts: ['/a.js'],
  head: '<link rel="canonical" href="/x">',
  bodyEnd: '<script id="p">1</script>',
};

describe('documentShell', () => {
  it('concatenates to exactly what wrapDocument produces', () => {
    // The streamed and buffered documents must be byte-identical around the
    // body, or a page would render differently depending on how it was served.
    const { open, close } = documentShell(shellOpts as any);
    expect(open + '<p>BODY</p>' + close).toBe(wrapDocument('<p>BODY</p>', shellOpts as any));
  });

  it('puts the whole head in the opening half', () => {
    const { open, close } = documentShell(shellOpts as any);
    expect(open).toContain('<title>T</title>');
    expect(open).toContain('/a.css');
    expect(open).toContain('canonical');
    expect(close).not.toContain('<title>');
  });

  it('keeps the loader payload in the closing half', () => {
    // It has to come after the body: it is serialized from data the render
    // already consumed, and it must not block the shell going out.
    const { open, close } = documentShell(shellOpts as any);
    expect(close).toContain('<script id="p">1</script>');
    expect(open).not.toContain('<script id="p">');
  });
});

describe('isStreamingPage', () => {
  const base = { module: { default: () => null, page: {} }, config: {} } as any;

  it('is opt-in: a page with no flag does not stream', () => {
    expect(isStreamingPage(base)).toBe(false);
  });

  it('reads the flag from `export const page`', () => {
    expect(isStreamingPage({ ...base, module: { default: () => null, page: { streaming: true } } })).toBe(true);
  });

  it('reads the flag from route config', () => {
    expect(isStreamingPage({ ...base, config: { streaming: true } })).toBe(true);
  });

  it('requires true, not merely truthy', () => {
    // A stray `streaming: 'yes'` should not silently change how a page is
    // served; the flag decides the transport, so it is matched exactly.
    expect(isStreamingPage({ ...base, config: { streaming: 'yes' } as any })).toBe(false);
    expect(isStreamingPage({ ...base, config: { streaming: 1 } as any })).toBe(false);
  });

  it('tolerates a module with no page export', () => {
    expect(isStreamingPage({ module: { default: () => null }, config: undefined } as any)).toBe(false);
  });
});

describe('createVuraStreamRoute control flow', () => {
  const call = (vura: any) =>
    createVuraStreamRoute()({
      path: '/x',
      query: {},
      route: { path: '/x', page: {}, vura } as any,
      params: {},
      request: new Request('http://localhost/x'),
    });

  it('returns a 404 when a loader throws notFound(), with no body streamed', async () => {
    const res = await call({
      module: { default: () => null, page: {}, loader: (ctx: any) => { throw ctx.notFound(); } },
      layoutModules: [],
    });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('404');
  });

  it('returns a real redirect when a loader throws redirect()', async () => {
    const res = await call({
      module: { default: () => null, page: {}, loader: (ctx: any) => { throw ctx.redirect('/login', 307); } },
      layoutModules: [],
    });
    expect(res.status).toBe(307);
    expect(res.headers.get('Location')).toBe('/login');
    expect(res.body).toBeNull();
  });

  it('returns a 500 when a loader throws, before writing any of the document', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await call({
      module: { default: () => null, page: {}, loader: () => { throw new Error('loader blew up'); } },
      layoutModules: [],
    });
    expect(res.status).toBe(500);
    const html = await res.text();
    expect(html).toContain('500');
    // A failed loader must not leak a half-built document.
    expect(html).not.toContain('<div id="app">');
    err.mockRestore();
  });

  it('streams a 200 with no content-length for a page that renders', async () => {
    const res = await call({
      module: { default: () => ({ tag: 'h1', props: {}, children: ['ok'], _vnode: true }), page: { title: 'S' } },
      layoutModules: [],
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBeNull();
    expect(res.headers.get('content-type')).toContain('text/html');
    // Set by hand it would be wrong under HTTP/2 and in the Lambda adapter.
    expect(res.headers.get('transfer-encoding')).toBeNull();
    const html = await res.text();
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
  });

  it('still closes the document when a component throws mid-render', async () => {
    // what-fw catches a throwing component itself and substitutes an SSR-error
    // comment, so the stream is never interrupted. The status is already spent
    // by this point regardless, so the contract that matters is that the
    // document is terminated rather than truncated mid-tree.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await call({
      module: {
        default: () => { throw new Error('render blew up'); },
        page: { title: 'S' },
      },
      layoutModules: [],
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('SSR Error');
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
    warn.mockRestore();
  });

  it('treats a reader going away as a disconnect, not a render failure', async () => {
    // The common case by far: the visitor navigated, closed the tab, or hit
    // stop. Enqueueing into the closed controller throws ERR_INVALID_STATE,
    // and that used to be logged as "stream render failed mid-document" with a
    // stack trace on every single disconnect.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await call({
      module: {
        default: () => ({ tag: 'h1', props: {}, children: ['ok'], _vnode: true }),
        page: { title: 'S' },
      },
      layoutModules: [],
    });
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel(new Error('client went away'));
    await new Promise(r => setTimeout(r, 50));
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });
});
