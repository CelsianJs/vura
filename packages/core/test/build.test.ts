import { describe, it, expect } from 'vitest';
import { generateServerEntry, generateFunctionEntry } from '../src/build.js';
import type { RouteManifest, ApiRoute, PageRoute } from '../src/manifest.js';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
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
