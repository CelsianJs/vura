import { describe, it, expect } from 'vitest';
import { generateServerEntry, generateFunctionEntry } from '../src/build.js';
import type { RouteManifest, ApiRoute } from '../src/manifest.js';

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
