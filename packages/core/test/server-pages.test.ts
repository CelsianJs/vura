import { describe, it, expect } from 'vitest';
import { generateServerEntry } from '../src/build.js';
import { extractPageConfig } from '../src/manifest.js';
import type { RouteManifest } from '../src/manifest.js';

describe('server-mode page detection', () => {
  it('detects getServerData export (function declaration)', () => {
    const source = `
      export const page = { mode: 'server' };
      export async function getServerData(ctx) { return { user: 'test' }; }
      export default function Page({ user }) { return <div>{user}</div>; }
    `;
    const result = extractPageConfig(source);
    expect(result.mode).toBe('server');
    expect(result.hasGetServerData).toBe(true);
  });

  it('detects getServerData export (const)', () => {
    const source = `
      export const page = { mode: 'server' };
      export const getServerData = async (ctx) => ({ user: 'test' });
      export default function Page({ user }) { return <div>{user}</div>; }
    `;
    const result = extractPageConfig(source);
    expect(result.hasGetServerData).toBe(true);
  });

  it('auto-detects server mode from getServerData', () => {
    const source = `
      export async function getServerData(ctx) { return {}; }
      export default function Page() { return <div>Hello</div>; }
    `;
    const result = extractPageConfig(source);
    expect(result.mode).toBe('server');
    expect(result.hasGetServerData).toBe(true);
  });

  it('returns false for pages without getServerData', () => {
    const source = `
      export const page = { mode: 'static' };
      export default function Page() { return <div>Hello</div>; }
    `;
    const result = extractPageConfig(source);
    expect(result.hasGetServerData).toBe(false);
  });

  it('extracts revalidate config for ISR', () => {
    const source = `
      export const page = { mode: 'server', revalidate: 60 };
      export default function Page() { return <div>Hello</div>; }
    `;
    const result = extractPageConfig(source);
    expect(result.mode).toBe('server');
    expect(result.config.revalidate).toBe(60);
  });

  it('extracts stream config', () => {
    const source = `
      export const page = { mode: 'server', stream: true };
      export default function Page() { return <div>Hello</div>; }
    `;
    const result = extractPageConfig(source);
    expect(result.config.stream).toBe(true);
  });
});

describe('server entry with page routes', () => {
  // Phase B: generateServerEntry emits a THIN wiring file — no inline renderers.
  // Behavioral checks verify the thin source wires pages to startVuraServer correctly.

  it('includes page routes in generated thin server entry', () => {
    const manifest: RouteManifest = {
      api: [
        {
          filePath: 'src/api/hello.ts',
          urlPattern: '/api/hello',
          methods: ['GET'],
          kind: 'serverless',
          config: {},
        },
      ],
      pages: [
        {
          filePath: 'src/pages/dashboard.tsx',
          urlPattern: '/dashboard',
          mode: 'server',
          hasGetServerData: true,
          config: { mode: 'server' },
        },
      ],
      timestamp: new Date().toISOString(),
    };

    const entry = generateServerEntry(manifest, '/project');

    // Thin entry: pages passed to startVuraServer, not inline code
    expect(entry).toContain('pages: [');
    expect(entry).toContain("urlPattern: '/dashboard'");
    expect(entry).toContain("import { startVuraServer } from '@celsian/vura-core'");
    // NOT inline renderers — those live in @celsian/vura-core runtime
    expect(entry).not.toContain('function renderToString');
    expect(entry).not.toContain('function wrapDocument');
    expect(entry).not.toContain('_isrCache');
    expect(entry).not.toContain('function renderPage');
    expect(entry).not.toContain('function matchPageRoute');
  });

  it('includes page module import for server pages', () => {
    const manifest: RouteManifest = {
      api: [],
      pages: [
        {
          filePath: 'src/pages/blog.tsx',
          urlPattern: '/blog',
          mode: 'server',
          hasGetServerData: false,
          config: { mode: 'server', revalidate: 60 },
        },
      ],
      timestamp: new Date().toISOString(),
    };

    const entry = generateServerEntry(manifest, '/project');

    // Thin entry imports the page module and passes it as `module`
    expect(entry).toMatch(/import \* as page_blog from/);
    expect(entry).toContain("urlPattern: '/blog'");
    expect(entry).toContain('module: page_blog');
  });

  it('skips page imports when no server pages exist', () => {
    const manifest: RouteManifest = {
      api: [
        {
          filePath: 'src/api/hello.ts',
          urlPattern: '/api/hello',
          methods: ['GET'],
          kind: 'serverless',
          config: {},
        },
      ],
      pages: [
        {
          filePath: 'src/pages/index.tsx',
          urlPattern: '/',
          mode: 'static',
          hasGetServerData: false,
          config: { mode: 'static' },
        },
      ],
      timestamp: new Date().toISOString(),
    };

    const entry = generateServerEntry(manifest, '/project');

    // Static pages are not SSR'd — no page module imports, empty pages array
    expect(entry).not.toMatch(/import \* as page_/);
    // pages array is still present but empty
    expect(entry).toContain('pages: [');
  });
});
