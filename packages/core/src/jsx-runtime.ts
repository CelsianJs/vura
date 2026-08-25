/**
 * Vura JSX Runtime
 *
 * A thin re-export of What Framework's automatic JSX runtime.
 *
 * This file used to hand-roll its own vnode, `{ type, props, children, key }`.
 * What's vnode is `{ tag, props, children, key, _vnode }` — the shapes differ in
 * the one field that matters, so every page built through this runtime handed
 * `renderToString` a node whose tag was `undefined`, and what-server 0.11
 * rendered that literally as `<undefined>Hybrid blog</undefined>`. No error, no
 * warning, valid-looking HTML with a garbage element in it. It survived because
 * the tests asserted the page *contained* its text, which it did; what-server
 * 0.13 rejects an undefined tag outright, which finally surfaced it.
 *
 * `what-framework` is a hard dependency here, so there is nothing to fall back
 * to and no reason to keep a second implementation: a copy of a vnode factory is
 * a copy that drifts, and this one drifted before it was ever used.
 * `jsx-runtime-parity.test.ts` asserts the two produce identical nodes.
 */

import { jsx as whatJsx } from 'what-framework/jsx-runtime';

export { jsx, jsxs, Fragment } from 'what-framework/jsx-runtime';

/**
 * Development entry point for the automatic transform.
 *
 * The dev signature carries `__source`/`__self` after `key`; What's runtime has
 * no use for either, so they are dropped rather than forwarded into props where
 * they would render as attributes.
 */
export function jsxDEV(type: unknown, props: Record<string, unknown>, key?: string): unknown {
  return (whatJsx as (t: unknown, p: Record<string, unknown>, k?: string) => unknown)(type, props, key);
}
