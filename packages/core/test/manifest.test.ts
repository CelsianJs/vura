import { describe, it, expect, afterEach } from 'vitest';
import { extractApiExports, extractPageConfig, fileToUrlPattern, buildManifest } from '../src/manifest.js';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const tempRoots = new Set<string>();

function createManifestFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'vura-manifest-'));
  tempRoots.add(root);
  return root;
}

function writeFixtureFile(root: string, relPath: string, source: string): void {
  const fullPath = join(root, relPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, source);
}

afterEach(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
    tempRoots.delete(root);
  }
});

describe('extractApiExports', () => {
  it('detects GET and POST methods', () => {
    const source = `
      export const route = { kind: 'serverless' };
      export function GET(req, reply) { return reply.json({}); }
      export async function POST(req, reply) { return reply.json({}); }
    `;
    const result = extractApiExports(source);
    expect(result.methods).toEqual(['GET', 'POST']);
    expect(result.kind).toBe('serverless');
  });

  it('detects arrow function exports', () => {
    const source = `
      export const GET = (req, reply) => reply.json({});
      export const DELETE = async (req, reply) => reply.json({});
    `;
    const result = extractApiExports(source);
    expect(result.methods).toEqual(['GET', 'DELETE']);
  });

  it('defaults kind to serverless', () => {
    const source = `export function GET(req, reply) {}`;
    const result = extractApiExports(source);
    expect(result.kind).toBe('serverless');
  });

  it('extracts hot kind', () => {
    const source = `
      export const route = { kind: 'hot' };
      export function GET(req, reply) {}
    `;
    const result = extractApiExports(source);
    expect(result.kind).toBe('hot');
  });

  it('extracts task kind', () => {
    const source = `
      export const route = { kind: 'task' };
      export function POST(req, reply) {}
    `;
    const result = extractApiExports(source);
    expect(result.kind).toBe('task');
  });

  it('returns empty methods for non-route files', () => {
    const source = `export default function helper() {}`;
    const result = extractApiExports(source);
    expect(result.methods).toEqual([]);
  });
});

describe('extractPageConfig', () => {
  it('detects static mode', () => {
    const source = `export const page = { mode: 'static' };`;
    expect(extractPageConfig(source).mode).toBe('static');
  });

  it('detects server mode', () => {
    const source = `export const page = { mode: 'server' };`;
    expect(extractPageConfig(source).mode).toBe('server');
  });

  it('detects hybrid mode', () => {
    const source = `export const page = { mode: 'hybrid' };`;
    expect(extractPageConfig(source).mode).toBe('hybrid');
  });

  it('defaults to static', () => {
    const source = `export default function Page() {}`;
    expect(extractPageConfig(source).mode).toBe('static');
  });

  it('auto-detects server mode from useSWR import', () => {
    const source = `
      import { useSWR } from 'what-core';
      export default function Page() {}
    `;
    expect(extractPageConfig(source).mode).toBe('server');
  });
});

describe('fileToUrlPattern', () => {
  it('converts index to root', () => {
    expect(fileToUrlPattern('index', '/api')).toBe('/api');
  });

  it('converts simple file', () => {
    expect(fileToUrlPattern('hello', '/api')).toBe('/api/hello');
  });

  it('converts nested file', () => {
    expect(fileToUrlPattern('users/index', '/api')).toBe('/api/users');
  });

  it('converts dynamic param', () => {
    expect(fileToUrlPattern('users/[id]', '/api')).toBe('/api/users/:id');
  });

  it('converts nested dynamic', () => {
    expect(fileToUrlPattern('blog/[slug]/comments', '/api')).toBe('/api/blog/:slug/comments');
  });

  it('handles page routes without prefix', () => {
    expect(fileToUrlPattern('about', '')).toBe('/about');
  });

  it('strips route groups', () => {
    expect(fileToUrlPattern('(auth)/login', '')).toBe('/login');
  });
});

describe('buildManifest', () => {
  it('builds nested layout chains from root to leaf and excludes layout files as routes', async () => {
    const root = createManifestFixture();
    writeFixtureFile(root, 'src/pages/_layout.tsx', 'export default function RootLayout() {}');
    writeFixtureFile(root, 'src/pages/blog/layout.tsx', 'export default function BlogLayout() {}');
    writeFixtureFile(root, 'src/pages/blog/[slug].tsx', `
      export const page = { mode: 'server' };
      export default function Post() {}
    `);
    writeFixtureFile(root, 'src/pages/about.tsx', `
      export const page = { mode: 'server' };
      export default function About() {}
    `);

    const manifest = await buildManifest(root);

    const post = manifest.pages.find((page) => page.urlPattern === '/blog/:slug');
    expect(post?.layouts).toEqual([
      'src/pages/_layout.tsx',
      'src/pages/blog/layout.tsx',
    ]);

    const about = manifest.pages.find((page) => page.urlPattern === '/about');
    expect(about?.layouts).toEqual(['src/pages/_layout.tsx']);

    expect(manifest.pages.map((page) => page.urlPattern)).not.toContain('/_layout');
    expect(manifest.pages.map((page) => page.urlPattern)).not.toContain('/blog/layout');
    expect(manifest.layouts.map((layout) => layout.dirPattern).sort()).toEqual(['', 'blog']);
  });

  it('scans the serverless-poc example', async () => {
    const pocRoot = join(__dirname, '../../../examples/serverless-poc');
    const manifest = await buildManifest(pocRoot);

    expect(manifest.api.length).toBeGreaterThanOrEqual(3);
    expect(manifest.timestamp).toBeTruthy();

    // Check hello route
    const hello = manifest.api.find(r => r.urlPattern === '/api/hello');
    expect(hello).toBeTruthy();
    expect(hello!.methods).toContain('GET');
    expect(hello!.kind).toBe('serverless');

    // Check users index
    const users = manifest.api.find(r => r.urlPattern === '/api/users');
    expect(users).toBeTruthy();
    expect(users!.methods).toContain('GET');
    expect(users!.methods).toContain('POST');
    expect(users!.kind).toBe('serverless');

    // Check users/:id
    const userId = manifest.api.find(r => r.urlPattern === '/api/users/:id');
    expect(userId).toBeTruthy();
    expect(userId!.methods).toContain('GET');
    expect(userId!.methods).toContain('DELETE');
    expect(userId!.kind).toBe('hot');

    // Check health
    const health = manifest.api.find(r => r.urlPattern === '/api/health');
    expect(health).toBeTruthy();
    expect(health!.kind).toBe('hot');
  });
});
