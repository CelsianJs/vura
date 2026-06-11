/**
 * Tests for startVuraServer — the top-level runtime compositor.
 *
 * Uses port: 0 so the OS assigns a free port; srv.port is the actual value.
 * Signal handlers are NOT installed (installSignalHandlers: false, which is
 * also the default when NODE_ENV === 'test') to avoid accumulation across tests.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { startVuraServer, type VuraServer } from '../src/runtime/server.js';
import { h } from 'what-framework';

let srv: VuraServer | undefined;
afterEach(async () => {
  await srv?.close();
  srv = undefined;
});

const base = () => `http://127.0.0.1:${srv!.port}`;

describe('startVuraServer', () => {
  it('composes api + pages + health on one port', async () => {
    srv = await startVuraServer({
      port: 0,
      apiRoutes: [
        {
          urlPattern: '/api/ping',
          methods: ['GET'],
          kind: 'serverless',
          filePath: 'src/api/ping.ts',
          config: {},
          module: {
            GET: async (_req: any, reply: any) => reply.json({ pong: true }),
          },
        } as any,
      ],
      pages: [
        {
          urlPattern: '/hello/:name',
          mode: 'server',
          filePath: 'src/pages/hello/[name].tsx',
          hasGetServerData: false,
          config: {},
          module: {
            default: (p: any) => h('h1', null, `Hi ${p.params.name}`),
            page: { title: 'Hi' },
          },
        } as any,
      ],
      cache: {},
    });

    // Health endpoint
    const health = await (await fetch(`${base()}/__health`)).json();
    expect(health.ok).toBe(true);

    // API route
    const pong = await (await fetch(`${base()}/api/ping`)).json();
    expect(pong).toEqual({ pong: true });

    // SSR page
    const html = await (await fetch(`${base()}/hello/kirby`)).text();
    expect(html).toContain('<h1>Hi kirby</h1>');
  }, 10000);

  it('returns 503 during shutdown for new requests', async () => {
    srv = await startVuraServer({
      port: 0,
      apiRoutes: [],
      pages: [],
      cache: {},
    });

    // Confirm healthy first
    const before = await (await fetch(`${base()}/__health`)).json();
    expect(before.ok).toBe(true);

    // Close the server
    await srv.close();

    // New requests should fail (connection refused) — close() stops accepting
    let threw = false;
    try {
      await fetch(`${base()}/__health`);
    } catch (_) {
      threw = true;
    }
    expect(threw).toBe(true);

    // Prevent afterEach from double-closing
    srv = undefined;
  }, 10000);

  it('ISR: revalidate pages serve HIT on repeat and purge via /__vura/revalidate', async () => {
    let renders = 0;
    srv = await startVuraServer({
      port: 0,
      apiRoutes: [],
      pages: [
        {
          urlPattern: '/cached',
          mode: 'server',
          filePath: 'src/pages/cached.tsx',
          hasGetServerData: false,
          config: { revalidate: 300 },
          module: {
            default: () => {
              renders++;
              return h('p', null, `render ${renders}`);
            },
          },
        } as any,
      ],
      cache: { revalidateSecret: 'sek' },
    });

    // Two fetches — should only render once (ISR cache HIT on 2nd)
    await fetch(`${base()}/cached`);
    await fetch(`${base()}/cached`);
    expect(renders).toBe(1);

    // Purge via revalidation webhook
    const purge = await fetch(`${base()}/__vura/revalidate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-vura-revalidate-secret': 'sek',
      },
      body: JSON.stringify({ paths: ['/cached'] }),
    });
    expect(purge.status).toBe(200);

    // After purge — should render again
    await fetch(`${base()}/cached`);
    expect(renders).toBe(2);
  }, 15000);

  it('health check returns framework: Vura', async () => {
    srv = await startVuraServer({
      port: 0,
      apiRoutes: [],
      pages: [],
      cache: {},
    });
    const body = await (await fetch(`${base()}/__health`)).json();
    expect(body).toEqual({ ok: true, framework: 'Vura' });
  }, 5000);

  it('unknown paths return 404', async () => {
    srv = await startVuraServer({
      port: 0,
      apiRoutes: [],
      pages: [],
      cache: {},
    });
    const res = await fetch(`${base()}/does-not-exist`);
    expect(res.status).toBe(404);
  }, 5000);
});
