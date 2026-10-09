import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cp, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';
import { thenPlugin } from '../src/index.js';
import { actionRegistry, buildManifest } from '@celsian/vura-core';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
let root: string;
let server: ViteDevServer;
let base: string;
let initialRegistryIds: string[];
const foreignAction = () => 'foreign-app';

beforeAll(async () => {
  actionRegistry.register('foreign-parity-test#ping', foreignAction);
  initialRegistryIds = actionRegistry.ids();
  root = await mkdtemp(join(fixtures, '.runtime-live-'));
  await cp(join(fixtures, 'runtime-app'), root, { recursive: true });
  await mkdir(join(root, 'public'));
  await symlink(join(root, 'src/actions/parity.ts'), join(root, 'public/action-alias.ts'));
  server = await createServer({
    root, configFile: false, logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0 },
    plugins: [thenPlugin({ root })],
  });
  await server.listen();
  base = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`;
});

afterAll(async () => {
  await server?.close();
  expect(actionRegistry.get('foreign-parity-test#ping')).toBe(foreignAction);
  expect(actionRegistry.ids().filter(id => !initialRegistryIds.includes(id))).toEqual([]);
  if (root) await rm(root, { recursive: true, force: true });
});

async function actionCaller() {
  const response = await fetch(`${base}/__vura/action`, { headers: { origin: base } });
  expect(response.status).toBe(200);
  const { token } = await response.json() as { token: string };
  const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
  return (id: string) => fetch(`${base}/__vura/action`, {
    method: 'POST', headers: {
      origin: base, cookie, 'content-type': 'application/json',
      'x-vura-csrf': token, 'x-vura-action': id,
    }, body: JSON.stringify({ args: [] }),
  });
}

describe('real Vite dev runtime parity', () => {
  it('scans literal dotted basenames and the named catch-all from real fixture files', async () => {
    const manifest = await buildManifest(root);
    expect(manifest.pages.map(page => page.urlPattern)).toEqual(expect.arrayContaining([
      '/guide', '/guide.v1', '/guide.v2', '/docs/*rest',
    ]));
  });

  it.each([
    ['/guide', 'plain-guide'], ['/guide.v1', 'guide-version-one'], ['/guide.v2', 'guide-version-two'],
    ['/docs/readme.md', 'docs-rest:readme.md'], ['/docs/nested/readme.md', 'docs-rest:nested/readme.md'],
  ])('matches authored page %s before classifying extension-like paths as assets', async (path, marker) => {
    const response = await fetch(`${base}${path}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain(marker);
  });

  it('keeps unmatched file requests in Vite public serving', async () => {
    await writeFile(join(root, 'public/probe.txt'), 'public-file-marker');
    const response = await fetch(`${base}/probe.txt`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('public-file-marker');
    expect((await fetch(`${base}/guideXv1`)).status).toBe(404);
  });

  it('blocks private action, API and middleware source over normal, raw, @fs and encoded HTTP URLs', async () => {
    for (const path of ['/action-alias.ts', '/action-alias.ts?raw', '/src/actions/../actions/parity.ts?raw']) {
      const response = await fetch(`${base}${path}`);
      expect(response.status, path).toBe(403);
      expect(await response.text()).toBe('Server-only source');
    }
    for (const file of ['src/actions/parity.ts', 'src/api/echo.ts', 'src/middleware.ts']) {
      const fsPath = '/@fs' + realpathSync(join(root, file));
      for (const path of [
        '/' + file, '/' + file + '?raw', '/' + file + '?import',
        '/' + file.replace(/\//g, '%2F') + '?raw', fsPath, fsPath + '?raw',
        '/@fs' + encodeURIComponent(realpathSync(join(root, file))) + '?raw',
      ]) {
        const response = await fetch(`${base}${path}`);
        expect(response.status, path).toBe(403);
        const body = await response.text();
        expect(body).toBe('Server-only source');
        expect(body).not.toContain('VURA_ACTION_PRIVATE_CANARY_57');
      }
    }
  });
  it('runs page and layout loaders with hook context and serializes both for hydration', async () => {
    const response = await fetch(`${base}/nested/loader?tag=first&tag=second`);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-runtime-middleware')).toBe('active');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const html = await response.text();
    expect(html).toContain('root-layout:root-data');
    expect(html).toContain('nested-layout:nested-data');
    expect(html).toContain('page-data:first,second:7');
    const payload = html.match(/<script id="__VURA_LOADER__" type="application\/json">([^<]+)<\/script>/);
    expect(payload).not.toBeNull();
    expect(JSON.parse(payload![1]!)).toEqual({
      'layout:0': { name: 'root-data' }, 'layout:1': { name: 'nested-data' },
      page: { name: 'page-data', tags: ['first', 'second'] },
    });
    expect(html).toContain('/_then/pages/nested/loader.js');
  });

  it('renders static hooks through a component context and preserves legacy props', async () => {
    const response = await fetch(`${base}/hooks`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('legacy:9');
  });

  it('runs middleware before pages and API responses without consuming POST bodies', async () => {
    const denied = await fetch(`${base}/guard`, { redirect: 'manual' });
    expect(denied.status).toBe(302);
    expect(denied.headers.get('location')).toBe('/login');
    const allowed = await fetch(`${base}/guard`, { headers: { cookie: 'session=present' } });
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toContain('guarded-page');
    const api = await fetch(`${base}/api/echo`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: true }),
    });
    expect(api.headers.get('x-runtime-middleware')).toBe('active');
    expect(await api.json()).toEqual({ ok: true });
  });

  it('fails closed when middleware throws', async () => {
    const response = await fetch(`${base}/guard?broken=1`, { headers: { cookie: 'session=present' } });
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('Middleware failed');
  });

  it.each([['missing', 404, null], ['redirect', 303, '/login']] as const)(
    'preserves %s loader status and private cache headers', async (path, status, location) => {
      const response = await fetch(`${base}/${path}`, { redirect: 'manual' });
      expect(response.status).toBe(status);
      expect(response.headers.get('location')).toBe(location);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
    },
  );

  it('streams through the shared runtime with loader payload and streaming headers', async () => {
    const response = await fetch(`${base}/stream`);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('content-length')).toBeNull();
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let html = '';
    let shellAt: number | undefined;
    let slowAt: number | undefined;
    let chunks = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks++;
      html += decoder.decode(value, { stream: true });
      if (shellAt === undefined && html.includes('stream-data')) shellAt = Date.now();
      if (slowAt === undefined && html.includes('slow-stream-resource')) slowAt = Date.now();
    }
    expect(html).toContain('stream-data');
    expect(html).toContain('slow-stream-resource');
    expect(chunks).toBeGreaterThan(1);
    expect(slowAt! - shellAt!).toBeGreaterThan(40);
    expect(html).toContain('__VURA_LOADER__');
    expect(html).toContain('</html>');
  });

  it.each(['stream', 'nested/loader'])('answers HEAD /%s without rendering a response body', async (path) => {
    const response = await fetch(`${base}/${path}`, { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.text()).toBe('');
  });

  it('keeps client components out of SSR and includes the layout chain in browser bundles', async () => {
    const response = await fetch(`${base}/client`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('id="loading"');
    expect(html).not.toContain('browser-only-page');
    for (const path of ['client', 'nested/loader']) {
      const bundle = await fetch(`${base}/_then/pages/${path}.js`);
      expect(bundle.status).toBe(200);
      const code = await bundle.text();
      expect(code).not.toContain('VURA_ACTION_PRIVATE_CANARY_57');
      expect(code).toContain('root-layout:');
      expect(code).toContain('parity#echo');
      expect(code).toContain('/__vura/action');
      if (path.includes('/')) expect(code).toContain('nested-layout:');
    }
  });

  it('registers actions and reaches the native token/CSRF dispatch endpoint', async () => {
    expect((await fetch(`${base}/__vura/action`)).status).toBe(403);
    const tokenResponse = await fetch(`${base}/__vura/action`, { headers: { origin: base } });
    expect(tokenResponse.status).toBe(200);
    const { token } = await tokenResponse.json() as { token: string };
    const cookie = tokenResponse.headers.get('set-cookie')!.split(';')[0]!;
    const post = (csrf: string) => fetch(`${base}/__vura/action`, {
      method: 'POST', headers: {
        origin: base, cookie, 'content-type': 'application/json',
        'x-vura-csrf': csrf, 'x-vura-action': 'parity#echo',
      }, body: JSON.stringify({ args: ['hello'] }),
    });
    expect((await post('invalid')).status).toBe(403);
    const result = await post(token);
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ result: 'hello:VURA_ACTION_PRIVATE_CANARY_57' });
    // Page middleware is deliberately not action authorization; applications
    // must enforce their own user/session permissions inside action handlers.
  });

  it('refreshes API, action and browser dependencies when a shared source changes', async () => {
    const call = await actionCaller();
    expect(await (await fetch(`${base}/api/echo`)).json()).toEqual({ value: 'shared-one' });
    expect(await (await call('parity#shared')).json()).toEqual({ result: 'shared-one' });
    expect(await (await fetch(`${base}/_then/pages/client.js`)).text()).toContain('shared-one');
    await writeFile(join(root, 'src/shared.ts'), "export const sharedValue = 'shared-two';\n");
    await expect.poll(async () => (await (await fetch(`${base}/api/echo`)).json()).value, { timeout: 5000 }).toBe('shared-two');
    expect(await (await call('parity#shared')).json()).toEqual({ result: 'shared-two' });
    expect(await (await fetch(`${base}/_then/pages/client.js`)).text()).toContain('shared-two');
    expect(actionRegistry.ids().filter(id => !initialRegistryIds.includes(id))).toHaveLength(3);
  });

  it('revokes deleted and renamed actions without losing another live action', async () => {
    const call = await actionCaller();
    const parity = join(root, 'src/actions/parity.ts');
    await writeFile(parity, "import { sharedValue } from '../shared.js';\nexport function shared() { return sharedValue; }\n");
    await expect.poll(async () => (await call('parity#echo')).status, { timeout: 5000 }).toBe(404);
    expect(await (await call('parity#echo')).json()).toEqual({ error: 'Action not found' });
    const missingCsrf = await fetch(`${base}/__vura/action`, {
      method: 'POST', headers: { origin: base, 'content-type': 'application/json', 'x-vura-action': 'parity#echo' },
      body: JSON.stringify({ args: [] }),
    });
    expect(missingCsrf.status).toBe(403);
    expect(await missingCsrf.json()).toEqual({ error: 'Invalid or missing CSRF token' });
    expect(await (await call('keep#ping')).json()).toEqual({ result: 'still-alive' });
    expect(actionRegistry.ids().filter(id => !initialRegistryIds.includes(id))).toHaveLength(2);
    const moved = join(root, 'src/actions/moved.ts');
    await rename(parity, moved);
    await expect.poll(async () => (await call('parity#shared')).status, { timeout: 5000 }).toBe(404);
    expect(await (await call('moved#shared')).json()).toEqual({ result: 'shared-two' });
    expect(await (await call('keep#ping')).json()).toEqual({ result: 'still-alive' });
    expect(actionRegistry.ids().filter(id => !initialRegistryIds.includes(id))).toHaveLength(2);
    await rm(moved);
    await expect.poll(async () => (await call('moved#shared')).status, { timeout: 5000 }).toBe(404);
    expect(await (await call('keep#ping')).json()).toEqual({ result: 'still-alive' });
    expect(actionRegistry.ids().filter(id => !initialRegistryIds.includes(id))).toHaveLength(1);
  });
});
