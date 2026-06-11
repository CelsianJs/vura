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

  it('handler that throws → app.handle returns 500 with JSON error body', async () => {
    // Error shape from celsian/packages/core/src/error-handler.ts lines 67-71:
    // { error: string, statusCode: number, code: string }
    const throwRoute = {
      urlPattern: '/api/boom', methods: ['GET'] as const, kind: 'serverless' as const,
      filePath: 'src/api/boom.ts', config: {},
      module: {
        GET: async () => { throw new Error('kaboom'); },
      },
    };
    const app = createApiApp({ routes: [throwRoute as any] });
    const res = await app.handle(new Request('http://localhost/api/boom'));
    expect(res.status).toBe(500);
    const body = await res.json() as any;
    expect(typeof body.error).toBe('string');
    expect(body.statusCode).toBe(500);
    expect(typeof body.code).toBe('string');
  });

  it('onResponse shim: vura hook receives (req, reply, info) with numeric statusCode and durationMs', async () => {
    const calls: Array<{ statusCode: unknown; durationMs: unknown; hadError: unknown }> = [];
    const app = createApiApp({
      routes: [userRoute as any],
      globalHooks: {
        onResponse: [
          async (_req: any, _reply: any, info: any) => { calls.push(info); },
        ],
      },
    });
    await app.handle(new Request('http://localhost/api/users/7'));
    // onResponse is fire-and-forget; give microtasks a tick to flush
    await new Promise(r => setTimeout(r, 20));
    expect(calls.length).toBe(1);
    expect(typeof calls[0].statusCode).toBe('number');
    expect(typeof calls[0].durationMs).toBe('number');
    expect(calls[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(calls[0].hadError).toBe(false);
  });

  it('compat C1: GET request → handler sees req.body === undefined', async () => {
    let capturedBody: unknown = 'NOT_SET';
    const getBodyRoute = {
      urlPattern: '/api/bodycheck', methods: ['GET'] as const, kind: 'serverless' as const,
      filePath: 'src/api/bodycheck.ts', config: {},
      module: {
        GET: async (req: any, reply: any) => {
          capturedBody = req.body;
          return reply.json({ ok: true });
        },
      },
    };
    const app = createApiApp({ routes: [getBodyRoute as any] });
    await app.handle(new Request('http://localhost/api/bodycheck'));
    expect(capturedBody).toBeUndefined();
  });
});
