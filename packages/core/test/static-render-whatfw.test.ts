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

  it('does not export builtinRenderToString anymore', async () => {
    const mod = await import('../src/static-render.js');
    expect((mod as Record<string, unknown>).builtinRenderToString).toBeUndefined();
  });
});
