/**
 * What's component-context hooks, in a built application.
 *
 * `useSignal()` reads the renderer's current-component state. That only works
 * when the page module and `renderToString` share one copy of what-core — and
 * they did not: the CLI's resolve plugin answered `onResolve` for
 * `what-framework`, which beats esbuild's `external` list, so every
 * build-time-rendered page inlined its own copy and the hook threw
 *
 *   [what] useSignal() can only be called inside a component function.
 *
 * in every `static` and `hybrid` page. It was invisible because every other
 * fixture in this suite holds state in a module-level `signal()`, which needs
 * no component context at all.
 *
 * These assertions fail on the pre-fix build, which is the point of them.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { scaffoldAndBuild, bootServer } from './helpers.js';

let app: Awaited<ReturnType<typeof scaffoldAndBuild>>;
let server: Awaited<ReturnType<typeof bootServer>>;

beforeAll(async () => {
  app = await scaffoldAndBuild();
  server = await bootServer({ NODE_ENV: 'production', PORT: '0' });
}, 300_000);

afterAll(async () => {
  await server?.kill();
});

const base = () => server.url;

describe('H1: a static page can use useSignal', () => {
  it('prerenders it to HTML at build time', () => {
    const html = join(app.dir, 'dist', 'static', 'hooks', 'static', 'index.html');
    expect(existsSync(html)).toBe(true);
    expect(readFileSync(html, 'utf8')).toContain('hook-static-ok');
  });
});

describe('H2: a hybrid page can use useSignal', () => {
  it('prerenders it to HTML at build time', () => {
    const html = join(app.dir, 'dist', 'static', 'hooks', 'hybrid', 'index.html');
    expect(existsSync(html)).toBe(true);
    expect(readFileSync(html, 'utf8')).toContain('hook-hybrid-ok');
  });

  it('still ships a hydration bundle, so the fix did not silently drop the island', () => {
    const html = readFileSync(
      join(app.dir, 'dist', 'static', 'hooks', 'hybrid', 'index.html'),
      'utf8',
    );
    expect(html).toMatch(/<script type="module" src="\/_then\/pages\/[^"]+\.js">/);
  });
});

describe('H3: a server page can use useSignal', () => {
  it('renders it per request', async () => {
    const res = await fetch(`${base()}/hooks/server`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('hook-server-ok');
  });
});

describe('H4: the server bundles hold one copy of the framework', () => {
  it('keeps what-framework external in a bundled server page', () => {
    // The direct expression of the bug: an inlined copy means no import.
    const bundle = readFileSync(
      join(app.dir, 'dist', 'server', 'pages', 'hooks', 'server.js'),
      'utf8',
    );
    expect(bundle).toMatch(/from\s+["']what-framework["']/);
  });
});
