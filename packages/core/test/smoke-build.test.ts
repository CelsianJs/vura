/**
 * Smoke test: end-to-end build pipeline verification.
 *
 * Creates a minimal Vura project in a temp directory, runs the full build()
 * pipeline, and verifies the generated server entry is valid, complete, and
 * (optionally) actually boots and serves requests.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { build, generateServerEntry } from '../src/build.js';
import { buildManifest } from '../src/manifest.js';
import type { RouteManifest, PageRoute } from '../src/manifest.js';
import type { ThenConfig } from '../src/config.js';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fork, type ChildProcess } from 'node:child_process';

// ─── Test project scaffold ───

function createTestProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'vura-smoke-'));

  // src/api/hello.ts — simple GET handler
  const apiDir = join(root, 'src', 'api');
  mkdirSync(apiDir, { recursive: true });
  writeFileSync(
    join(apiDir, 'hello.ts'),
    `export async function GET(req: any, reply: any) {
  return reply.json({ message: 'hello' });
}
`,
  );

  // src/api/echo.ts — POST handler with validation schema
  writeFileSync(
    join(apiDir, 'echo.ts'),
    `import { z } from 'zod';

export const schema = {
  body: z.object({ text: z.string() }),
};

export async function POST(req: any, reply: any) {
  return reply.json({ echo: req.parsedBody });
}
`,
  );

  // src/api/_hooks.ts — global onRequest hook
  writeFileSync(
    join(apiDir, '_hooks.ts'),
    `export const onRequest = [
  (req: any, reply: any) => {
    reply.header('x-vura-smoke', 'true');
  },
];
`,
  );

  // src/pages/index.tsx — simple page component
  const pagesDir = join(root, 'src', 'pages');
  mkdirSync(pagesDir, { recursive: true });
  writeFileSync(
    join(pagesDir, 'index.tsx'),
    `export const page = { mode: 'server', title: 'Smoke Test' };

export default function Home() {
  return <div><h1>Smoke Test</h1></div>;
}
`,
  );

  // src/public/test.txt — static content
  const publicDir = join(root, 'src', 'public');
  mkdirSync(publicDir, { recursive: true });
  writeFileSync(join(publicDir, 'test.txt'), 'smoke-test-static-content');

  return root;
}

// ─── Tests ───

describe('smoke-build: end-to-end build pipeline', () => {
  let projectRoot: string;
  let buildResult: Awaited<ReturnType<typeof build>>;
  let serverCode: string;

  beforeAll(async () => {
    projectRoot = createTestProject();

    // Build a manifest that matches the files we created.
    // We construct it manually (mirroring what buildManifest would produce)
    // because buildManifest reads source files and we want a deterministic test.
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
          filePath: 'src/api/echo.ts',
          urlPattern: '/api/echo',
          methods: ['POST'],
          kind: 'serverless',
          config: {},
        },
      ],
      pages: [
        {
          filePath: 'src/pages/index.tsx',
          urlPattern: '/',
          mode: 'server',
          hasGetServerData: false,
          config: { title: 'Smoke Test', mode: 'server' },
        } as PageRoute,
      ],
      layouts: [],
      timestamp: new Date().toISOString(),
    };

    const config: ThenConfig = {};

    buildResult = await build(manifest, config, projectRoot);
    serverCode = readFileSync(buildResult.serverEntry, 'utf-8');
  });

  afterAll(() => {
    if (projectRoot) {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  // ── 1. Build produces expected artifacts ──

  it('writes server entry to dist/server/entry.js', () => {
    expect(existsSync(buildResult.serverEntry)).toBe(true);
    expect(buildResult.serverEntry).toContain('dist/server/entry.js');
  });

  it('writes function entries for serverless routes', () => {
    expect(buildResult.functions.length).toBe(2);
    for (const fn of buildResult.functions) {
      expect(existsSync(fn.entryPath)).toBe(true);
    }
  });

  it('writes manifest.json', () => {
    const manifestPath = join(projectRoot, 'dist', 'manifest.json');
    expect(existsSync(manifestPath)).toBe(true);
    const written = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    expect(written.api).toHaveLength(2);
    expect(written.pages).toHaveLength(1);
  });

  // ── 2. Generated server code is syntactically valid JavaScript ──

  it('generated server entry is parseable JavaScript', () => {
    // new Function() runs in script mode — strip ESM-only syntax first
    const stripped = serverCode
      .replace(/^import\s.*$/gm, '// [import stripped]')
      .replace(/^export\s.*$/gm, '// [export stripped]')
      .replace(/import\.meta\.\w+/g, '"__stripped__"');

    let parseError: Error | null = null;
    try {
      new Function(stripped);
    } catch (err) {
      parseError = err as Error;
    }
    expect(
      parseError,
      `Generated code has syntax error: ${parseError?.message}`,
    ).toBeNull();
  });

  // ── 3. ESM format — no CommonJS ──

  it('uses ESM imports, not require()', () => {
    expect(serverCode).toContain("import { createServer } from 'node:http'");
    expect(serverCode).not.toMatch(/\brequire\s*\(/);
  });

  // ── 4. Route handlers are wired up ──

  it('contains the API route table with both routes', () => {
    expect(serverCode).toContain("pattern: '/api/hello'");
    expect(serverCode).toContain("pattern: '/api/echo'");
    expect(serverCode).toContain("'GET'");
    expect(serverCode).toContain("'POST'");
  });

  it('imports the route handler modules', () => {
    expect(serverCode).toMatch(/import \* as route_api_hello from/);
    expect(serverCode).toMatch(/import \* as route_api_echo from/);
  });

  // ── 5. Global hooks are imported ──

  it('imports the global hooks file', () => {
    expect(serverCode).toContain("import * as _globalHooksMod from");
    expect(serverCode).toContain('_globalHooksMod.onRequest');
    expect(serverCode).not.toContain('No global hooks file found');
  });

  // ── 6. Static file serving code is present ──

  it('includes static file serving', () => {
    expect(serverCode).toContain('_tryServeStatic');
    expect(serverCode).toContain('_mimeTypes');
    expect(serverCode).toContain('_publicDir');
    expect(serverCode).toContain("'.txt': 'text/plain'");
  });

  // ── 7. Validation code is present ──

  it('includes request validation logic', () => {
    expect(serverCode).toContain('_validateRequest');
    expect(serverCode).toContain('safeParse');
    expect(serverCode).toContain('VALIDATION_ERROR');
  });

  // ── 8. Graceful shutdown ──

  it('includes graceful shutdown code', () => {
    expect(serverCode).toContain('_gracefulShutdown');
    expect(serverCode).toContain("process.on('SIGTERM'");
    expect(serverCode).toContain("process.on('SIGINT'");
    expect(serverCode).toContain('_inFlightRequests');
    expect(serverCode).toContain('_isShuttingDown');
    expect(serverCode).toContain('THEN_SHUTDOWN_TIMEOUT');
  });

  // ── 9. SSR rendering (server-mode page triggers this) ──

  it('includes SSR rendering code for server-mode pages', () => {
    expect(serverCode).toContain('function renderToString');
    expect(serverCode).toContain('function wrapDocument');
    expect(serverCode).toContain('function renderPage');
    expect(serverCode).toContain('function matchPageRoute');
  });

  // ── 10. ISR cache (server pages trigger this) ──

  it('includes ISR cache for server pages', () => {
    expect(serverCode).toContain('isrGet');
    expect(serverCode).toContain('isrSet');
    expect(serverCode).toContain('ISR_MAX_ENTRIES');
  });

  // ── 11. Hooks lifecycle ──

  it('includes the hook execution lifecycle', () => {
    expect(serverCode).toContain('_executeWithHooks');
    expect(serverCode).toContain('_runHooks');
    expect(serverCode).toContain('_runOnError');
    expect(serverCode).toContain('onRequest');
    expect(serverCode).toContain('onError');
    expect(serverCode).toContain('onResponse');
  });

  // ── 12. CORS support ──

  it('includes CORS support', () => {
    expect(serverCode).toContain('THEN_CORS_ORIGIN');
    expect(serverCode).toContain('access-control-allow-origin');
    expect(serverCode).toContain("method === 'OPTIONS'");
  });

  // ── 13. Structured logging ──

  it('includes structured logging', () => {
    expect(serverCode).toContain('function _log(');
    expect(serverCode).toContain('THEN_LOG_LEVEL');
    expect(serverCode).toContain('_generateRequestId');
  });

  // ── 14. Body parsing with size limits ──

  it('includes body parsing with size limits', () => {
    expect(serverCode).toContain('function parseBody');
    expect(serverCode).toContain('THEN_MAX_BODY_SIZE');
    expect(serverCode).toContain('Body too large');
  });

  // ── 15. Dotenv loader ──

  it('includes dotenv loader', () => {
    expect(serverCode).toContain('.env.local');
    expect(serverCode).toContain('.env.');
    expect(serverCode).toContain('_loadEnv');
  });

  // ── 16. Reply helpers ──

  it('includes reply helpers (json, send, redirect)', () => {
    expect(serverCode).toContain('json(data)');
    expect(serverCode).toContain('send(data)');
    expect(serverCode).toContain('redirect(url');
  });

  // ── 17. Health check endpoint ──

  it('includes health check endpoint', () => {
    expect(serverCode).toContain('/__health');
    expect(serverCode).toContain("framework: 'ThenJS'");
  });

  // ── 18. Self-contained — no framework dependency ──

  it('has no runtime dependency on @then/core or @celsian/core', () => {
    expect(serverCode).not.toContain('@then/core');
    expect(serverCode).not.toContain('@celsian/core');
  });

  // ── 19. Page route table is present ──

  it('contains page route table for server pages', () => {
    expect(serverCode).toContain('const pageRoutes = [');
    expect(serverCode).toMatch(/pattern: '\/'/);
    expect(serverCode).toMatch(/import \* as page_index from/);
  });

  // ── 20. Function entries are valid ──

  it('serverless function entries are parseable JavaScript', () => {
    for (const fn of buildResult.functions) {
      const code = readFileSync(fn.entryPath, 'utf-8');

      // Strip ESM syntax for parsing via new Function() (script mode).
      // `export default { ... }` becomes `var _default = { ... }` to stay parseable.
      const stripped = code
        .replace(/^import\s.*$/gm, '// [import stripped]')
        .replace(/^export\s+default\s+/gm, 'var _default = ')
        .replace(/^export\s.*$/gm, '// [export stripped]')
        .replace(/import\.meta\.\w+/g, '"__stripped__"');

      let parseError: Error | null = null;
      try {
        new Function(stripped);
      } catch (err) {
        parseError = err as Error;
      }
      expect(
        parseError,
        `Function entry ${fn.entryPath} has syntax error: ${parseError?.message}`,
      ).toBeNull();

      // Worker-compatible fetch handler
      expect(code).toContain('async fetch(request)');
    }
  });
});

// ─── Build manifest integration: verify the scanner picks up our files ──

describe('smoke-build: buildManifest detects project files', () => {
  let projectRoot: string;

  beforeAll(() => {
    projectRoot = createTestProject();
  });

  afterAll(() => {
    if (projectRoot) {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('buildManifest discovers API routes and pages from the file system', async () => {
    const manifest = await buildManifest(projectRoot);

    // Should find hello.ts and echo.ts (not _hooks.ts — that's a hooks file, not a route)
    const apiPatterns = manifest.api.map((r) => r.urlPattern).sort();
    expect(apiPatterns).toContain('/api/echo');
    expect(apiPatterns).toContain('/api/hello');

    // hello.ts exports GET
    const hello = manifest.api.find((r) => r.urlPattern === '/api/hello');
    expect(hello?.methods).toContain('GET');

    // echo.ts exports POST
    const echo = manifest.api.find((r) => r.urlPattern === '/api/echo');
    expect(echo?.methods).toContain('POST');

    // Should find index.tsx page
    expect(manifest.pages.length).toBeGreaterThanOrEqual(1);
    const indexPage = manifest.pages.find((p) => p.urlPattern === '/');
    expect(indexPage).toBeDefined();
    expect(indexPage?.mode).toBe('server');
  });
});

// ─── Live server test: boot the server and hit it with fetch ──

describe('smoke-build: live server integration', () => {
  let projectRoot: string;
  let serverProcess: ChildProcess | null = null;
  let port: number;

  beforeAll(async () => {
    projectRoot = createTestProject();

    // Build manifest + run build
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

    // We need a self-contained server entry that can actually run.
    // The generated entry imports route modules at relative paths from dist/server/.
    // For the live test we create a minimal wrapper that inlines the handler.

    port = 10000 + Math.floor(Math.random() * 50000);
    const serverDir = join(projectRoot, 'dist', 'server');
    mkdirSync(serverDir, { recursive: true });

    // Write a stub route module that the generated entry will import
    const stubRoute = join(projectRoot, 'src', 'api', 'hello.js');
    writeFileSync(
      stubRoute,
      `export async function GET(req, reply) {
  return reply.json({ message: 'hello' });
}
`,
    );

    // Generate the server entry. It imports from relative paths like
    // '../../src/api/hello.js'. We need the .js source at the right place.
    const serverEntryCode = generateServerEntry(manifest, projectRoot);

    // Patch the entry: replace import paths to point at absolute paths
    // (since the test runs from a temp dir, relative paths can break)
    const patchedCode = serverEntryCode
      // Replace the dynamic port with our test port
      .replace(
        "parseInt(process.env.PORT || '3000', 10)",
        String(port),
      );

    const entryPath = join(serverDir, 'entry.mjs');
    writeFileSync(entryPath, patchedCode);

    // Boot the server in a child process
    serverProcess = fork(entryPath, [], {
      cwd: serverDir,
      stdio: 'pipe',
      env: {
        ...process.env,
        PORT: String(port),
        NODE_ENV: 'test',
        THEN_LOG_LEVEL: 'error', // quieter output
      },
    });

    // Wait for the server to start (listen for stdout message)
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Server did not start within 5 seconds'));
      }, 5000);

      serverProcess!.stdout?.on('data', (data: Buffer) => {
        if (data.toString().includes('listening')) {
          clearTimeout(timeout);
          resolve();
        }
      });

      serverProcess!.stderr?.on('data', (data: Buffer) => {
        // Log stderr for debugging but don't fail — some Node warnings are harmless
        const msg = data.toString().trim();
        if (msg) console.error('[server stderr]', msg);
      });

      serverProcess!.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      serverProcess!.on('exit', (code) => {
        if (code !== 0 && code !== null) {
          clearTimeout(timeout);
          reject(new Error(`Server exited with code ${code}`));
        }
      });
    });
  }, 15000);

  afterAll(() => {
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill('SIGTERM');
    }
    if (projectRoot) {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('GET /__health returns ok', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/__health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.framework).toBe('ThenJS');
  });

  it('GET /api/hello returns { message: "hello" }', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/hello`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toBe('hello');
  });

  it('GET /unknown returns 404', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/unknown`);
    expect(res.status).toBe(404);
  });

  it('POST /api/hello returns 404 (only GET registered)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/hello`, {
      method: 'POST',
    });
    // The route exists but POST is not registered — matchRoute checks methods,
    // so it won't match at all, resulting in 404
    expect(res.status).toBe(404);
  });
});
