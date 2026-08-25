import { describe, expect, it, vi } from 'vitest';
import { h } from 'what-framework';
import { renderToString } from 'what-framework/server';
import {
  createLoaderContext,
  isLoaderNotFound,
  isLoaderRedirect,
  LOADER_PAYLOAD_ID,
  LoaderDataProvider,
  readLoaderPayload,
  runLoaderChain,
  serializeLoaderPayload,
  useLoaderData,
  type LoaderSegment,
} from '../src/runtime/loader.js';

const ctx = () => createLoaderContext({ params: { id: '42' }, url: '/posts/42', query: {} });

describe('runLoaderChain', () => {
  it('runs every segment in parallel, not one after another', async () => {
    // If the chain awaited each loader in turn, the second could not start
    // before the first resolved, and nesting would cost latency per level.
    const started: string[] = [];
    const gate = { release: () => {} };
    const held = new Promise<void>((resolve) => { gate.release = resolve; });

    const segments: LoaderSegment[] = [
      { id: 'layout:0', loader: async () => { started.push('layout'); await held; return { user: 'kirby' }; } },
      { id: 'page', loader: async () => { started.push('page'); return { post: 'hello' }; } },
    ];

    const chain = runLoaderChain(segments, ctx());
    await Promise.resolve();
    expect(started, 'the page loader must start before the layout loader resolves').toEqual(['layout', 'page']);
    gate.release();

    const { data, byId } = await chain;
    expect(data).toEqual([{ user: 'kirby' }, { post: 'hello' }]);
    expect(byId).toEqual({ 'layout:0': { user: 'kirby' }, page: { post: 'hello' } });
  });

  it('leaves a segment with no loader undefined and out of the payload', async () => {
    const { data, byId } = await runLoaderChain(
      [{ id: 'layout:0' }, { id: 'page', loader: () => ({ ok: true }) }],
      ctx(),
    );
    expect(data[0]).toBeUndefined();
    expect(byId).toEqual({ page: { ok: true } });
  });

  it('runs getServerData when there is no loader, with the legacy context shape', async () => {
    const seen: unknown[] = [];
    const { data } = await runLoaderChain(
      [{ id: 'page', getServerData: (c) => { seen.push(c); return { legacy: true }; } }],
      ctx(),
    );
    expect(data[0]).toEqual({ legacy: true });
    // The old contract passed exactly these three, and pages destructure them.
    expect(seen[0]).toEqual({ params: { id: '42' }, url: '/posts/42', query: {} });
  });

  it('prefers loader over getServerData when a page exports both', async () => {
    const { data } = await runLoaderChain(
      [{ id: 'page', loader: () => ({ from: 'loader' }), getServerData: () => ({ from: 'getServerData' }) }],
      ctx(),
    );
    expect(data[0]).toEqual({ from: 'loader' });
  });

  it('propagates a throwing loader so notFound and redirect reach the runtime', async () => {
    const c = ctx();
    await expect(
      runLoaderChain([{ id: 'page', loader: () => { throw c.notFound(); } }], c),
    ).rejects.toSatisfy(isLoaderNotFound);
    await expect(
      runLoaderChain([{ id: 'page', loader: () => { throw c.redirect('/login', 307); } }], c),
    ).rejects.toSatisfy((e: unknown) => isLoaderRedirect(e) && e.location === '/login' && e.status === 307);
  });
});

describe('control-flow errors are recognised across bundle copies', () => {
  it('identifies a structurally identical error from another module instance', () => {
    // Vura bundles its server entry and each route separately, so an error
    // thrown from one bundle is caught by a different copy of the class. This
    // is the shape that made what-framework's revalidation registry no-op.
    const fromAnotherBundle = { isLoaderNotFound: true, name: 'LoaderNotFoundError', message: 'Not Found' };
    expect(isLoaderNotFound(fromAnotherBundle)).toBe(true);
    expect(isLoaderRedirect({ isLoaderRedirect: true, location: '/x', status: 302 })).toBe(true);
    expect(isLoaderNotFound(new Error('plain'))).toBe(false);
    expect(isLoaderNotFound(null)).toBe(false);
  });
});

describe('useLoaderData', () => {
  it('reads the nearest segment through a synchronous renderToString', () => {
    function Deep() {
      const data = useLoaderData<{ label: string }>();
      return h('span', null, data.label);
    }
    function Middle() { return h('div', null, h(Deep, null)); }

    const page = h(LoaderDataProvider as never, { value: { label: 'PAGE' } }, h(Middle, null));
    const tree = h(
      LoaderDataProvider as never,
      { value: { label: 'LAYOUT' } },
      h(function Layout({ children }: { children: unknown }) {
        return h('main', null, children, h(Deep, null));
      } as never, { children: page }),
    );

    // The component three levels inside the page sees the page's data; the
    // sibling inside the layout sees the layout's. That is the whole point of
    // layered loaders, and it only holds if the scoping follows the tree.
    expect(renderToString(tree as never)).toBe('<main><div><span>PAGE</span></div><span>LAYOUT</span></main>');
  });

  it('throws a message naming the missing export rather than returning undefined', () => {
    function Orphan() {
      const data = useLoaderData<{ x: number }>();
      return h('span', null, String(data.x));
    }
    expect(() => renderToString(h(Orphan, null) as never)).toThrow(/Export a `loader`/);
  });
});

describe('serializeLoaderPayload', () => {
  it('emits nothing when no segment loaded anything', () => {
    expect(serializeLoaderPayload({})).toBe('');
  });

  it('escapes the sequences that end a script element', () => {
    // The HTML parser closes a <script> on `</script` whatever its type is, so
    // data containing that string would otherwise break out into markup.
    const html = serializeLoaderPayload({ page: { bio: '</script><img src=x onerror=alert(1)>' } });
    expect(html).not.toContain('</script><img');
    expect(html).toContain('\\u003c/script\\u003e');
    expect(html.endsWith('</script>')).toBe(true);
  });

  it('escapes the line separators that are literal newlines in JS strings', () => {
    const html = serializeLoaderPayload({ page: { s: '\u2028\u2029' } });
    expect(html).toContain('\\u2028');
    expect(html).toContain('\\u2029');
  });

  it('names the offending data when it cannot be serialized', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => serializeLoaderPayload({ page: circular })).toThrow(/not JSON-serializable/);
  });

  it('round-trips through readLoaderPayload', () => {
    const payload = { page: { post: { title: 'Hello </script>' } }, 'layout:0': { user: 'kirby' } };
    const html = serializeLoaderPayload(payload);
    const json = html.slice(html.indexOf('>') + 1, html.lastIndexOf('</script>'));
    const doc = {
      getElementById: (id: string) => (id === LOADER_PAYLOAD_ID ? { textContent: json } : null),
    };
    expect(readLoaderPayload(doc)).toEqual(payload);
  });

  it('returns an empty object, not a throw, when the document has no payload', () => {
    expect(readLoaderPayload({ getElementById: () => null })).toEqual({});
  });

  it('warns and returns an empty object on a corrupted payload', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(readLoaderPayload({ getElementById: () => ({ textContent: '{not json' }) })).toEqual({});
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not valid JSON'));
    warn.mockRestore();
  });
});

describe('LoaderContext', () => {
  it('omits request when there is none, so a build-time loader can test for it', () => {
    const c = createLoaderContext({ params: {}, url: '/', query: {} });
    expect('request' in c).toBe(false);
  });

  it('carries the request when one exists', () => {
    const req = new Request('https://example.test/posts/42');
    const c = createLoaderContext({ params: {}, url: '/posts/42', query: {}, request: req });
    expect(c.request).toBe(req);
  });

  it('returns the errors rather than throwing them, so `throw ctx.notFound()` reads as a throw', () => {
    const c = createLoaderContext({ params: {}, url: '/', query: {} });
    expect(isLoaderNotFound(c.notFound())).toBe(true);
    expect(c.redirect('/login').status).toBe(302);
    expect(c.redirect('/login', 301).status).toBe(301);
  });
});

describe('one loader context per process, not per module copy', () => {
  // `vura build` bundles every page and every layout separately, and each
  // bundle inlines its own copy of this module; the server entry then inlines
  // all of them. A module-scoped `createContext()` therefore hands the page
  // runtime one context object and a layout component a different one, and
  // `useLoaderData()` inside that layout reports "found no loader data" even
  // though the loader ran. Importing the same file twice under different
  // specifiers reproduces exactly that, cheaply, without a build.
  it('a second copy of the module adopts the first copy\'s context', async () => {
    const first = await import('../src/runtime/loader.js');
    const second = await import('../src/runtime/loader.js?copy=2');

    // Genuinely two module instances...
    expect(second).not.toBe(first);
    // ...sharing one provider, because the context lives on globalThis.
    expect(second.LoaderDataProvider).toBe(first.LoaderDataProvider);
  });

  it('registers the context under a stable global key', async () => {
    const mod = await import('../src/runtime/loader.js');
    const stored = (globalThis as Record<symbol, unknown>)[Symbol.for('vura.loaderDataContext')] as
      | { Provider: unknown }
      | undefined;
    expect(stored, 'the loader context should be published on globalThis').toBeTruthy();
    expect(stored!.Provider).toBe(mod.LoaderDataProvider);
  });
});
