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

  // ── The half of the promise that was not kept ──
  //
  // The message above has always said "no functions, class instances, or
  // circular references". Only the circular half was true. `JSON.stringify`
  // drops a function and flattens a class instance without a word, so the page
  // served a 200, the server rendered from the live object, and the browser
  // hydrated from a payload missing exactly the thing the server had used.
  // Each case below therefore asserts a throw where the shipped code returned
  // a `<script>` tag.
  describe('refuses what a JSON round-trip would change', () => {
    it('refuses a function, naming the path to it', () => {
      expect(() => serializeLoaderPayload({ page: { label: 'x', fn: () => 'live' } }))
        .toThrow(/`page\.fn` is a function/);
    });

    it('refuses a function nested inside plain data', () => {
      expect(() => serializeLoaderPayload({ page: { user: { profile: { render: () => null } } } }))
        .toThrow(/`page\.user\.profile\.render` is a function/);
    });

    it('refuses a function inside an array', () => {
      expect(() => serializeLoaderPayload({ page: { rows: [{ ok: true }, { go: () => 1 }] } }))
        .toThrow(/`page\.rows\[1\]\.go` is a function/);
    });

    it('refuses a class instance, whose methods do not survive the round-trip', () => {
      class Post {
        constructor(public title: string) {}
        shout() { return this.title.toUpperCase(); }
      }
      expect(() => serializeLoaderPayload({ page: { post: new Post('hello') } }))
        .toThrow(/`page\.post` is a Post instance/);
    });

    it('refuses a Map, which JSON writes as an empty object', () => {
      expect(() => serializeLoaderPayload({ page: { index: new Map([['a', 1]]) } }))
        .toThrow(/`page\.index` is a Map instance/);
    });

    it('refuses a Set, for the same reason', () => {
      expect(() => serializeLoaderPayload({ page: { tags: new Set(['a']) } }))
        .toThrow(/`page\.tags` is a Set instance/);
    });

    it('refuses an Error, which loses its message', () => {
      expect(() => serializeLoaderPayload({ page: { err: new Error('boom') } }))
        .toThrow(/`page\.err` is an? Error instance/);
    });

    it('refuses a cycle reached through an array', () => {
      const node: Record<string, unknown> = { name: 'a' };
      node.children = [node];
      expect(() => serializeLoaderPayload({ page: { node } }))
        .toThrow(/`page\.node\.children\[0\]` closes a circular reference/);
    });

    it('refuses a bigint', () => {
      expect(() => serializeLoaderPayload({ page: { id: 1n } })).toThrow(/`page\.id` is a bigint/);
    });

    it('refuses a symbol', () => {
      expect(() => serializeLoaderPayload({ page: { tag: Symbol('t') } })).toThrow(/`page\.tag` is a symbol/);
    });

    it('refuses NaN and Infinity, which JSON writes as null', () => {
      expect(() => serializeLoaderPayload({ page: { n: NaN } })).toThrow(/`page\.n` is NaN/);
      expect(() => serializeLoaderPayload({ page: { n: Infinity } })).toThrow(/`page\.n` is Infinity/);
    });

    it('checks every segment, not only the first', () => {
      expect(() => serializeLoaderPayload({ 'layout:0': { ok: 1 }, page: { fn: () => 1 } }))
        .toThrow(/`page\.fn` is a function/);
    });
  });

  // ── The half that must keep working ──
  //
  // A guard that rejects ordinary data is worse than the bug it replaces, so
  // the allowances are pinned as tightly as the refusals.
  describe('allows what a JSON round-trip preserves', () => {
    it('allows plain objects, arrays, null and nesting', () => {
      const html = serializeLoaderPayload({
        page: { list: [1, 'two', null, { deep: [true] }], nested: { s: 'x' } },
      });
      expect(html).toContain('"deep"');
    });

    it('allows a Date, which reaches the browser as an ISO string', () => {
      const html = serializeLoaderPayload({ page: { when: new Date(0) } });
      expect(html).toContain('1970-01-01T00:00:00.000Z');
    });

    it('allows an object created with a null prototype', () => {
      const bare = Object.create(null) as Record<string, unknown>;
      bare.a = 1;
      expect(() => serializeLoaderPayload({ page: { bare } })).not.toThrow();
    });

    it('allows undefined as an object property, which reads as undefined on both sides', () => {
      // JSON drops the key. `data.maybe === undefined` before and after, so
      // there is nothing for the two renders to disagree about.
      const html = serializeLoaderPayload({ page: { kept: 1, maybe: undefined } });
      expect(html).toContain('"kept"');
      expect(html).not.toContain('maybe');
    });

    it('refuses undefined inside an array, where it would come back as null', () => {
      // The one place undefined changes value rather than disappearing.
      expect(() => serializeLoaderPayload({ page: { rows: [1, undefined, 2] } }))
        .toThrow(/`page\.rows\[1\]` is undefined/);
    });

    it('allows the same object reached twice, which is sharing and not a cycle', () => {
      const user = { name: 'kirby' };
      expect(() => serializeLoaderPayload({ page: { author: user, editor: user } })).not.toThrow();
    });

    it('allows the same object reached twice from inside an array', () => {
      const tag = { id: 1 };
      expect(() => serializeLoaderPayload({ page: { rows: [{ tag }, { tag }] } })).not.toThrow();
    });
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
