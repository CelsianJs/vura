import { describe, it, expect } from 'vitest';
import { generateServerEntry, generateFunctionEntry } from '../src/build.js';
import type { RouteManifest, ApiRoute } from '../src/manifest.js';

describe('generateServerEntry', () => {
  it('generates a valid CelsianJS server with route registrations', () => {
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
    expect(entry).toContain("import { createApp, serve } from '@celsian/core'");
    expect(entry).toContain("app.get('/api/hello'");
    expect(entry).toContain("app.get('/api/users'");
    expect(entry).toContain("app.post('/api/users'");
    expect(entry).toContain('/__health');
  });
});

describe('generateFunctionEntry', () => {
  it('generates a standalone serverless handler', () => {
    const route: ApiRoute = {
      filePath: 'src/api/hello.ts',
      urlPattern: '/api/hello',
      methods: ['GET'],
      kind: 'serverless',
      config: {},
    };

    const entry = generateFunctionEntry(route, '/project');
    expect(entry).toContain("import { createApp } from '@celsian/core'");
    expect(entry).toContain("app.get('/api/hello'");
    expect(entry).toContain('export default { fetch:');
    expect(entry).toContain('export const handler');
  });

  it('registers multiple methods', () => {
    const route: ApiRoute = {
      filePath: 'src/api/users/index.ts',
      urlPattern: '/api/users',
      methods: ['GET', 'POST'],
      kind: 'serverless',
      config: {},
    };

    const entry = generateFunctionEntry(route, '/project');
    expect(entry).toContain("app.get('/api/users'");
    expect(entry).toContain("app.post('/api/users'");
  });
});
