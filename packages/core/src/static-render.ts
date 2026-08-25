/**
 * Page Renderer
 *
 * Renders page components to HTML for all page modes:
 *   - static: pre-render at build time → HTML files
 *   - server: render per-request at runtime (handled by server entry)
 *   - hybrid: static shell + island markers for client hydration
 *   - client: minimal shell + JS bundle for SPA
 *
 * Uses What Framework's renderToString (required peer dependency).
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { renderToString } from 'what-framework/server';
import { h } from 'what-framework';
import {
  createLoaderContext,
  isLoaderNotFound,
  isLoaderRedirect,
  LoaderDataProvider,
  runLoaderChain,
  serializeLoaderPayload,
  type LoaderSegment,
} from './runtime/loader.js';
import type { PageRoute } from './manifest.js';

export interface PageRenderResult {
  urlPattern: string;
  filePath: string;
  html: string;
  outputPath: string;
}

export interface StaticRenderOptions {
  /** Browser module paths keyed by page filePath, emitted relative to dist/static root. */
  clientScripts?: Record<string, string>;
}

/**
 * Render all static pages from compiled page modules.
 *
 * Each page module should export:
 *   - default: Component function (returns VNode)
 *   - page (optional): { title, meta, styles, scripts }
 */
export async function renderStaticPages(
  pages: PageRoute[],
  loadModule: (filePath: string) => Promise<any>,
  outDir: string,
  options: StaticRenderOptions = {},
): Promise<PageRenderResult[]> {
  // Render static, client, and hybrid pages at build time.
  // Server pages are skipped (rendered at runtime).
  const buildTimePages = pages.filter(p => p.mode !== 'server');
  const results: PageRenderResult[] = [];

  for (const page of buildTimePages) {
    const mod = await loadModule(page.filePath);
    const Component = mod.default;
    const pageConfig = mod.page ?? {};

    if (typeof Component !== 'function') {
      console.warn(`  [then] Warning: ${page.filePath} has no default export component`);
      continue;
    }

    let bodyHtml: string;
    let loaderPayload = '';
    const scripts = [...(pageConfig.scripts ?? [])];

    if (page.mode === 'client') {
      // Client mode: minimal shell, JS does the rendering
      bodyHtml = '<div id="loading">Loading...</div>';
      const clientScript = options.clientScripts?.[page.filePath];
      if (clientScript) scripts.push(clientScript);
      else scripts.push(`/${page.filePath.replace(/\.(tsx|jsx|ts|js)$/, '.js')}`);
    } else {
      // Static and hybrid: pre-render the component.
      //
      // A loader on a build-time page runs HERE, once, with no request. That is
      // the whole difference between `static` and `server`: same loader code,
      // resolved at build instead of per request. `ctx.request` is absent, which
      // is why LoaderContext declares it optional.
      // The layout chain runs here exactly as it does on the server path.
      // Build-time pages used to skip layouts entirely: a `_layout.tsx` in a
      // directory of static or hybrid pages was silently ignored, so the same
      // page rendered with its layout in `vura dev` and without it in the
      // build. The loader segments are keyed the same way as the server path
      // (`layout:0`, `layout:1`, `page`), which is what lets a hybrid page's
      // browser bundle rebuild the same tree from the serialized payload.
      const layoutMods: any[] = [];
      for (const layoutPath of page.layouts ?? []) {
        layoutMods.push(await loadModule(layoutPath));
      }

      const segments: LoaderSegment[] = [
        ...layoutMods.map((layout, i) => ({ id: `layout:${i}`, loader: layout.loader })),
        { id: 'page', loader: mod.loader, getServerData: mod.getServerData },
      ];
      const ctx = createLoaderContext({ params: {}, url: page.urlPattern, query: {} });
      let loaded: Awaited<ReturnType<typeof runLoaderChain>>;
      try {
        loaded = await runLoaderChain(segments, ctx);
      } catch (err) {
        // notFound()/redirect() have no meaning at build time — there is no
        // request to answer. Say so plainly instead of failing with a stack
        // trace from inside the loader machinery.
        if (isLoaderNotFound(err) || isLoaderRedirect(err)) {
          throw new Error(
            `[vura] ${page.filePath}: a build-time loader called ${isLoaderNotFound(err) ? 'notFound()' : 'redirect()'}, ` +
              `which only works for a page rendered per request. Set page mode to 'server' if this page needs request-time control flow.`,
          );
        }
        throw err;
      }
      const pageData = loaded.data[loaded.data.length - 1];
      const legacyProps =
        typeof mod.loader !== 'function' && typeof mod.getServerData === 'function' && pageData && typeof pageData === 'object'
          ? (pageData as Record<string, unknown>)
          : {};

      // h(), not a direct call: a component invoked directly has no component
      // context, so every What hook inside it — including the useContext that
      // useLoaderData is built on — has nothing to read.
      let vnode: unknown = h(
        LoaderDataProvider as any,
        { value: pageData },
        h(Component as any, { ...(pageConfig.props ?? {}), ...legacyProps }),
      );
      for (let i = layoutMods.length - 1; i >= 0; i--) {
        const Layout = layoutMods[i]?.default;
        if (typeof Layout === 'function') {
          vnode = h(
            LoaderDataProvider as any,
            { value: loaded.data[i] },
            h(Layout as any, { children: vnode }),
          );
        }
      }
      bodyHtml = renderToString(vnode as any);
      if (typeof bodyHtml === 'string' && /^\s*&lt;/.test(bodyHtml)) {
        console.warn(
          `  [then] Warning: ${page.filePath} returned an HTML string — it will be escaped and render as literal text. Return JSX / h() nodes instead.`,
        );
      }
      loaderPayload = serializeLoaderPayload(loaded.byId);

      if (page.mode === 'hybrid') {
        // Hybrid pages include their browser bundle for hydration/island code.
        const clientScript = options.clientScripts?.[page.filePath];
        if (clientScript) scripts.push(clientScript);
      }
    }

    // Wrap in full HTML document
    const html = wrapDocument(bodyHtml, {
      title: pageConfig.title ?? 'Vura App',
      meta: pageConfig.meta ?? [],
      styles: pageConfig.styles ?? [],
      scripts,
      head: pageConfig.head ?? '',
      bodyEnd: loaderPayload,
    });

    // Determine output path
    const outputPath = join(
      outDir,
      'static',
      page.urlPattern === '/' ? 'index.html' : `${page.urlPattern}/index.html`,
    );

    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, html);

    results.push({
      urlPattern: page.urlPattern,
      filePath: page.filePath,
      html,
      outputPath,
    });
  }

  return results;
}

// ─── Client Entry Generator ───

/**
 * Generate the browser entry source for a client/hybrid page.
 *
 * The emitted module imports the page component and actually boots it:
 *   - client: mount() — clears the "Loading..." shell and renders fresh
 *   - hybrid: hydrate() — attaches to the build-time prerendered DOM
 *
 * Bundlers must compile this with the page's resolveDir so the relative
 * page import resolves (the CLI feeds it to esbuild via stdin).
 * Without this wrapper the bundle is just `export default Component` and
 * nothing ever calls mount — the shell stays at "Loading..." forever.
 */
export function generateClientPageEntry(
  pageImportSpecifier: string,
  mode: 'client' | 'hybrid',
  options: { dev?: boolean; layoutImportSpecifiers?: string[] } = {},
): string {
  const boot = mode === 'hybrid' ? 'hydrate' : 'mount';
  // When a client/hybrid page throws during its initial render, mount()/hydrate()
  // leaves the #app shell empty — the user gets a blank white page and the only
  // signal is a console error. Guard the boot so a readable panel renders
  // instead. In dev the panel shows the message + stack; in prod it stays
  // generic so stack traces are not leaked to end users.
  const dev = options.dev === true ? 'true' : 'false';
  const layouts = options.layoutImportSpecifiers ?? [];
  const layoutImports = layouts
    .map((spec, i) => `import _Layout${i} from ${JSON.stringify(spec)};`)
    .join('\n');
  const layoutList = `[${layouts.map((_, i) => `_Layout${i}`).join(', ')}]`;

  return `import Component, * as _pageMod from ${JSON.stringify(pageImportSpecifier)};
import { h, ${boot} } from 'what-framework';
import { LoaderDataProvider as _LoaderDataProvider, readLoaderPayload as _readLoaderPayload } from '@celsian/vura-core/client';
${layoutImports}

const _props = (_pageMod.page && _pageMod.page.props) || {};
const _root = document.getElementById('app') || document.body;
// The server serialized every segment's loader data into the document. Re-open
// the same scopes on the client so useLoaderData() reads on hydrate what it
// read during the server render, instead of throwing "no loader" in the
// browser. The layout chain is rebuilt here for the same reason: the server
// rendered the page inside its layouts, so hydration has to walk the same tree
// or it will not match the DOM it is given.
const _payload = _readLoaderPayload() || {};
const _segment = (key) =>
  Object.prototype.hasOwnProperty.call(_payload, key) ? _payload[key] : undefined;
const _hasLoaderData = Object.prototype.hasOwnProperty.call(_payload, 'page');
let _tree = _hasLoaderData
  ? h(_LoaderDataProvider, { value: _payload.page }, h(Component, _props))
  : h(Component, _props);
const _layouts = ${layoutList};
for (let _i = _layouts.length - 1; _i >= 0; _i--) {
  const _Layout = _layouts[_i];
  if (typeof _Layout !== 'function') continue;
  _tree = h(_LoaderDataProvider, { value: _segment('layout:' + _i) }, h(_Layout, { children: _tree }));
}
try {
  ${boot}(_tree, _root);
} catch (_err) {
  _renderVuraBootError(_root, _err, ${dev});
}

function _renderVuraBootError(root, err, dev) {
  console.error('[vura] page failed to ${boot}:', err);
  const message = err && err.message ? String(err.message) : String(err);
  const stack = dev && err && err.stack ? String(err.stack) : '';
  try { root.innerHTML = ''; } catch (_) {}
  const box = document.createElement('div');
  box.setAttribute('role', 'alert');
  box.style.cssText = 'margin:2rem auto;max-width:42rem;padding:1.25rem 1.5rem;border:1px solid #f3b0b0;border-radius:8px;background:#fff5f5;color:#7f1d1d;font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace';
  const title = document.createElement('strong');
  title.style.cssText = 'display:block;font-size:15px;margin-bottom:.5rem';
  title.textContent = dev ? 'This page failed to render' : 'Something went wrong';
  box.appendChild(title);
  const detail = document.createElement('div');
  detail.textContent = dev ? message : 'An unexpected error occurred while loading this page.';
  box.appendChild(detail);
  if (stack) {
    const pre = document.createElement('pre');
    pre.style.cssText = 'margin:.75rem 0 0;padding:.75rem;overflow:auto;background:#1a1a1a;color:#f4f4f4;border-radius:6px;font-size:12px;white-space:pre-wrap';
    pre.textContent = stack;
    box.appendChild(pre);
  }
  root.appendChild(box);
}
`;
}

// ─── Document Wrapper ───

export interface DocumentOptions {
  title: string;
  meta: Array<Record<string, string>>;
  styles: string[];
  scripts: string[];
  head: string;
  /**
   * Markup appended after the app root and before the script tags.
   *
   * This is where the serialized loader payload goes. It must be OUTSIDE
   * `<div id="app">`: hydration walks the server-rendered DOM node for node,
   * and an extra child the client tree does not produce is a mismatch.
   */
  bodyEnd?: string;
}

export function wrapDocument(bodyHtml: string, opts: DocumentOptions): string {
  const metaTags = opts.meta
    .map(m => `<meta ${Object.entries(m).map(([k, v]) => `${k}="${escapeHtml(v)}"`).join(' ')}>`)
    .join('\n    ');

  const styleTags = opts.styles
    .map(s => s.startsWith('http') ? `<link rel="stylesheet" href="${s}">` : `<style>${s}</style>`)
    .join('\n    ');

  const scriptTags = opts.scripts
    .map(s => `<script type="module" src="${s}"></script>`)
    .join('\n    ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(opts.title)}</title>
    ${metaTags}
    ${styleTags}
    ${opts.head}
</head>
<body>
    <div id="app">${bodyHtml}</div>
    ${opts.bodyEnd ?? ''}
    ${scriptTags}
</body>
</html>`;
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
