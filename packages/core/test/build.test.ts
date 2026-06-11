/**
 * Tests for the build pipeline — generateServerEntry (thin wiring file),
 * generateFunctionEntry, and the build() bundling step.
 *
 * Phase B change: generateServerEntry now emits a THIN wiring file that
 * imports startVuraServer from @celsian/vura-core instead of inlining all
 * runtime code.  build() esbuild-bundles that thin source into a self-
 * contained entry.js.  These tests verify the thin source structure and the
 * bundling outcome.
 */

import { describe, it, expect } from 'vitest';
import { generateServerEntry, generateFunctionEntry } from '../src/build.js';
import type { RouteManifest, ApiRoute, PageRoute } from '../src/manifest.js';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ─── generateServerEntry (thin wiring) ───

describe('generateServerEntry — thin wiring file structure', () => {
  const manifest: RouteManifest = {
    api: [
      {
        filePath: 'src/api/hello.ts',
        urlPattern: '/api/hello',
        methods: ['GET'],
        kind: 'serverless',
        config: {},
      },
      {
        filePath: 'src/api/users/index.ts',
        urlPattern: '/api/users',
        methods: ['GET', 'POST'],
        kind: 'serverless',
        config: {},
      },
    ],
    pages: [],
    layouts: [],
    timestamp: new Date().toISOString(),
  };

  it('imports startVuraServer from @celsian/vura-core', () => {
    const entry = generateServerEntry(manifest, '/project');
    expect(entry).toContain("import { startVuraServer } from '@celsian/vura-core'");
  });

  it('imports route modules with correct relative paths', () => {
    const entry = generateServerEntry(manifest, '/project');
    expect(entry).toMatch(/import \* as route_api_hello from/);
    expect(entry).toMatch(/import \* as route_api_users from/);
  });

  it('calls await startVuraServer with apiRoutes', () => {
    const entry = generateServerEntry(manifest, '/project');
    expect(entry).toContain('await startVuraServer({');
    expect(entry).toContain('apiRoutes: [');
    expect(entry).toContain("urlPattern: '/api/hello'");
    expect(entry).toContain("urlPattern: '/api/users'");
  });

  it('includes port from PORT env var', () => {
    const entry = generateServerEntry(manifest, '/project');
    expect(entry).toContain("process.env.PORT || '3000'");
  });

  it('includes staticDirs with public and static dirs', () => {
    const entry = generateServerEntry(manifest, '/project');
    expect(entry).toContain('staticDirs:');
    expect(entry).toContain("'..', 'public'");
    expect(entry).toContain("'..', 'static'");
  });

  it('includes installSignalHandlers: true', () => {
    const entry = generateServerEntry(manifest, '/project');
    expect(entry).toContain('installSignalHandlers: true');
  });

  it('includes VURA_REVALIDATE_SECRET for cache config', () => {
    const entry = generateServerEntry(manifest, '/project');
    expect(entry).toContain('VURA_REVALIDATE_SECRET');
  });

  it('emits thin source that is syntactically valid ESM (after stripping imports/await)', () => {
    const entry = generateServerEntry(manifest, '/project');
    // Strip ESM-only syntax for new Function() parse check.
    // Wrap in an async function so top-level await is valid.
    const stripped = entry
      .replace(/^import\s.*$/gm, '// [import stripped]')
      .replace(/^export\s.*$/gm, '// [export stripped]')
      .replace(/import\.meta\.\w+/g, '"__stripped__"');

    // Wrap in an async function body — new Function() supports async functions
    const wrapped = `return (async function _vuraEntryCheck() {\n${stripped}\n})`;

    let parseError: Error | null = null;
    try { new Function(wrapped); } catch (err) { parseError = err as Error; }
    expect(parseError, `Syntax error: ${parseError?.message}`).toBeNull();
  });

  it('writes thin source to a file without error', () => {
    const entry = generateServerEntry(manifest, '/project');
    const tmpDir = mkdtempSync(join(tmpdir(), 'vura-build-test-'));
    try {
      writeFileSync(join(tmpDir, 'entry.source.mjs'), entry);
      expect(true).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('does NOT contain old inline codegen patterns (thin, not fat)', () => {
    const entry = generateServerEntry(manifest, '/project');
    expect(entry).not.toContain('function _log(');
    expect(entry).not.toContain('function parseBody(');
    expect(entry).not.toContain('function matchRoute(');
    expect(entry).not.toContain('_gracefulShutdown');
    expect(entry).not.toContain('isrGet');
    expect(entry).not.toContain('_validateRequest');
    expect(entry).not.toContain('_executeWithHooks');
    expect(entry).not.toContain('function renderToString');
    expect(entry).not.toContain('enqueueTask');
  });
});

describe('generateServerEntry — pages and layouts wiring', () => {
  const manifest: RouteManifest = {
    api: [],
    pages: [
      {
        filePath: 'src/pages/index.tsx',
        urlPattern: '/',
        mode: 'server',
        hasGetServerData: false,
        config: { title: 'Home', mode: 'server' },
        layouts: ['src/pages/_layout.tsx'],
      } as PageRoute,
    ],
    layouts: [{ filePath: 'src/pages/_layout.tsx', urlPattern: '/', dirPattern: '' }],
    timestamp: new Date().toISOString(),
  };

  it('imports page and layout modules', () => {
    const entry = generateServerEntry(manifest, '/project');
    expect(entry).toMatch(/import \* as page_index from/);
    expect(entry).toMatch(/import \* as layout_/);
  });

  it('wires pages with layoutModules array', () => {
    const entry = generateServerEntry(manifest, '/project');
    expect(entry).toContain('pages: [');
    expect(entry).toContain('layoutModules:');
    expect(entry).toContain("urlPattern: '/'");
  });
});

describe('generateServerEntry — global hooks', () => {
  const manifest: RouteManifest = {
    api: [{ filePath: 'src/api/hello.ts', urlPattern: '/api/hello', methods: ['GET'], kind: 'serverless', config: {} }],
    pages: [],
    layouts: [],
    timestamp: new Date().toISOString(),
  };

  it('does NOT import globalHooksMod when no hooks file', () => {
    const entry = generateServerEntry(manifest, '/project');
    expect(entry).not.toContain('_globalHooksMod');
    expect(entry).toContain('globalHooks: undefined');
  });

  it('imports globalHooksMod and wires globalHooks when hooks file provided', () => {
    const entry = generateServerEntry(manifest, '/project', 'src/api/_hooks.ts');
    expect(entry).toContain("import * as _globalHooksMod from");
    expect(entry).toContain('_globalHooksMod.onRequest');
    expect(entry).toContain('_globalHooksMod.onError');
    expect(entry).toContain('_globalHooksMod.onResponse');
    expect(entry).not.toContain('globalHooks: undefined');
  });
});

// ─── generateFunctionEntry ───

describe('generateFunctionEntry', () => {
  it('generates a self-contained serverless handler', () => {
    const route: ApiRoute = {
      filePath: 'src/api/hello.ts',
      urlPattern: '/api/hello',
      methods: ['GET'],
      kind: 'serverless',
      config: {},
    };

    const entry = generateFunctionEntry(route, '/project');

    expect(entry).not.toContain('@celsian/core');
    expect(entry).toContain('export default');
    expect(entry).toContain('async fetch(request)');
    expect(entry).toContain('function parseBody');
    expect(entry).toContain('status(code)');
    expect(entry).toContain('json(data)');
  });

  it('maps multiple methods to handler lookup', () => {
    const route: ApiRoute = {
      filePath: 'src/api/users/index.ts',
      urlPattern: '/api/users',
      methods: ['GET', 'POST'],
      kind: 'serverless',
      config: {},
    };

    const entry = generateFunctionEntry(route, '/project');
    expect(entry).toContain('GET:');
    expect(entry).toContain('POST:');
  });
});

// ─── build() bundling error reporting ───

describe('build route artifact bundling failures', () => {
  it('fails with route context when a manifest route source is missing', async () => {
    const { build } = await import('../src/build.js');
    const root = mkdtempSync(join(tmpdir(), 'then-missing-route-'));
    try {
      const manifest: RouteManifest = {
        api: [{
          filePath: 'src/api/missing.ts',
          urlPattern: '/api/missing',
          methods: ['GET'],
          kind: 'serverless',
          config: {},
        }],
        pages: [],
        layouts: [],
        timestamp: new Date().toISOString(),
      };

      await expect(build(manifest, {}, root)).rejects.toThrow(
        /Route source not found for src\/api\/missing\.ts:/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
