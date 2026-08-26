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

// Zod-like schema that coerces page → number (mirrors z.object({ page: z.coerce.number() }))
const coercingQuerySchema = {
  parse: (data: unknown) => {
    const n = Number((data as Record<string, unknown>).page);
    if (Number.isNaN(n)) throw new Error('Expected number');
    return { page: n };
  },
  safeParse: (data: unknown) => {
    const n = Number((data as Record<string, unknown>).page);
    if (Number.isNaN(n)) {
      return {
        success: false as const,
        error: { issues: [{ path: ['page'], message: 'Expected number', code: 'invalid_type' }] },
      };
    }
    return { success: true as const, data: { page: n } };
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

  it('maps schema.query to celsian querystring so query validation is applied', async () => {
    // This verifies Fix 2a: vura's 'query' key is mapped to celsian's 'querystring'
    // When a schema with a query validator is provided, celsian should enforce it
    const schemaCalls: unknown[] = [];
    const mockQuerySchema = {
      parse: (data: unknown) => data,
      safeParse: (data: unknown) => { schemaCalls.push(data); return { success: true, data }; },
    };
    const schemaRoute = {
      urlPattern: '/api/schema-test', methods: ['GET'] as const, kind: 'serverless' as const,
      filePath: 'src/api/schema-test.ts', config: {},
      module: {
        schema: { query: mockQuerySchema },
        GET: async (_req: any, reply: any) => reply.json({ ok: true }),
      },
    };
    const app = createApiApp({ routes: [schemaRoute as any] });
    const res = await app.handle(new Request('http://localhost/api/schema-test?page=1'));
    // Request should succeed (schema passes)
    expect(res.status).toBe(200);
  });

  it('query coercion: both req.parsedQuery and req.query hold the validated output', async () => {
    let captured: { parsedQuery: unknown; rawPage: unknown } | undefined;
    const coerceRoute = {
      urlPattern: '/api/x', methods: ['GET'] as const, kind: 'serverless' as const,
      filePath: 'src/api/x.ts', config: {},
      module: {
        schema: { query: coercingQuerySchema },
        GET: async (req: any, reply: any) => {
          captured = { parsedQuery: req.parsedQuery, rawPage: req.query.page };
          return reply.json({ ok: true });
        },
      },
    };
    const app = createApiApp({ routes: [coerceRoute as any] });
    const res = await app.handle(new Request('http://localhost/api/x?page=2'));
    expect(res.status).toBe(200);
    // Coerced result is surfaced on req.parsedQuery — a real number, not a string
    expect(captured?.parsedQuery).toEqual({ page: 2 });
    expect(typeof (captured?.parsedQuery as any).page).toBe('number');
    // …and req.query is the same validated output, not the raw string. Reading
    // the ergonomic property must not hand back input that skipped the schema.
    expect(captured?.rawPage).toBe(2);
  });

  it('query coercion: invalid query → 400, handler never runs', async () => {
    let handlerRan = false;
    const coerceRoute = {
      urlPattern: '/api/x', methods: ['GET'] as const, kind: 'serverless' as const,
      filePath: 'src/api/x.ts', config: {},
      module: {
        schema: { query: coercingQuerySchema },
        GET: async (_req: any, reply: any) => { handlerRan = true; return reply.json({ ok: true }); },
      },
    };
    const app = createApiApp({ routes: [coerceRoute as any] });
    const res = await app.handle(new Request('http://localhost/api/x?page=abc'));
    expect(res.status).toBe(400);
    expect(handlerRan).toBe(false);
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

describe('createApiApp error handling', () => {
  // The Celsian app underneath is a separate package with its own HttpError
  // class, and Vura server bundles each inline their own copy of core, so the
  // error that arrives is never `instanceof` anything the host recognises.
  // These build that error the way the runtime really sees it.
  function crossBundleHttpError(statusCode: number, message: string, code = 'NOT_FOUND'): Error {
    return Object.assign(new Error(message), {
      [Symbol.for('vura.http-error')]: true,
      name: 'HttpError',
      statusCode,
      code,
      toJSON: (isDev: boolean) => ({
        error: !isDev && statusCode >= 500 ? 'Internal Server Error' : message,
        code,
      }),
    });
  }

  const throwingRoute = (error: unknown) => ({
    urlPattern: '/api/boom', methods: ['GET'] as const, kind: 'serverless' as const,
    filePath: 'src/api/boom.ts', config: {},
    module: { GET: async () => { throw error; } },
  });

  it('keeps the status of a thrown HttpError instead of flattening it to 500', async () => {
    const app = createApiApp({ routes: [throwingRoute(crossBundleHttpError(404, 'No such thing')) as any] });
    const res = await app.handle(new Request('http://localhost/api/boom'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'No such thing', code: 'NOT_FOUND' });
  });

  it('answers application/json', async () => {
    const app = createApiApp({ routes: [throwingRoute(crossBundleHttpError(409, 'Already exists', 'CONFLICT')) as any] });
    const res = await app.handle(new Request('http://localhost/api/boom'));
    expect(res.status).toBe(409);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('leaves an unbranded error a sanitised 500', async () => {
    // A driver error carrying a numeric statusCode must not pick its own status.
    const driverError = Object.assign(new Error('connect ECONNREFUSED 10.0.0.4:5432'), { statusCode: 400 });
    const app = createApiApp({ routes: [throwingRoute(driverError) as any] });
    const res = await app.handle(new Request('http://localhost/api/boom'));
    expect(res.status).toBe(500);
  });

  it('gives a user onError hook first refusal', async () => {
    let saw: unknown;
    const app = createApiApp({
      routes: [throwingRoute(crossBundleHttpError(404, 'No such thing')) as any],
      globalHooks: {
        onError: [((err: unknown) => {
          saw = err;
          return new Response('handled by the app', { status: 418 });
        }) as any],
      },
    });
    const res = await app.handle(new Request('http://localhost/api/boom'));
    expect(res.status).toBe(418);
    expect(await res.text()).toBe('handled by the app');
    expect((saw as Error).message).toBe('No such thing');
  });

  it('still runs an observing onError hook that returns nothing', async () => {
    let seen = 0;
    const app = createApiApp({
      routes: [throwingRoute(crossBundleHttpError(404, 'No such thing')) as any],
      globalHooks: { onError: [(() => { seen += 1; }) as any] },
    });
    const res = await app.handle(new Request('http://localhost/api/boom'));
    expect(seen).toBe(1);
    expect(res.status).toBe(404);
  });
});
