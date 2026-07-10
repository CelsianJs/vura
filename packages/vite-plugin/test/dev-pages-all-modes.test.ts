/**
 * `vura dev` (Vite path) must serve ALL FOUR page modes.
 *
 * Regression: the vite-plugin's page middleware only matched
 * `mode: 'server' | 'hybrid'`, so an app made of `static` pages + `client`
 * SPA pages 404'd on every page in dev (API routes worked). The full app was
 * only runnable from the built output. See the fixture `pages-app/` which
 * mirrors the real shape: static + client pages, serverless + hot API routes.
 *
 * Boots a REAL Vite dev server with thenPlugin on an ephemeral port against
 * the in-repo fixture (in-repo so `what-framework` resolves via node_modules
 * hoisting — a tmpdir root could not resolve it), then asserts each surface.
 *
 * On UNPATCHED main the static/client page assertions fail (those requests
 * 404); server/hybrid + API assertions already pass.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import { thenPlugin } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, 'fixtures', 'pages-app');

let server: ViteDevServer;
let base: string;

beforeAll(async () => {
  server = await createViteServer({
    root,
    configFile: false,
    logLevel: 'silent',
    server: { port: 0, host: '127.0.0.1' },
    plugins: [thenPlugin({ root })],
  });
  await server.listen();
  const addr = server.httpServer!.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
}, 30000);

afterAll(async () => {
  await server?.close();
});

describe('vite dev — all four page modes are served', () => {
  it('static page `/` is SSR-rendered (200 HTML, no client bundle)', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('Pages App Home');
    expect(html).toContain('data-testid="static-marker"');
    expect(html).toContain('<title>Pages App — Home</title>');
    // Static pages ship zero client JS — no browser bundle script.
    expect(html).not.toContain('/_then/pages/');
  });

  it('second static page `/features` is SSR-rendered (200 HTML)', async () => {
    const res = await fetch(`${base}/features`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<h1>Features</h1>');
    expect(html).toContain('data-testid="feature-item"');
  });

  it('client page `/app` serves the SPA shell + client bundle script (not SSR)', async () => {
    const res = await fetch(`${base}/app`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    // SPA shell, not the rendered component (SSR'ing a client page would 500).
    expect(html).toContain('id="loading"');
    expect(html).toContain('<title>Pages App — App</title>');
    // The browser bundle script boots the page client-side.
    expect(html).toContain('<script type="module" src="/_then/pages/app.js"></script>');
    // The component body is NOT server-rendered into the shell.
    expect(html).not.toContain('Client App');
  });

  it('second client page `/stats` serves the SPA shell + its own bundle', async () => {
    const res = await fetch(`${base}/stats`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="loading"');
    expect(html).toContain('<script type="module" src="/_then/pages/stats.js"></script>');
  });

  it('client bundle `/_then/pages/app.js` is a valid ESM module that boots the page', async () => {
    const res = await fetch(`${base}/_then/pages/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
    const code = await res.text();
    // generateClientPageEntry emits a mount() call for client pages.
    expect(code).toContain('mount(');
    // The page component is bundled in (not left as a bare import).
    expect(code).toContain('Client App');
  });

  it('serverless API `/api/ping` still works (unchanged)', async () => {
    const res = await fetch(`${base}/api/ping`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ pong: true });
  });

  it('hot API `/api/live` still works (unchanged)', async () => {
    const res = await fetch(`${base}/api/live`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { hits: number };
    expect(typeof json.hits).toBe('number');
    expect(json.hits).toBeGreaterThan(0);
  });
});
