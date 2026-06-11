import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import {
  generateWranglerToml,
  generateWorkerEntry,
  createWorkerHandler,
  cloudflareAdapter,
} from '../src/index.js';
import type { ApiRoute, RouteManifest } from '@celsian/vura-core';

function runModuleJson(entryPath: string, body: string): any {
  const source = `const mod = await import(${JSON.stringify(pathToFileURL(entryPath).href)});
${body}`;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' }));
}

// Mock fs so adapter.buildEnd doesn't write to disk
vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn(async () => {}),
  mkdir: vi.fn(async () => undefined),
}));


function makeRealAdapterContext(manifest: RouteManifest): AdapterBuildContext {
  const root = mkdtempSync(join(tmpdir(), 'vura-cf-unit-'));
  for (const route of manifest.api) {
    const fullPath = join(root, route.filePath);
    mkdirSync(join(fullPath, '..'), { recursive: true });
    writeFileSync(fullPath, `export async function ${route.methods[0] ?? 'GET'}() { return { ok: true }; }\n`);
  }
  mkdirSync(join(root, 'dist', 'cloudflare', 'routes'), { recursive: true });
  return {
    serverEntry: join(root, 'dist', 'server', 'entry.js'),
    clientDir: join(root, 'dist', 'client'),
    manifest,
    projectRoot: root,
    outDir: join(root, 'dist'),
  };
}

// ─── Test Data ───

function makeRoute(overrides: Partial<ApiRoute> = {}): ApiRoute {
  return {
    filePath: 'src/api/hello.ts',
    urlPattern: '/api/hello',
    methods: ['GET'],
    kind: 'serverless',
    config: {},
    ...overrides,
  };
}

function makeManifest(routes: ApiRoute[] = []): RouteManifest {
  return {
    api: routes,
    pages: [],
    layouts: [],
    timestamp: new Date().toISOString(),
  };
}

// ─── wrangler.toml Generation ───

describe('generateWranglerToml', () => {
  it('generates basic worker config', () => {
    const toml = generateWranglerToml(
      { name: 'my-api', compatibilityDate: '2024-12-01' },
      [makeRoute()],
    );

    expect(toml).toContain('name = "my-api"');
    expect(toml).toContain('main = "entry.js"');
    expect(toml).toContain('compatibility_date = "2024-12-01"');
  });

  it('includes route patterns when provided', () => {
    const toml = generateWranglerToml(
      {
        name: 'my-api',
        compatibilityDate: '2024-12-01',
        routes: [
          { pattern: 'example.com/api/*', zone_name: 'example.com' },
        ],
      },
      [makeRoute()],
    );

    expect(toml).toContain('[[routes]]');
    expect(toml).toContain('pattern = "example.com/api/*"');
    expect(toml).toContain('zone_name = "example.com"');
  });

  it('includes KV namespace bindings', () => {
    const toml = generateWranglerToml(
      {
        name: 'my-api',
        compatibilityDate: '2024-12-01',
        kv: [{ binding: 'CACHE', id: 'abc123', preview_id: 'dev456' }],
      },
      [],
    );

    expect(toml).toContain('[[kv_namespaces]]');
    expect(toml).toContain('binding = "CACHE"');
    expect(toml).toContain('id = "abc123"');
    expect(toml).toContain('preview_id = "dev456"');
  });

  it('includes D1 database bindings', () => {
    const toml = generateWranglerToml(
      {
        name: 'my-api',
        compatibilityDate: '2024-12-01',
        d1: [{
          binding: 'DB',
          database_name: 'my-db',
          database_id: 'db-id-123',
        }],
      },
      [],
    );

    expect(toml).toContain('[[d1_databases]]');
    expect(toml).toContain('binding = "DB"');
    expect(toml).toContain('database_name = "my-db"');
    expect(toml).toContain('database_id = "db-id-123"');
  });

  it('includes R2 bucket bindings', () => {
    const toml = generateWranglerToml(
      {
        name: 'my-api',
        compatibilityDate: '2024-12-01',
        r2: [{ binding: 'UPLOADS', bucket_name: 'my-uploads' }],
      },
      [],
    );

    expect(toml).toContain('[[r2_buckets]]');
    expect(toml).toContain('binding = "UPLOADS"');
    expect(toml).toContain('bucket_name = "my-uploads"');
  });

  it('defaults compatibility_date to today when not specified', () => {
    const toml = generateWranglerToml({ name: 'test' }, []);
    expect(toml).toMatch(/compatibility_date = "\d{4}-\d{2}-\d{2}"/);
  });
});

// ─── Worker Entry Generation ───

describe('generateWorkerEntry', () => {
  it('generates a self-contained worker with route table', () => {
    const routes = [
      makeRoute({ filePath: 'src/api/hello.ts', urlPattern: '/api/hello', methods: ['GET'] }),
      makeRoute({ filePath: 'src/api/users/index.ts', urlPattern: '/api/users', methods: ['GET', 'POST'] }),
    ];

    const entry = generateWorkerEntry(routes, '/project', '/project/dist/cloudflare');

    // Self-contained — no @celsian/core dependency
    expect(entry).not.toContain('@celsian/core');
    // Route table with patterns
    expect(entry).toContain("pattern: '/api/hello'");
    expect(entry).toContain("pattern: '/api/users'");
    expect(entry).toContain("'GET'");
    expect(entry).toContain("'POST'");
    // Inline route matching and body parsing
    expect(entry).toContain('function matchRoute');
    expect(entry).toContain('function parseBody');
    // Health check
    expect(entry).toContain('/__health');
  });

  it('exports a self-contained fetch handler with env and ctx', () => {
    const entry = generateWorkerEntry(
      [makeRoute()],
      '/project',
      '/project/dist/cloudflare',
    );

    expect(entry).toContain('export default');
    expect(entry).toContain('async fetch(request, env, ctx)');
    // CF env/ctx passed through to handlers via req object
    expect(entry).toContain('__cf_env: env');
    expect(entry).toContain('__cf_ctx: ctx');
  });

  it('imports route modules with correct relative paths', () => {
    const routes = [
      makeRoute({ filePath: 'src/api/hello.ts', urlPattern: '/api/hello' }),
    ];

    const entry = generateWorkerEntry(routes, '/project', '/project/dist/cloudflare');

    expect(entry).toContain('import * as route_api_hello');
    expect(entry).toContain("from './routes/src_api_hello.js'");
  });

  it('exposes both body and parsedBody to generated route handlers', () => {
    const entry = generateWorkerEntry(
      [makeRoute({ filePath: 'src/api/echo.ts', urlPattern: '/api/echo', methods: ['POST'] })],
      '/project',
      '/project/dist/cloudflare',
    );

    expect(entry).toContain('body,');
    expect(entry).toContain('parsedBody: body');
  });

  it('generated worker entry imports executable JS route artifacts', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'vura-cf-entry-'));
    try {
      const workerDir = join(tempRoot, 'dist', 'cloudflare');
      mkdirSync(join(workerDir, 'routes'), { recursive: true });
      writeFileSync(
        join(workerDir, 'routes', 'src_api_echo.js'),
        `export async function POST(req) {
  return { body: req.body, parsedBody: req.parsedBody };
}
`,
      );
      const entry = generateWorkerEntry(
        [makeRoute({ filePath: 'src/api/echo.ts', urlPattern: '/api/echo', methods: ['POST'] })],
        tempRoot,
        workerDir,
      );
      expect(entry).toContain("from './routes/src_api_echo.js'");
      expect(entry).not.toMatch(/from ['\"].*\.tsx?['\"]/);
      const entryPath = join(workerDir, 'entry.mjs');
      writeFileSync(entryPath, entry);

      const result = runModuleJson(entryPath, `
const response = await mod.default.fetch(new Request('https://example.com/api/echo', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: 'hello' }),
}), {}, { waitUntil: () => {}, passThroughOnException: () => {} });
console.log(JSON.stringify({ status: response.status, body: await response.json() }));
`);
      expect(result.status).toBe(200);
      expect(result.body).toEqual({
        body: { text: 'hello' },
        parsedBody: { text: 'hello' },
      });
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

// ─── createWorkerHandler ───

describe('createWorkerHandler', () => {
  it('wraps a CelsianJS app as a CF Worker handler', () => {
    const mockApp = {
      handle: async (_req: Request) => new Response('ok'),
    };

    const handler = createWorkerHandler(mockApp);

    expect(handler).toHaveProperty('fetch');
    expect(typeof handler.fetch).toBe('function');
  });

  it('passes request through to app.handle()', async () => {
    let capturedRequest: Request | null = null;
    const mockApp = {
      handle: async (req: Request) => {
        capturedRequest = req;
        return new Response('ok');
      },
    };

    const handler = createWorkerHandler(mockApp);
    const request = new Request('https://example.com/api/hello');
    const env = { MY_KV: 'kv-binding' };
    const ctx = {
      waitUntil: () => {},
      passThroughOnException: () => {},
    };

    await handler.fetch(request, env, ctx);

    expect(capturedRequest).toBe(request);
  });

  it('decorates request with env and ctx bindings', async () => {
    let capturedRequest: Request | null = null;
    const mockApp = {
      handle: async (req: Request) => {
        capturedRequest = req;
        return new Response('ok');
      },
    };

    const handler = createWorkerHandler(mockApp);
    const request = new Request('https://example.com/api/data');
    const env = { DB: 'db-binding', CACHE: 'kv-binding' };
    const ctx = {
      waitUntil: () => {},
      passThroughOnException: () => {},
    };

    await handler.fetch(request, env, ctx);

    expect((capturedRequest as any).__cf_env).toBe(env);
    expect((capturedRequest as any).__cf_ctx).toBe(ctx);
  });

  it('is nearly a pass-through since CF Workers use Web Standard APIs', async () => {
    const body = JSON.stringify({ message: 'hello' });
    const mockApp = {
      handle: async (_req: Request) => {
        return new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    };

    const handler = createWorkerHandler(mockApp);
    const request = new Request('https://example.com/api/data');
    const response = await handler.fetch(
      request,
      {},
      { waitUntil: () => {}, passThroughOnException: () => {} },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(await response.text()).toBe(body);
  });
});

// ─── Adapter Integration ───

describe('cloudflareAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a ThenAdapter with name "cloudflare"', () => {
    const adapter = cloudflareAdapter({ name: 'my-api' });
    expect(adapter.name).toBe('cloudflare');
    expect(typeof adapter.buildEnd).toBe('function');
  });

  it('only processes serverless routes', async () => {
    const adapter = cloudflareAdapter({
      name: 'my-api',
      compatibilityDate: '2024-12-01',
    });

    const manifest = makeManifest([
      makeRoute({ kind: 'serverless', urlPattern: '/api/hello' }),
      makeRoute({ kind: 'hot', urlPattern: '/api/stream', filePath: 'src/api/stream.ts' }),
      makeRoute({ kind: 'task', urlPattern: '/api/cron', filePath: 'src/api/cron.ts' }),
    ]);

    const ctx = makeRealAdapterContext(manifest);
    await adapter.buildEnd(ctx);

    const { writeFile } = await import('node:fs/promises');
    const writeCalls = vi.mocked(writeFile).mock.calls;

    // Find the entry.js write
    const entryCall = writeCalls.find(([path]) =>
      (path as string).endsWith('entry.js'),
    );
    expect(entryCall).toBeDefined();

    const entryContent = entryCall![1] as string;
    expect(entryContent).toContain('/api/hello');
    expect(entryContent).not.toContain('/api/stream');
    // Task routes now appear in entry for the scheduled handler
    expect(entryContent).toContain('scheduled');
  });

  it('emits a console.warn for hot routes that cannot run on cloudflare', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const adapter = cloudflareAdapter({
        name: 'my-api',
        compatibilityDate: '2024-12-01',
      });

      const manifest = makeManifest([
        makeRoute({ kind: 'serverless', urlPattern: '/api/hello' }),
        makeRoute({ kind: 'hot', urlPattern: '/api/stream', filePath: 'src/api/stream.ts' }),
      ]);

      const ctx = makeRealAdapterContext(manifest);
      await adapter.buildEnd(ctx);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const warnMessage = warnSpy.mock.calls[0]![0] as string;
      expect(warnMessage).toContain('/api/stream');
      expect(warnMessage).toContain('cannot run on cloudflare');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not emit a console.warn when there are no hot routes', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const adapter = cloudflareAdapter({
        name: 'my-api',
        compatibilityDate: '2024-12-01',
      });

      const manifest = makeManifest([
        makeRoute({ kind: 'serverless', urlPattern: '/api/hello' }),
      ]);

      const ctx = makeRealAdapterContext(manifest);
      await adapter.buildEnd(ctx);

      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('generates files in the correct output directory', async () => {
    const adapter = cloudflareAdapter({
      name: 'my-api',
      compatibilityDate: '2024-12-01',
    });

    const ctx = makeRealAdapterContext(makeManifest([makeRoute()]));
    await adapter.buildEnd(ctx);

    const { writeFile } = await import('node:fs/promises');
    const writeCalls = vi.mocked(writeFile).mock.calls;

    const paths = writeCalls.map(([path]) => path as string);
    expect(paths).toContain(join(ctx.outDir, 'cloudflare', 'wrangler.toml'));
    expect(paths).toContain(join(ctx.outDir, 'cloudflare', 'entry.js'));
  });

  it('generates KV/D1 bindings in wrangler.toml', async () => {
    const adapter = cloudflareAdapter({
      name: 'my-api',
      compatibilityDate: '2024-12-01',
      kv: [{ binding: 'CACHE', id: 'kv-123' }],
      d1: [{ binding: 'DB', database_name: 'mydb', database_id: 'db-456' }],
    });

    const ctx = makeRealAdapterContext(makeManifest([makeRoute()]));
    await adapter.buildEnd(ctx);

    const { writeFile } = await import('node:fs/promises');
    const writeCalls = vi.mocked(writeFile).mock.calls;

    const tomlCall = writeCalls.find(([path]) =>
      (path as string).endsWith('wrangler.toml'),
    );
    expect(tomlCall).toBeDefined();

    const tomlContent = tomlCall![1] as string;
    expect(tomlContent).toContain('binding = "CACHE"');
    expect(tomlContent).toContain('id = "kv-123"');
    expect(tomlContent).toContain('binding = "DB"');
    expect(tomlContent).toContain('database_name = "mydb"');
    expect(tomlContent).toContain('database_id = "db-456"');
  });
});
