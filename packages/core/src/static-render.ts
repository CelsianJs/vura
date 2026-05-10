/**
 * Page Renderer
 *
 * Renders page components to HTML for all page modes:
 *   - static: pre-render at build time → HTML files
 *   - server: render per-request at runtime (handled by server entry)
 *   - hybrid: static shell + island markers for client hydration
 *   - client: minimal shell + JS bundle for SPA
 *
 * Uses What Framework's renderToString when available,
 * falls back to a built-in minimal renderer.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { PageRoute } from './manifest.js';

export interface PageRenderResult {
  urlPattern: string;
  filePath: string;
  html: string;
  outputPath: string;
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
): Promise<PageRenderResult[]> {
  // Render static and hybrid pages at build time.
  // Client pages get a minimal shell. Server pages are skipped (rendered at runtime).
  const buildTimePages = pages.filter(p => p.mode !== 'server');
  const results: PageRenderResult[] = [];

  // Try to load What Framework's renderToString
  let renderToString: (vnode: any) => string;
  try {
    // @ts-ignore — optional dependency, resolved at runtime
    const whatServer = await import('what-framework/server');
    renderToString = whatServer.renderToString;
  } catch {
    // Fall back to built-in minimal renderer
    renderToString = builtinRenderToString;
  }

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
      scripts.push(`/${page.filePath.replace(/\.tsx?$/, '.js')}`);
    } else {
      // Static and hybrid: pre-render the component
      const vnode = Component(pageConfig.props ?? {});
      bodyHtml = renderToString(vnode);

      if (page.mode === 'hybrid') {
        // Hybrid pages include the island hydration script
        scripts.push('/@what/islands.js');
      }
    }

    // Wrap in full HTML document
    const html = wrapDocument(bodyHtml, {
      title: pageConfig.title ?? 'ThenJS App',
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

// ─── Built-in Minimal VNode Renderer ───

export function builtinRenderToString(vnode: any): string {
  if (vnode == null || typeof vnode === 'boolean') return '';
  if (typeof vnode === 'string') return escapeHtml(vnode);
  if (typeof vnode === 'number') return String(vnode);

  // Signal/reactive function — call to get value
  if (typeof vnode === 'function' && !vnode.type && !vnode.tag) {
    return builtinRenderToString(vnode());
  }

  // Array of VNodes
  if (Array.isArray(vnode)) {
    return vnode.map(builtinRenderToString).join('');
  }

  // VNode object: { type, props, children } or What Framework { tag, props, children }
  const type = vnode.type ?? vnode.tag;
  const { props = {}, children } = vnode;

  // Function component
  if (typeof type === 'function') {
    const result = type({ ...props, children });
    return builtinRenderToString(result);
  }

  // HTML element
  if (typeof type === 'string') {
    const attrs = renderAttributes(props);
    const tag = type;

    // Void elements
    if (VOID_ELEMENTS.has(tag)) {
      return `<${tag}${attrs}>`;
    }

    // Render children
    let childHtml = '';
    if (props.dangerouslySetInnerHTML) {
      childHtml = props.dangerouslySetInnerHTML.__html ?? '';
    } else if (children != null) {
      if (Array.isArray(children)) {
        childHtml = children.map(builtinRenderToString).join('');
      } else {
        childHtml = builtinRenderToString(children);
      }
    }

    return `<${tag}${attrs}>${childHtml}</${tag}>`;
  }

  // Fragment (type is undefined/null or Symbol.for('Fragment'))
  if ((!type || typeof type === 'symbol') && children) {
    if (Array.isArray(children)) {
      return children.map(builtinRenderToString).join('');
    }
    return builtinRenderToString(children);
  }

  return '';
}

function renderAttributes(props: Record<string, any>): string {
  let result = '';
  for (const [key, value] of Object.entries(props)) {
    if (key === 'children' || key === 'dangerouslySetInnerHTML') continue;
    if (key.startsWith('on') && key.length > 2) continue; // Skip event handlers
    if (value == null || value === false) continue;

    const attrName = key === 'className' ? 'class' : key === 'htmlFor' ? 'for' : key;

    if (value === true) {
      result += ` ${attrName}`;
    } else if (key === 'style' && typeof value === 'object') {
      const css = Object.entries(value)
        .map(([prop, val]) => `${camelToKebab(prop)}: ${val}`)
        .join('; ');
      result += ` style="${escapeHtml(css)}"`;
    } else {
      result += ` ${attrName}="${escapeHtml(String(value))}"`;
    }
  }
  return result;
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function camelToKebab(str: string): string {
  return str.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`);
}

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);
