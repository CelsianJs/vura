/**
 * Vura JSX Runtime
 *
 * Minimal JSX runtime for static page rendering at build time.
 * When What Framework is installed, its jsx-runtime takes precedence.
 * This is the fallback for build-time SSR without the full framework.
 *
 * Supports: jsx(), jsxs(), Fragment (automatic JSX transform)
 */

export function jsx(type: any, props: Record<string, any>, key?: string): any {
  const { children, ...rest } = props ?? {};
  return {
    type,
    props: rest,
    children: children != null ? (Array.isArray(children) ? children : [children]) : [],
    key,
  };
}

export const jsxs = jsx;

export function jsxDEV(type: any, props: Record<string, any>, key?: string): any {
  return jsx(type, props, key);
}

export const Fragment = Symbol.for('Fragment');
