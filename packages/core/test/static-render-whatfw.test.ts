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

  it('does not export builtinRenderToString anymore', async () => {
    const mod = await import('../src/static-render.js');
    expect((mod as Record<string, unknown>).builtinRenderToString).toBeUndefined();
  });
});
