/**
 * The Cloudflare adapter serves pages.
 *
 * Before this suite existed the adapter read `manifest.api` and nothing else: a
 * build with four pages emitted an API-only Worker, exited 0, printed the page
 * table, and answered `/` with 404. Everything here executes the emitted
 * artifact rather than inspecting the generator, because the whole defect was
 * that the generator looked fine and the artifact was wrong.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { cloudflareAdapter } from '../src/index.js';
import type { AdapterBuildContext, PageRoute, RouteManifest } from '@celsian/vura-core';

const SERVER_PAGE = `import { useLoaderData } from '@celsian/vura-core';

export const page = { mode: 'server', title: 'Posts' };

export async function loader() {
  return { message: 'from-the-loader', at: Date.now() };
}

export default function PostsPage() {
  const data = useLoaderData();
  return <div class="posts"><h1>Posts</h1><p>LOADED:{data.message}</p></div>;
}
`;

function page(overrides: Partial<PageRoute> = {}): PageRoute {
  return {
    filePath: 'src/pages/posts.tsx',
    urlPattern: '/posts',
    mode: 'server',
    hasLoader: true,
    hasGetServerData: false,
    config: { mode: 'server' },
    ...overrides,
  };
}

/** A project with one prerendered page on disk and one server-mode page. */
function scaffold(pageSource = SERVER_PAGE): { root: string; ctx: AdapterBuildContext } {
  const root = mkdtempSync(join(tmpdir(), 'vura-cf-pages-'));
  mkdirSync(join(root, 'src', 'pages'), { recursive: true });
  writeFileSync(join(root, 'src', 'pages', 'posts.tsx'), pageSource);
  writeFileSync(join(root, 'src', 'pages', 'index.tsx'), "export const page = { mode: 'static' };\nexport default function Home() { return null; }\n");

  // `vura build` renders these before the adapter runs. The adapter reads them
  // off disk, so the test writes what that step would have written.
  mkdirSync(join(root, 'dist', 'static', '_then', 'pages'), { recursive: true });
  writeFileSync(join(root, 'dist', 'static', 'index.html'), '<!DOCTYPE html><h1>PRERENDERED HOME</h1>');
  writeFileSync(join(root, 'dist', 'static', '_then', 'pages', 'dashboard.abc.js'), '/* client bundle */');
  mkdirSync(join(root, 'dist', 'public'), { recursive: true });
  writeFileSync(join(root, 'dist', 'public', 'robots.txt'), 'User-agent: *\n');

  const outDir = join(root, 'dist');
  const manifest: RouteManifest = {
    api: [],
    pages: [page(), page({ filePath: 'src/pages/index.tsx', urlPattern: '/', mode: 'static', hasLoader: false, config: { mode: 'static' } })],
    layouts: [],
    timestamp: new Date().toISOString(),
  };
  return {
    root,
    ctx: {
      serverEntry: join(outDir, 'server', 'entry.js'),
      clientDir: join(outDir, 'client'),
      manifest,
      projectRoot: root,
      outDir,
    },
  };
}

/** Run a request through the emitted Worker entry in a real Node process. */
function fetchThroughWorker(entryPath: string, url: string): { status: number; body: string; contentType: string } {
  const source = `const mod = await import(${JSON.stringify(pathToFileURL(entryPath).href)});
const res = await mod.default.fetch(new Request(${JSON.stringify(url)}), {}, {});
process.stdout.write(JSON.stringify({ status: res.status, body: await res.text(), contentType: res.headers.get('content-type') || '' }));`;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' }));
}

describe('cloudflareAdapter pages', () => {
  it('serves a server-mode page, runs its loader, and emits the loader payload', async () => {
    const { root, ctx } = scaffold();
    try {
      await cloudflareAdapter({ name: 'w', compatibilityDate: '2026-05-10' }).buildEnd(ctx);

      const entryPath = join(root, 'dist', 'cloudflare', 'entry.js');
      expect(existsSync(join(root, 'dist', 'cloudflare', 'pages.js'))).toBe(true);

      const res = fetchThroughWorker(entryPath, 'https://example.com/posts');
      expect(res.status).toBe(200);
      expect(res.contentType).toContain('text/html');
      expect(res.body).toContain('LOADED:from-the-loader');
      expect(res.body).toContain('id="__VURA_LOADER__"');
      expect(res.body).toContain('<title>Posts</title>');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs the loader once per request, not once per build', async () => {
    const { root, ctx } = scaffold();
    try {
      await cloudflareAdapter({ name: 'w', compatibilityDate: '2026-05-10' }).buildEnd(ctx);
      const entryPath = join(root, 'dist', 'cloudflare', 'entry.js');
      const source = `const mod = await import(${JSON.stringify(pathToFileURL(entryPath).href)});
const read = async () => JSON.parse((await (await mod.default.fetch(new Request('https://example.com/posts'), {}, {})).text()).match(/__VURA_LOADER__" type="application\\/json">(.*?)<\\/script>/)[1]).page.at;
const first = await read();
await new Promise(r => setTimeout(r, 20));
process.stdout.write(JSON.stringify([first, await read()]));`;
      const [first, second] = JSON.parse(
        execFileSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' }),
      );
      expect(second).toBeGreaterThan(first);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('copies the prerendered tree and points wrangler.toml at it', async () => {
    const { root, ctx } = scaffold();
    try {
      await cloudflareAdapter({ name: 'w', compatibilityDate: '2026-05-10' }).buildEnd(ctx);

      const assets = join(root, 'dist', 'cloudflare', 'assets');
      expect(readFileSync(join(assets, 'index.html'), 'utf-8')).toContain('PRERENDERED HOME');
      expect(existsSync(join(assets, '_then', 'pages', 'dashboard.abc.js'))).toBe(true);
      expect(existsSync(join(assets, 'robots.txt'))).toBe(true);

      const toml = readFileSync(join(root, 'dist', 'cloudflare', 'wrangler.toml'), 'utf-8');
      expect(toml).toContain('[assets]');
      expect(toml).toContain('directory = "./assets"');
      // Pinned, because the default canonicalises /about to /about/ and the
      // Node server this same build emits serves /about.
      expect(toml).toContain('html_handling = "drop-trailing-slash"');
      // Load-bearing: it is what lets an unmatched path reach the Worker.
      expect(toml).toContain('not_found_handling = "none"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('drops an asset whose page was deleted since the last build', async () => {
    const { root, ctx } = scaffold();
    try {
      await cloudflareAdapter({ name: 'w', compatibilityDate: '2026-05-10' }).buildEnd(ctx);
      const stale = join(root, 'dist', 'cloudflare', 'assets', 'gone', 'index.html');
      mkdirSync(join(root, 'dist', 'cloudflare', 'assets', 'gone'), { recursive: true });
      writeFileSync(stale, '<h1>deleted page</h1>');

      await cloudflareAdapter({ name: 'w', compatibilityDate: '2026-05-10' }).buildEnd(ctx);
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(join(root, 'dist', 'cloudflare', 'assets', 'index.html'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('splits the 404 the way the Node server does: JSON under /api/, the 404 page elsewhere', async () => {
    const { root, ctx } = scaffold();
    try {
      await cloudflareAdapter({ name: 'w', compatibilityDate: '2026-05-10' }).buildEnd(ctx);
      const entryPath = join(root, 'dist', 'cloudflare', 'entry.js');

      const apiMiss = fetchThroughWorker(entryPath, 'https://example.com/api/nope');
      expect(apiMiss.status).toBe(404);
      expect(JSON.parse(apiMiss.body).error).toBe('Not Found');

      const pageMiss = fetchThroughWorker(entryPath, 'https://example.com/nope');
      expect(pageMiss.status).toBe(404);
      expect(pageMiss.contentType).toContain('text/html');
      expect(pageMiss.body).toContain('404');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('serves prerendered-only projects without emitting a page renderer', async () => {
    const { root, ctx } = scaffold();
    try {
      // Every page is prerendered: Workers Static Assets answers all of them,
      // so there is nothing for a Worker-side renderer to do.
      ctx.manifest.pages = ctx.manifest.pages.filter(p => p.mode !== 'server');
      await cloudflareAdapter({ name: 'w', compatibilityDate: '2026-05-10' }).buildEnd(ctx);

      expect(existsSync(join(root, 'dist', 'cloudflare', 'pages.js'))).toBe(false);
      expect(readFileSync(join(root, 'dist', 'cloudflare', 'wrangler.toml'), 'utf-8')).toContain('[assets]');
      // The 404 still has to be the page, not the API's JSON — the project has
      // pages, they are just all files.
      const miss = fetchThroughWorker(join(root, 'dist', 'cloudflare', 'entry.js'), 'https://example.com/nope');
      expect(miss.status).toBe(404);
      expect(miss.contentType).toContain('text/html');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('stops shipping the renderer when the last server-mode page is deleted', async () => {
    const { root, ctx } = scaffold();
    try {
      await cloudflareAdapter({ name: 'w', compatibilityDate: '2026-05-10' }).buildEnd(ctx);
      expect(existsSync(join(root, 'dist', 'cloudflare', 'pages.js'))).toBe(true);

      ctx.manifest.pages = ctx.manifest.pages.filter(p => p.mode !== 'server');
      await cloudflareAdapter({ name: 'w', compatibilityDate: '2026-05-10' }).buildEnd(ctx);
      expect(existsSync(join(root, 'dist', 'cloudflare', 'pages.js'))).toBe(false);
      expect(existsSync(join(root, 'dist', 'cloudflare', 'pages.source.mjs'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves an API-only Worker with nothing to serve exactly as it was', async () => {
    const { root, ctx } = scaffold();
    try {
      ctx.manifest.pages = [];
      rmSync(join(root, 'dist', 'static'), { recursive: true, force: true });
      rmSync(join(root, 'dist', 'public'), { recursive: true, force: true });
      await cloudflareAdapter({ name: 'w', compatibilityDate: '2026-05-10' }).buildEnd(ctx);

      const toml = readFileSync(join(root, 'dist', 'cloudflare', 'wrangler.toml'), 'utf-8');
      expect(toml).not.toContain('[assets]');
      expect(existsSync(join(root, 'dist', 'cloudflare', 'pages.js'))).toBe(false);

      // A Worker with no page surface keeps the JSON 404 it has always
      // returned. Matching the Node server's HTML 404 here would change an
      // API-only deployment's error shape for no page-serving benefit.
      const miss = fetchThroughWorker(join(root, 'dist', 'cloudflare', 'entry.js'), 'https://example.com/nope');
      expect(miss.status).toBe(404);
      expect(JSON.parse(miss.body)).toEqual({ error: 'Not Found', path: '/nope' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('serves public/ files even when the project has no pages at all', async () => {
    // The Node server serves dist/public whether or not the project has pages,
    // so a Worker for an API-only project with a public/ directory gets the
    // same files. They were dropped along with everything else.
    const { root, ctx } = scaffold();
    try {
      ctx.manifest.pages = [];
      rmSync(join(root, 'dist', 'static'), { recursive: true, force: true });
      await cloudflareAdapter({ name: 'w', compatibilityDate: '2026-05-10' }).buildEnd(ctx);

      expect(readFileSync(join(root, 'dist', 'cloudflare', 'wrangler.toml'), 'utf-8')).toContain('[assets]');
      expect(existsSync(join(root, 'dist', 'cloudflare', 'assets', 'robots.txt'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails the build by name when a page cannot run on Workers', async () => {
    const { root, ctx } = scaffold(
      "import { readFileSync } from 'node:fs';\n" +
      "export const page = { mode: 'server' };\n" +
      'export default function P() { return readFileSync; }\n',
    );
    try {
      await expect(
        cloudflareAdapter({ name: 'w', compatibilityDate: '2026-05-10' }).buildEnd(ctx),
      ).rejects.toThrow(/src\/pages\/posts\.tsx/);
      await expect(
        cloudflareAdapter({ name: 'w', compatibilityDate: '2026-05-10' }).buildEnd(ctx),
      ).rejects.toThrow(/could not be bundled for Cloudflare Workers/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
