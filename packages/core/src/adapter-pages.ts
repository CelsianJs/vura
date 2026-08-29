/**
 * Page emission for the serverless adapters.
 *
 * The Cloudflare and Lambda adapters used to read `manifest.api` and nothing
 * else. A build for either target printed the full page table, emitted the API
 * artifacts, and dropped every page on the floor: `/` came back 404 from
 * `wrangler dev` and 403 from API Gateway while the build exited 0. This module
 * is what they emit pages with, and it is shared rather than copied because the
 * runtime-shim allowlist in the sibling file records what three copies of one
 * list cost the last time.
 *
 * The Node server is the reference implementation, and it splits pages two ways:
 *
 *   - `mode: 'static' | 'client' | 'hybrid'` are rendered at build time into
 *     `dist/static/`, and the server serves them as files out of
 *     `[dist/public, dist/static]`. An adapter needs a *file* story, not a
 *     render story: {@link collectPageAssets}.
 *   - `mode: 'server'` is rendered per request by `createPagesHandler`, which
 *     is a WinterCG `(Request) => Response` and therefore already the right
 *     shape for a Worker and for a Lambda behind API Gateway.
 *     {@link generatePagesModuleSource} wires exactly that.
 *
 * Both adapters bundle the generated module with `platform: 'neutral'`, so the
 * emitted page handler is the same artifact on both targets and neither can
 * quietly acquire a Node dependency the other cannot run.
 */

import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import type { PageRoute, RouteManifest } from './manifest.js';
import { vuraCoreRuntimeShimContents, coreModuleExt } from './runtime-shim.js';

/** Pages rendered per request, in the order the manifest lists them. */
export function serverPagesOf(manifest: RouteManifest): PageRoute[] {
  return manifest.pages.filter(p => p.mode === 'server');
}

/** Pages the build already rendered to `dist/static`, served as files. */
export function prerenderedPagesOf(manifest: RouteManifest): PageRoute[] {
  return manifest.pages.filter(p => p.mode !== 'server');
}

// ─── Loud degradations ───

/**
 * Everything a serverless target serves *differently* from the Node server,
 * named page by page.
 *
 * This exists because the defect being fixed was silence, not absence. A build
 * that prints a page table and then serves none of it is worse than one that
 * refuses, so anything still degraded here has to say so by name. `target` is
 * the human label used in the message, e.g. `'Cloudflare Workers'`.
 */
export function pageDegradations(manifest: RouteManifest, target: string): string[] {
  const warnings: string[] = [];

  const isr = serverPagesOf(manifest).filter(p => typeof p.config.revalidate === 'number');
  if (isr.length > 0) {
    warnings.push(
      `[vura] ${isr.length} page(s) declare \`revalidate\` but ${target} has no ISR cache attached, ` +
      `so they render on every request instead of being cached: ${isr.map(p => p.urlPattern).join(', ')}. ` +
      'Put a CDN in front, or deploy them to a persistent host (see /self-host/).',
    );
  }

  return warnings;
}

// ─── Generated page module ───

/**
 * The `@celsian/vura-core` surface a generated pages module is allowed to
 * import.
 *
 * The base group (no Node built-ins) plus the loader and page runtimes. It is
 * deliberately NOT the full server group: that one reaches `runtime/server.ts`
 * (node:http), `auth.ts` (node:crypto) and `streaming.ts` (node:fs), none of
 * which resolve under `platform: 'neutral'`. What is added here is what a page
 * and its layouts actually touch.
 */
export function pagesRuntimeShimContents(packageDir: string): string {
  const ext = (mod: string) => coreModuleExt(mod, packageDir);
  return vuraCoreRuntimeShimContents({ packageDir, includeServerRuntime: false }) + [
    `export { useLoaderData, readLoaderPayload, LoaderDataProvider, LOADER_PAYLOAD_ID, createLoaderContext, runLoaderChain, serializeLoaderPayload, isLoaderNotFound, isLoaderRedirect, LoaderNotFoundError, LoaderRedirectError } from './runtime/loader.${ext('runtime/loader')}';`,
    `export { buildWhatRoutes, createPagesHandler, createVuraRenderRoute, createVuraStreamRoute, isStreamingPage } from './runtime/pages.${ext('runtime/pages')}';`,
    `export { compilePageRoutes, matchPageRoute } from './match.${ext('match')}';`,
    `export { documentShell, wrapDocument, escapeHtml } from './document.${ext('document')}';`,
    '',
  ].join('\n');
}

/** An import specifier for `absPath` relative to a file in `fromDir`. */
function relativeSpecifier(fromDir: string, absPath: string): string {
  const rel = relative(fromDir, absPath).split(sep).join('/');
  return rel.startsWith('.') ? rel : `./${rel}`;
}

/**
 * The thin source for a target's pages module.
 *
 * Written to disk next to its bundle for the same reason core writes
 * `entry.source.mjs`: when a page fails to render in production, the generated
 * wiring is the first thing worth reading, and a minified bundle is not it.
 *
 * `matchesPage` is exported alongside the handler so a caller can ask "is this
 * path one of mine?" without inferring it from a 404. The Worker entry needs
 * that distinction: an unmatched path there is an API 404, and what-fw's
 * handler answers unmatched paths with an HTML 404 of its own.
 */
export function generatePagesModuleSource(
  pages: PageRoute[],
  projectRoot: string,
  sourceDir: string,
): string {
  const layoutPaths: string[] = [];
  for (const page of pages) {
    for (const lp of page.layouts ?? []) {
      if (!layoutPaths.includes(lp)) layoutPaths.push(lp);
    }
  }

  const lines: string[] = [
    '// Generated by the Vura adapter — hand-edits are overwritten on the next build.',
    "import { buildWhatRoutes, createPagesHandler, compilePageRoutes, matchPageRoute } from '@celsian/vura-core';",
  ];

  pages.forEach((page, i) => {
    lines.push(`import * as _page${i} from '${relativeSpecifier(sourceDir, join(projectRoot, page.filePath))}';`);
  });
  layoutPaths.forEach((lp, i) => {
    lines.push(`import * as _layout${i} from '${relativeSpecifier(sourceDir, join(projectRoot, lp))}';`);
  });

  lines.push('');
  lines.push('const pages = [');
  pages.forEach((page, i) => {
    const layoutModules = (page.layouts ?? [])
      .map(lp => `_layout${layoutPaths.indexOf(lp)}`)
      .join(', ');
    lines.push(
      `  { urlPattern: ${JSON.stringify(page.urlPattern)}, filePath: ${JSON.stringify(page.filePath)}, ` +
      `mode: ${JSON.stringify(page.mode)}, config: ${JSON.stringify(page.config ?? {})}, ` +
      `hasLoader: ${!!page.hasLoader}, hasGetServerData: ${!!page.hasGetServerData}, ` +
      `layouts: ${JSON.stringify(page.layouts ?? [])}, layoutModules: [${layoutModules}], module: _page${i} },`,
    );
  });
  lines.push('];');
  lines.push('');
  lines.push('const compiled = compilePageRoutes(pages);');
  lines.push('const handler = createPagesHandler({ routes: buildWhatRoutes(pages) });');
  lines.push('');
  lines.push('export function matchesPage(pathname) {');
  lines.push('  return matchPageRoute(compiled, pathname) !== null;');
  lines.push('}');
  lines.push('');
  lines.push('export function handlePage(request) {');
  lines.push('  return handler(request);');
  lines.push('}');
  lines.push('');

  return lines.join('\n');
}

/**
 * Bundle a generated pages module into one self-contained ESM file.
 *
 * `what-framework` is INLINED here, unlike in a route bundle where the adapters
 * keep it external. A page is a What component and the renderer is What's own
 * `renderToString`; neither target has a `node_modules` to resolve it from at
 * runtime. One bundle also means one copy of What and one copy of vura-core, so
 * the context `LoaderDataProvider` writes is the context `useLoaderData` reads
 * — two bundles would give a page its own registry and `useLoaderData` would
 * report being called outside a render.
 *
 * A failure here is thrown, never warned over: the caller turns it into a named
 * build error. A page that cannot be bundled is a page the target cannot serve,
 * and shipping the build anyway is the exact defect this module exists to close.
 */
export async function bundlePagesModule(options: {
  sourcePath: string;
  outfile: string;
  projectRoot: string;
  corePackageDir: string;
}): Promise<void> {
  const { sourcePath, outfile, projectRoot, corePackageDir } = options;
  const { build: esbuild } = await import('esbuild');
  const shim = pagesRuntimeShimContents(corePackageDir);
  const ext = (mod: string) => coreModuleExt(mod, corePackageDir);

  await mkdir(dirname(outfile), { recursive: true });
  await esbuild({
    entryPoints: [sourcePath],
    bundle: true,
    format: 'esm',
    target: 'es2022',
    platform: 'neutral',
    outfile,
    jsx: 'automatic',
    jsxImportSource: '@celsian/vura-core',
    absWorkingDir: projectRoot,
    nodePaths: [join(projectRoot, 'node_modules'), join(process.cwd(), 'node_modules')],
    // what-server's package exports name a `node` condition that resolves to a
    // build importing node:async_hooks. `platform: 'neutral'` does not request
    // that condition, so this picks the runtime-neutral entry — the one that
    // exports createRequestHandler and createCloudflareHandler.
    plugins: [{
      name: 'vura-core-pages-shim',
      setup(build: any) {
        build.onResolve({ filter: /^@celsian\/vura-core\/(jsx-runtime|jsx-dev-runtime)$/ }, () => ({
          path: join(corePackageDir, `jsx-runtime.${ext('jsx-runtime')}`),
        }));
        build.onResolve({ filter: /^@celsian\/vura-core\/client$/ }, () => ({
          path: join(corePackageDir, `client.${ext('client')}`),
        }));
        build.onResolve({ filter: /^@celsian\/vura-core$/ }, () => ({
          path: '@celsian/vura-core',
          namespace: 'vura-core-pages-shim',
        }));
        build.onLoad({ filter: /.*/, namespace: 'vura-core-pages-shim' }, () => ({
          loader: 'js',
          resolveDir: corePackageDir,
          contents: shim,
        }));
      },
    }],
    // what-server reads process.env.NODE_ENV on its CSRF-cookie path. Vura
    // passes csrf:false so that branch never runs, but a bare `process` in a
    // Worker is a ReferenceError at module scope if anything else reaches for
    // it, and the cost of the shim is one line.
    banner: { js: 'const process = globalThis.process || { env: {} };' },
  });
}

// ─── Prerendered assets ───

export interface PageAsset {
  /** URL path the Node server serves this file at, e.g. `/about/index.html`. */
  urlPath: string;
  /** Absolute source path under dist/. */
  sourcePath: string;
  bytes: number;
}

/**
 * Every file the Node server would serve from `dist/public` and `dist/static`.
 *
 * Order matches `staticDirs: [publicDir, staticDir]` in the generated server
 * entry: a name present in both resolves to the `public/` copy, so `public`
 * is walked last and overwrites.
 */
export async function collectPageAssets(outDir: string): Promise<PageAsset[]> {
  const byUrlPath = new Map<string, PageAsset>();

  for (const dirName of ['static', 'public']) {
    const root = join(outDir, dirName);
    if (!existsSync(root)) continue;
    await walk(root, root, byUrlPath);
  }

  return [...byUrlPath.values()];
}

async function walk(root: string, dir: string, out: Map<string, PageAsset>): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(root, full, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const urlPath = '/' + relative(root, full).split(sep).join('/');
    out.set(urlPath, { urlPath, sourcePath: full, bytes: (await stat(full)).size });
  }
}

/**
 * Copy the prerendered tree into a target's own output directory.
 *
 * Adapters cannot point at `dist/static` from their artifact: `wrangler deploy`
 * uploads an assets directory and `sam deploy` uploads a CodeUri directory, and
 * neither reaches a sibling. Returns the emitted absolute paths so the caller
 * can hand them to `pruneStaleOutputs` — a page deleted from `src/` must stop
 * being deployed, and its HTML lives here, not in `routes/`.
 */
export async function copyPageAssets(assets: PageAsset[], destDir: string): Promise<Set<string>> {
  const written = new Set<string>();
  for (const asset of assets) {
    const dest = join(destDir, ...asset.urlPath.slice(1).split('/'));
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, await readFile(asset.sourcePath));
    written.add(dest);
  }
  return written;
}
