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
    const scripts = [...(pageConfig.scripts ?? [])];

    if (page.mode === 'client') {
      // Client mode: minimal shell, JS does the rendering
      bodyHtml = '<div id="loading">Loading...</div>';
      const clientScript = options.clientScripts?.[page.filePath];
      if (clientScript) scripts.push(clientScript);
      else scripts.push(`/${page.filePath.replace(/\.(tsx|jsx|ts|js)$/, '.js')}`);
    } else {
      // Static and hybrid: pre-render the component
      const vnode = Component(pageConfig.props ?? {});
      bodyHtml = renderToString(vnode);

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
): string {
  const boot = mode === 'hybrid' ? 'hydrate' : 'mount';
  return `import Component, * as _pageMod from ${JSON.stringify(pageImportSpecifier)};
import { h, ${boot} } from 'what-framework';

const _props = (_pageMod.page && _pageMod.page.props) || {};
const _root = document.getElementById('app') || document.body;
${boot}(h(Component, _props), _root);
`;
}

// ─── Document Wrapper ───

export interface DocumentOptions {
  title: string;
  meta: Array<Record<string, string>>;
  styles: string[];
  scripts: string[];
  head: string;
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
