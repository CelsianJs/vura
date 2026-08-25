import { describe, it, expect } from 'vitest';
import { renderStaticPages } from '../src/static-render.js';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { h } from 'what-framework';

describe('static render uses real what-framework renderToString', () => {
  it('renders signal-bearing components with hydration-correct output', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'vura-sr-'));
    const pages = [{
      filePath: 'src/pages/index.tsx', urlPattern: '/', mode: 'static' as const,
      hasGetServerData: false, config: {},
    }];
    const loadModule = async () => ({
      default: () => h('div', { class: 'home' }, h('h1', null, 'Vura on What')),
      page: { title: 'Home' },
    });
    const results = await renderStaticPages(pages, loadModule, outDir);
    expect(results[0]!.html).toContain('<div class="home"><h1>Vura on What</h1></div>');
    const written = await readFile(join(outDir, 'static', 'index.html'), 'utf-8');
    expect(written).toContain('<title>Home</title>');
  });

  it('warns when a page component returns a raw HTML string (it gets escaped)', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'vura-sr-'));
    const pages = [{
      filePath: 'src/pages/index.ts', urlPattern: '/', mode: 'static' as const,
      hasGetServerData: false, config: {},
    }];
    const loadModule = async () => ({
      default: () => '<main><h1>Oops</h1></main>',
    });
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
    try {
      const results = await renderStaticPages(pages, loadModule, outDir);
      // The string is escaped (safe default), and the author is told why.
      expect(results[0]!.html).toContain('&lt;main&gt;');
      expect(warnings.some(w => w.includes('returned an HTML string'))).toBe(true);
    } finally {
      console.warn = origWarn;
    }
  });

  it('names the page and route when a component throws during prerender', async () => {
    // Before this, the CLI printed only the thrown error's own message. A hook
    // failing during prerender reported "useSignal() can only be called inside
    // a component function" with no file, no route and no stack, for a project
    // that might have fifty pages.
    const outDir = await mkdtemp(join(tmpdir(), 'vura-sr-'));
    const pages = [{
      filePath: 'src/pages/broken.tsx', urlPattern: '/broken', mode: 'static' as const,
      hasLoader: false, hasGetServerData: false, config: {},
    }];
    const loadModule = async () => ({
      default: () => { throw new Error('boom from the component'); },
      page: {},
    });

    await expect(renderStaticPages(pages, loadModule, outDir)).rejects.toThrow(
      /src\/pages\/broken\.tsx \(\/broken\) failed to render at build time: boom from the component/,
    );
  });

  it('does not double-prefix a message that already names the page', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'vura-sr-'));
    const pages = [{
      filePath: 'src/pages/loader.tsx', urlPattern: '/loader', mode: 'static' as const,
      hasLoader: true, hasGetServerData: false, config: {},
    }];
    const loadModule = async () => ({
      default: () => h('div', null, 'x'),
      page: {},
      loader: async () => { throw new Error('[vura] already prefixed'); },
    });

    await expect(renderStaticPages(pages, loadModule, outDir)).rejects.toThrow(
      /^\[vura\] already prefixed$/,
    );
  });

  it('does not export builtinRenderToString anymore', async () => {
    const mod = await import('../src/static-render.js');
    expect((mod as Record<string, unknown>).builtinRenderToString).toBeUndefined();
  });
});
