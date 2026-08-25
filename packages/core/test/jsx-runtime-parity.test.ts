import { describe, expect, it } from 'vitest';

import { jsx, jsxs, jsxDEV, Fragment } from '../src/jsx-runtime.js';

// `@celsian/vura-core/jsx-runtime` is a real jsxImportSource: the CLI selects it
// whenever `import('what-framework/jsx-runtime')` does not resolve, and both the
// Lambda and Cloudflare adapters alias it explicitly. So whatever it produces is
// what a built page hands to `renderToString`.
//
// It used to produce `{ type, props, children, key }` while What's vnode is
// `{ tag, props, children, key, _vnode }`, which meant pages rendered as
// `<undefined>…</undefined>`: no error, no warning, and tests that asserted the
// page *contained* its text passed anyway. These assert the shape directly,
// against What's own runtime, so the two cannot drift apart again silently.
const whatRuntime = await import('what-framework/jsx-runtime');

describe('vura-core/jsx-runtime is What\'s runtime', () => {
  it('produces a vnode keyed by `tag`, not `type`', () => {
    const node = jsx('article', { children: 'Hybrid blog' }) as Record<string, unknown>;
    expect(node.tag).toBe('article');
    expect(node.type).toBeUndefined();
    expect(node._vnode).toBe(true);
  });

  it('renders through what-server instead of emitting <undefined>', async () => {
    const { renderToString } = await import('what-framework/server');
    const html = renderToString(jsx('article', { children: 'Hybrid blog' }) as never);
    expect(html).toBe('<article>Hybrid blog</article>');
    expect(html).not.toContain('undefined');
  });

  it('matches What\'s runtime node for node', () => {
    const cases: Array<[string, Record<string, unknown>, string | undefined]> = [
      ['div', { children: 'text' }, undefined],
      ['ul', { children: ['a', 'b'] }, undefined],
      ['input', { type: 'text', value: 'v' }, undefined],
      ['li', { children: 'keyed' }, 'k1'],
      ['section', {}, undefined],
    ];
    for (const [tag, props, key] of cases) {
      expect(jsx(tag, props, key)).toEqual(whatRuntime.jsx(tag, props, key));
      expect(jsxs(tag, props, key)).toEqual(whatRuntime.jsx(tag, props, key));
      expect(jsxDEV(tag, props, key)).toEqual(whatRuntime.jsx(tag, props, key));
    }
  });

  it('exports What\'s Fragment, not a symbol of its own', () => {
    // The old export was `Symbol.for('Fragment')`, which is not a component and
    // would have hit the same invalid-tag path as the vnode shape.
    expect(Fragment).toBe(whatRuntime.Fragment);
    expect(typeof Fragment).toBe('function');
  });
});
