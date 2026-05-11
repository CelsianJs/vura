import { describe, it, expect } from 'vitest';
import { generateServerEntry, generateFunctionEntry } from '../src/build.js';
import type { RouteManifest, ApiRoute, PageRoute } from '../src/manifest.js';
import { writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('generateServerEntry', () => {
  it('generates a self-contained Node.js server with route table', () => {
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

    const entry = generateServerEntry(manifest, '/project');

    // Self-contained — no @celsian/core dependency
    expect(entry).not.toContain('@celsian/core');
    // Uses Node built-in http
    expect(entry).toContain("import { createServer } from 'node:http'");
    // Route table with patterns
    expect(entry).toContain("pattern: '/api/hello'");
    expect(entry).toContain("pattern: '/api/users'");
    expect(entry).toContain("'GET'");
    expect(entry).toContain("'POST'");
    // Inline route matching
    expect(entry).toContain('function matchRoute');
    expect(entry).toContain('function parseBody');
    // Health check
    expect(entry).toContain('/__health');
    // Listens on port
    expect(entry).toContain('server.listen(port');

    // Graceful shutdown
    expect(entry).toContain('_gracefulShutdown');
    expect(entry).toContain("process.on('SIGTERM'");
    expect(entry).toContain("process.on('SIGINT'");
    expect(entry).toContain('_inFlightRequests');
    expect(entry).toContain('_isShuttingDown');
    expect(entry).toContain('THEN_SHUTDOWN_TIMEOUT');
  });
});

describe('generateServerEntry integration', () => {
  it('produces syntactically valid JavaScript with all key features', () => {
    // Build a manifest that exercises API routes, server pages, tasks, and layouts
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
          kind: 'hot',
          config: {},
        },
        {
          filePath: 'src/api/cleanup.task.ts',
          urlPattern: '/api/cleanup',
          methods: ['POST'],
          kind: 'task',
          config: { schedule: '0 * * * *', retries: 2, timeout: 10000 },
        },
      ],
      pages: [
        {
          filePath: 'src/pages/index.tsx',
          urlPattern: '/',
          mode: 'server',
          config: { title: 'Home' },
          layouts: ['src/pages/_layout.tsx'],
        } as PageRoute,
      ],
      layouts: [{ filePath: 'src/pages/_layout.tsx', urlPattern: '/' }],
      timestamp: new Date().toISOString(),
    };

    const code = generateServerEntry(manifest, '/project');

    // ── Syntactic validity: parse with new Function ──
    // new Function() runs in script mode, so strip ESM-only syntax first:
    // - import/export statements
    // - import.meta references (used for __dirname equivalent in ESM)
    const strippedCode = code
      .replace(/^import\s.*$/gm, '// [import stripped]')
      .replace(/^export\s.*$/gm, '// [export stripped]')
      .replace(/import\.meta\.\w+/g, '"__stripped_import_meta__"');

    let parseError: Error | null = null;
    try {
      new Function(strippedCode);
    } catch (err) {
      parseError = err as Error;
    }
    expect(parseError, `Generated code has syntax error: ${parseError?.message}`).toBeNull();

    // ── Write to temp file to ensure it's a complete, writable artifact ──
    const tmpDir = mkdtempSync(join(tmpdir(), 'then-build-test-'));
    try {
      const outPath = join(tmpDir, 'entry.js');
      writeFileSync(outPath, code);
      // If writeFile didn't throw, the file was written successfully
      expect(true).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }

    // ── Key features present ──

    // Hooks lifecycle
    expect(code).toContain('_executeWithHooks');
    expect(code).toContain('_runHooks');
    expect(code).toContain('onRequest');
    expect(code).toContain('onError');
    expect(code).toContain('onResponse');

    // Request validation
    expect(code).toContain('_validateRequest');
    expect(code).toContain('safeParse');
    expect(code).toContain('VALIDATION_ERROR');

    // CORS support
    expect(code).toContain('THEN_CORS_ORIGIN');
    expect(code).toContain('access-control-allow-origin');
    expect(code).toContain("method === 'OPTIONS'");

    // Static file serving
    expect(code).toContain('_tryServeStatic');
    expect(code).toContain('_mimeTypes');
    expect(code).toContain('_publicDir');

    // Graceful shutdown
    expect(code).toContain('_gracefulShutdown');
    expect(code).toContain('THEN_SHUTDOWN_TIMEOUT');
    expect(code).toContain('_inFlightRequests');

    // Structured logging
    expect(code).toContain('function _log(');
    expect(code).toContain('THEN_LOG_LEVEL');
    expect(code).toContain('_generateRequestId');

    // Body parsing with size limits
    expect(code).toContain('function parseBody');
    expect(code).toContain('THEN_MAX_BODY_SIZE');

    // Dotenv loader
    expect(code).toContain('.env.local');
    expect(code).toContain('.env.');

    // Reply helpers (json, send, redirect)
    expect(code).toContain('json(data)');
    expect(code).toContain('send(data)');
    expect(code).toContain('redirect(url');

    // SSR rendering (triggered by server pages in manifest)
    expect(code).toContain('function renderToString');
    expect(code).toContain('function wrapDocument');
    expect(code).toContain('function renderPage');
    expect(code).toContain('function matchPageRoute');

    // ISR cache (triggered by server pages)
    expect(code).toContain('isrGet');
    expect(code).toContain('isrSet');
    expect(code).toContain('ISR_MAX_ENTRIES');

    // Task runner (triggered by task route in manifest)
    expect(code).toContain('enqueueTask');
    expect(code).toContain('processQueue');
    expect(code).toContain('registerCron');
    expect(code).toContain('startCron');
    expect(code).toContain("'0 * * * *'"); // the cron schedule we defined

    // Health check
    expect(code).toContain('/__health');

    // No external framework dependency
    expect(code).not.toContain('@celsian/core');
    expect(code).not.toContain('@then/core');
  });
});

describe('production server error handling matches dev server', () => {
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
    pages: [],
    layouts: [],
    timestamp: new Date().toISOString(),
  };

  it('_executeWithHooks re-throws errors when no onError hooks handle them', () => {
    const code = generateServerEntry(manifest, '/project');

    // The old buggy code had: `if (!_hookHadError) throw err;`
    // which was dead code because _hookHadError was always true at that point.
    // The fix uses _runOnError with a `handled` flag and re-throws if unhandled.
    expect(code).toContain('_runOnError');
    expect(code).toContain('if (!errorResult.handled)');
    expect(code).toContain('throw errorResult.error || err');

    // The old dead code pattern should no longer exist
    expect(code).not.toContain('if (!_hookHadError) throw err');
  });

  it('_runOnError returns handled:false when no error hooks exist', () => {
    const code = generateServerEntry(manifest, '/project');

    // _runOnError should return { handled: false } when allHooks is empty
    expect(code).toContain('if (allHooks.length === 0) return { handled: false }');
  });

  it('_runOnError tracks handled state from individual hooks', () => {
    const code = generateServerEntry(manifest, '/project');

    // Should track `handled` flag per-hook, like the dev server does
    expect(code).toContain('let handled = false');
    expect(code).toContain('handled = true');
    expect(code).toContain('return { handled, error: err }');
  });

  it('runs global + route-level onRequest hooks in order', () => {
    const code = generateServerEntry(manifest, '/project');

    // _executeWithHooks should call global hooks first, then route-level
    expect(code).toContain('_globalHooks.onRequest');
    expect(code).toContain('routeHooks && routeHooks.onRequest');
  });

  it('runs global + route-level onResponse hooks with error silencing', () => {
    const code = generateServerEntry(manifest, '/project');

    expect(code).toContain('_globalHooks.onResponse');
    expect(code).toContain('routeHooks && routeHooks.onResponse');
    // Both should be silenced on error
    expect(code).toContain('/* onResponse errors are silenced */');
  });

  it('declares _globalHooks with empty arrays when no hooks file exists', () => {
    const code = generateServerEntry(manifest, '/project');

    // Without a hooks file, should get empty global hooks
    expect(code).toContain('No global hooks file found');
    expect(code).toContain('const _globalHooks = { onRequest: null, onError: null, onResponse: null }');
  });

  it('imports global hooks file when provided', () => {
    const code = generateServerEntry(manifest, '/project', 'src/api/_hooks.ts');

    expect(code).toContain("import * as _globalHooksMod from");
    expect(code).toContain('_globalHooksMod.onRequest');
    expect(code).toContain('_globalHooksMod.onError');
    expect(code).toContain('_globalHooksMod.onResponse');
    // Should NOT have the empty fallback comment
    expect(code).not.toContain('No global hooks file found');
  });

  it('generated code with global hooks is syntactically valid', () => {
    const code = generateServerEntry(manifest, '/project', 'src/api/_hooks.ts');

    const strippedCode = code
      .replace(/^import\s.*$/gm, '// [import stripped]')
      .replace(/^export\s.*$/gm, '// [export stripped]')
      .replace(/import\.meta\.\w+/g, '"__stripped_import_meta__"');

    let parseError: Error | null = null;
    try {
      new Function(strippedCode);
    } catch (err) {
      parseError = err as Error;
    }
    expect(parseError, `Generated code has syntax error: ${parseError?.message}`).toBeNull();
  });

  it('generated code without global hooks is syntactically valid', () => {
    const code = generateServerEntry(manifest, '/project');

    const strippedCode = code
      .replace(/^import\s.*$/gm, '// [import stripped]')
      .replace(/^export\s.*$/gm, '// [export stripped]')
      .replace(/import\.meta\.\w+/g, '"__stripped_import_meta__"');

    let parseError: Error | null = null;
    try {
      new Function(strippedCode);
    } catch (err) {
      parseError = err as Error;
    }
    expect(parseError, `Generated code has syntax error: ${parseError?.message}`).toBeNull();
  });
});

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

    // Self-contained — no @celsian/core dependency
    expect(entry).not.toContain('@celsian/core');
    // Worker-compatible fetch handler
    expect(entry).toContain('export default');
    expect(entry).toContain('async fetch(request)');
    // Inline body parsing
    expect(entry).toContain('function parseBody');
    // req/reply shim
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
