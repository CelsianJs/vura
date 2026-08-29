/**
 * The Lambda adapter serves pages.
 *
 * Before this suite existed the SAM template contained one function per API
 * route and nothing else, so `/` and every other page path was an unmapped
 * route: API Gateway answered 403 "Missing Authentication Token" while the
 * build exited 0 and printed the page table. The tests invoke the emitted
 * handler with real API Gateway v2 events, because the defect was never in the
 * generator's shape — it was in what the artifact actually served.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { lambdaAdapter } from '../src/index.js';
import type { AdapterBuildContext, PageRoute, RouteManifest } from '@celsian/vura-core';

const SERVER_PAGE = `import { useLoaderData } from '@celsian/vura-core';

export const page = { mode: 'server', title: 'Posts' };

export async function loader() {
  return { message: 'from-the-loader', at: Date.now() };
}

export default function PostsPage() {
  const data = useLoaderData();
  return <div class="posts"><h1>Posts</h1><p>LOADED:{data.message}</p></div>;
}
`;

function page(overrides: Partial<PageRoute> = {}): PageRoute {
  return {
    filePath: 'src/pages/posts.tsx',
    urlPattern: '/posts',
    mode: 'server',
    hasLoader: true,
    hasGetServerData: false,
    config: { mode: 'server' },
    ...overrides,
  };
}

function scaffold(pageSource = SERVER_PAGE): { root: string; ctx: AdapterBuildContext } {
  const root = mkdtempSync(join(tmpdir(), 'vura-lambda-pages-'));
  mkdirSync(join(root, 'src', 'pages'), { recursive: true });
  writeFileSync(join(root, 'src', 'pages', 'posts.tsx'), pageSource);
  writeFileSync(join(root, 'src', 'pages', 'index.tsx'), "export const page = { mode: 'static' };\nexport default function Home() { return null; }\n");

  mkdirSync(join(root, 'dist', 'static', '_then', 'pages'), { recursive: true });
  writeFileSync(join(root, 'dist', 'static', 'index.html'), '<!DOCTYPE html><h1>PRERENDERED HOME</h1>');
  writeFileSync(join(root, 'dist', 'static', '_then', 'pages', 'dashboard.abc.js'), '/* client bundle */');

  const outDir = join(root, 'dist');
  const manifest: RouteManifest = {
    api: [],
    pages: [page(), page({ filePath: 'src/pages/index.tsx', urlPattern: '/', mode: 'static', hasLoader: false, config: { mode: 'static' } })],
    layouts: [],
    timestamp: new Date().toISOString(),
  };
  return {
    root,
    ctx: {
      serverEntry: join(outDir, 'server', 'entry.js'),
      clientDir: join(outDir, 'client'),
      manifest,
      projectRoot: root,
      outDir,
    },
  };
}

function apiGatewayEvent(rawPath: string, method = 'GET'): unknown {
  return {
    version: '2.0',
    routeKey: `${method} ${rawPath}`,
    rawPath,
    rawQueryString: '',
    headers: { host: 'example.com' },
    isBase64Encoded: false,
    requestContext: {
      accountId: '1', apiId: 'a', domainName: 'example.com', domainPrefix: 'e',
      http: { method, path: rawPath, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'r', routeKey: `${method} ${rawPath}`, stage: 'prod', time: '', timeEpoch: 0,
    },
  };
}

/** Invoke the emitted handler in a real Node process, the way Lambda would. */
function invoke(handlerPath: string, rawPath: string, method = 'GET'): any {
  const source = `const mod = await import(${JSON.stringify(pathToFileURL(handlerPath).href)});
process.stdout.write(JSON.stringify(await mod.handler(${JSON.stringify(apiGatewayEvent(rawPath, method))})));`;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' }));
}

describe('lambdaAdapter pages', () => {
  it('emits a handler that parses as ESM', async () => {
    // A generated file is not type-checked by anything. This exact handler
    // shipped once with `/\/+$/` collapsed to `//+$/` by the template literal
    // it is written in, and the only symptom was Runtime.UserCodeSyntaxError
    // from a live Lambda. `node --check` is the cheapest place to catch that.
    const { root, ctx } = scaffold();
    try {
      await lambdaAdapter().buildEnd(ctx);
      const handlerPath = join(root, 'dist', 'lambda', '__pages', 'index.js');
      expect(existsSync(handlerPath)).toBe(true);
      execFileSync(process.execPath, ['--check', handlerPath], { stdio: 'pipe' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('serves a server-mode page, runs its loader, and emits the loader payload', async () => {
    const { root, ctx } = scaffold();
    try {
      await lambdaAdapter().buildEnd(ctx);
      const result = invoke(join(root, 'dist', 'lambda', '__pages', 'index.js'), '/posts');

      expect(result.statusCode).toBe(200);
      expect(result.headers['content-type']).toContain('text/html');
      expect(result.body).toContain('LOADED:from-the-loader');
      expect(result.body).toContain('id="__VURA_LOADER__"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('serves prerendered pages and client bundles from its own asset copy', async () => {
    const { root, ctx } = scaffold();
    try {
      await lambdaAdapter().buildEnd(ctx);
      const handlerPath = join(root, 'dist', 'lambda', '__pages', 'index.js');

      const home = invoke(handlerPath, '/');
      expect(home.statusCode).toBe(200);
      expect(home.body).toContain('PRERENDERED HOME');

      const bundle = invoke(handlerPath, '/_then/pages/dashboard.abc.js');
      expect(bundle.statusCode).toBe(200);
      expect(bundle.headers['content-type']).toContain('text/javascript');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a path that escapes the asset root', async () => {
    const { root, ctx } = scaffold();
    try {
      await lambdaAdapter().buildEnd(ctx);
      // API Gateway forwards the raw path, and this handler sits on a
      // catch-all route, so traversal reaches it verbatim.
      const result = invoke(join(root, 'dist', 'lambda', '__pages', 'index.js'), '/../../index.js');
      expect(result.statusCode).toBe(404);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('splits the 404 the way the Node server does', async () => {
    const { root, ctx } = scaffold();
    try {
      await lambdaAdapter().buildEnd(ctx);
      const handlerPath = join(root, 'dist', 'lambda', '__pages', 'index.js');

      const pageMiss = invoke(handlerPath, '/nope');
      expect(pageMiss.statusCode).toBe(404);
      expect(pageMiss.headers['content-type']).toContain('text/html');

      const apiMiss = invoke(handlerPath, '/api/nope');
      expect(apiMiss.statusCode).toBe(404);
      expect(JSON.parse(apiMiss.body).error).toBe('Not Found');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('declares every page in the SAM template, plus a catch-all for assets', async () => {
    const { root, ctx } = scaffold();
    try {
      await lambdaAdapter().buildEnd(ctx);
      const template = readFileSync(join(root, 'dist', 'template.yaml'), 'utf-8');

      expect(template).toContain('VuraPagesFunction');
      expect(template).toContain('CodeUri: lambda/__pages/');
      expect(template).toContain('Path: /posts');
      expect(template).toContain('Path: /');
      // Serves /_then/ bundles and public/ files, and turns an unknown path
      // into the Node server's 404 page instead of API Gateway's 403.
      expect(template).toContain('Path: /{proxy+}');
      expect(template).toContain('Method: ANY');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('emits no pages function for a deployment with nothing but API routes', async () => {
    const { root, ctx } = scaffold();
    try {
      ctx.manifest.pages = [];
      rmSync(join(root, 'dist', 'static'), { recursive: true, force: true });
      await lambdaAdapter().buildEnd(ctx);
      expect(existsSync(join(root, 'dist', 'lambda', '__pages'))).toBe(false);
      expect(readFileSync(join(root, 'dist', 'template.yaml'), 'utf-8')).not.toContain('VuraPagesFunction');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('serves public/ files even when the project has no pages at all', async () => {
    // The Node server serves dist/public whether or not the project has pages,
    // and the Cloudflare adapter now does the same. A project with a public/
    // directory has a site surface even with no page routes.
    const { root, ctx } = scaffold();
    try {
      mkdirSync(join(root, 'dist', 'public'), { recursive: true });
      writeFileSync(join(root, 'dist', 'public', 'robots.txt'), 'User-agent: *\n');
      ctx.manifest.pages = [];
      rmSync(join(root, 'dist', 'static'), { recursive: true, force: true });
      await lambdaAdapter().buildEnd(ctx);

      const handlerPath = join(root, 'dist', 'lambda', '__pages', 'index.js');
      expect(existsSync(handlerPath)).toBe(true);
      const robots = invoke(handlerPath, '/robots.txt');
      expect(robots.statusCode).toBe(200);
      expect(robots.body).toContain('User-agent');

      const template = readFileSync(join(root, 'dist', 'template.yaml'), 'utf-8');
      expect(template).toContain('VuraPagesFunction');
      expect(template).toContain('Path: /{proxy+}');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails the build by name when a page cannot run in the neutral bundle', async () => {
    const { root, ctx } = scaffold(
      "import { readFileSync } from 'node:fs';\n" +
      "export const page = { mode: 'server' };\n" +
      'export default function P() { return readFileSync; }\n',
    );
    try {
      await expect(lambdaAdapter().buildEnd(ctx)).rejects.toThrow(/src\/pages\/posts\.tsx/);
      await expect(lambdaAdapter().buildEnd(ctx)).rejects.toThrow(/could not be bundled for AWS Lambda/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
