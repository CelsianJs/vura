/**
 * The HTML document a rendered page is wrapped in.
 *
 * Split out of static-render.ts, which is the *build-time* renderer and reaches
 * `node:fs/promises` and `node:path` to write files. Nothing here touches a
 * Node built-in, and that is the point: `runtime/pages.ts` needs the document
 * and the serverless adapters bundle `runtime/pages.ts` for Cloudflare Workers
 * with `platform: 'neutral'`, where a `node:` specifier does not resolve at all.
 * Importing the shell through static-render.ts dragged the whole build-time
 * renderer into that graph and made the bundle unbuildable — which is a large
 * part of why those targets served no pages.
 *
 * static-render.ts re-exports all three names, so `wrapDocument` and
 * `escapeHtml` keep their documented import path.
 */

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

/**
 * The document either side of the app root.
 *
 * Split out so a streaming render can flush `open` before the body exists and
 * `close` after the last chunk, without a second copy of the document. A
 * second copy is exactly how `vura dev` spent two releases rendering pages
 * differently from the server it was meant to imitate.
 */
export function documentShell(opts: DocumentOptions): { open: string; close: string } {
  const metaTags = opts.meta
    .map(m => `<meta ${Object.entries(m).map(([k, v]) => `${k}="${escapeHtml(v)}"`).join(' ')}>`)
    .join('\n    ');

  const styleTags = opts.styles
    .map(s => s.startsWith('http') ? `<link rel="stylesheet" href="${s}">` : `<style>${s}</style>`)
    .join('\n    ');

  const scriptTags = opts.scripts
    .map(s => `<script type="module" src="${s}"></script>`)
    .join('\n    ');

  const open = `<!DOCTYPE html>
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
    <div id="app">`;

  const close = `</div>
    ${opts.bodyEnd ?? ''}
    ${scriptTags}
</body>
</html>`;

  return { open, close };
}

export function wrapDocument(bodyHtml: string, opts: DocumentOptions): string {
  const { open, close } = documentShell(opts);
  return `${open}${bodyHtml}${close}`;
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
