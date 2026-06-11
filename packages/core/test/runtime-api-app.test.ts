import { describe, it, expect } from 'vitest';
import { createApiApp } from '../src/runtime/api-app.js';

const userRoute = {
  urlPattern: '/api/users/:id', methods: ['GET', 'POST'] as const, kind: 'serverless' as const,
  filePath: 'src/api/users/[id].ts', config: {},
  module: {
    GET: async (req: any, reply: any) => reply.json({ id: req.params.id, q: req.query.v ?? null }),
    POST: async (req: any, reply: any) => reply.status(201).json({ got: req.body }),
  },
};

describe('createApiApp', () => {
  it('registers manifest routes onto a CelsianApp and serves them', async () => {
    const app = createApiApp({ routes: [userRoute as any] });
    const res = await app.handle(new Request('http://localhost/api/users/42?v=1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: '42', q: '1' });
  });

  it('compat: req.body aliases parsedBody and req.headers is index-readable', async () => {
    const app = createApiApp({ routes: [userRoute as any] });
    const res = await app.handle(new Request('http://localhost/api/users/42', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ a: 1 }),
    }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ got: { a: 1 } });
  });

  it('mounts the revalidation webhook at /__vura/revalidate', async () => {
    const webhook = async () => ({ status: 200, body: { revalidated: true } });
    const app = createApiApp({ routes: [], revalidateWebhook: webhook });
    const res = await app.handle(new Request('http://localhost/__vura/revalidate', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paths: ['/x'] }),
    }));
    expect(res.status).toBe(200);
  });

  it('maps global hooks file exports onto celsian hooks', async () => {
    const seen: string[] = [];
    const app = createApiApp({
      routes: [userRoute as any],
      globalHooks: { onRequest: [async (req: any) => { seen.push(new URL(req.url).pathname); }] },
    });
    await app.handle(new Request('http://localhost/api/users/1'));
    expect(seen).toEqual(['/api/users/1']);
  });
});
