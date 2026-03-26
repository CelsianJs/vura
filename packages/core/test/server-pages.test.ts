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
  it('includes page routes in generated server entry', () => {
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

    // Should include page route
    expect(entry).toContain('pageRoutes');
    expect(entry).toContain("pattern: '/dashboard'");
    // Should include inline renderer
    expect(entry).toContain('function renderToString');
    expect(entry).toContain('function wrapDocument');
    // Should include ISR cache
    expect(entry).toContain('_isrCache');
    // Should include page render function
    expect(entry).toContain('function renderPage');
    expect(entry).toContain('getServerData');
    // Should include page route matching
    expect(entry).toContain('function matchPageRoute');
  });

  it('includes ISR cache code for pages with revalidate', () => {
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

    expect(entry).toContain('isrGet');
    expect(entry).toContain('isrSet');
    expect(entry).toContain('revalidateMs');
  });

  it('skips page code when no server pages exist', () => {
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

    // Should NOT include page rendering code when only static pages
    expect(entry).not.toContain('pageRoutes');
    expect(entry).not.toContain('function renderPage');
  });
});
