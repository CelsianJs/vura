import { describe, it, expect, vi } from 'vitest';
import {
  defineSchema,
  validate,
  withValidation,
  validateRequest,
} from '../src/validation.js';
import type { ThenRequest, ThenReply } from '../src/handler.js';
import type { RouteSchema, ZodLikeSchema } from '../src/validation.js';

// ─── Zod-like Mock Schema (mimics Zod's API without importing it) ───

function createMockSchema<T>(
  validator: (data: unknown) => { success: boolean; data?: T; error?: string },
): ZodLikeSchema<T> {
  return {
    parse(data: unknown): T {
      const result = validator(data);
      if (!result.success) {
        throw new Error(result.error ?? 'Validation failed');
      }
      return result.data as T;
    },
    safeParse(data: unknown) {
      const result = validator(data);
      if (!result.success) {
        return {
          success: false,
          error: {
            issues: [
              {
                path: [],
                message: result.error ?? 'Validation failed',
                code: 'custom',
              },
            ],
          },
        };
      }
      return { success: true, data: result.data };
    },
  };
}

function objectSchema<T extends Record<string, unknown>>(
  shape: Record<string, { type: string; required?: boolean }>,
): ZodLikeSchema<T> {
  return {
    parse(data: unknown): T {
      const result = this.safeParse(data);
      if (!result.success) {
        throw new Error(result.error?.issues[0]?.message ?? 'Validation failed');
      }
      return result.data as T;
    },
    safeParse(data: unknown) {
      if (data == null || typeof data !== 'object') {
        return {
          success: false,
          error: {
            issues: [{ path: [], message: 'Expected object', code: 'invalid_type' }],
          },
        };
      }
      const obj = data as Record<string, unknown>;
      const issues: Array<{ path: (string | number)[]; message: string; code: string }> = [];

      for (const [key, spec] of Object.entries(shape)) {
        const value = obj[key];
        if (spec.required !== false && (value === undefined || value === null)) {
          issues.push({
            path: [key],
            message: `${key} is required`,
            code: 'invalid_type',
          });
          continue;
        }
        if (value !== undefined && value !== null && typeof value !== spec.type) {
          issues.push({
            path: [key],
            message: `Expected ${spec.type}, received ${typeof value}`,
            code: 'invalid_type',
          });
        }
      }

      if (issues.length > 0) {
        return { success: false, error: { issues } };
      }

      return { success: true, data: data as T };
    },
  };
}

// ─── Test Helpers ───

function createRequest(overrides: Partial<ThenRequest> = {}): ThenRequest {
  return {
    method: 'POST',
    url: '/api/test',
    headers: {},
    params: {},
    query: {},
    parsedBody: null,
    ...overrides,
  };
}

function createReply(): ThenReply & { _status: number; _data: unknown; _headers: Record<string, string> } {
  const state = { _status: 200, _data: null as unknown, _headers: {} as Record<string, string> };
  const reply: ThenReply & typeof state = {
    ...state,
    status(code: number) { state._status = code; reply._status = code; return reply; },
    header(name: string, value: string) { state._headers[name] = value; reply._headers = state._headers; return reply; },
    json(data: unknown) { state._data = data; reply._data = data; return null; },
    send(data: string) { state._data = data; reply._data = data; return null; },
  };
  return reply;
}

// ─── Tests ───

describe('defineSchema', () => {
  it('returns the schema unchanged', () => {
    const bodySchema = objectSchema({ name: { type: 'string' } });
    const schema = defineSchema({ body: bodySchema });
    expect(schema.body).toBe(bodySchema);
  });

  it('supports all three schema targets', () => {
    const schema = defineSchema({
      body: objectSchema({ name: { type: 'string' } }),
      query: objectSchema({ page: { type: 'string', required: false } }),
      params: objectSchema({ id: { type: 'string' } }),
    });
    expect(schema.body).toBeDefined();
    expect(schema.query).toBeDefined();
    expect(schema.params).toBeDefined();
  });

  it('allows partial schema definition', () => {
    const schema = defineSchema({
      body: objectSchema({ email: { type: 'string' } }),
    });
    expect(schema.body).toBeDefined();
    expect(schema.query).toBeUndefined();
    expect(schema.params).toBeUndefined();
  });
});

describe('validate', () => {
  it('validates body successfully', () => {
    const schema = defineSchema({
      body: objectSchema<{ name: string }>({ name: { type: 'string' } }),
    });
    const req = createRequest({ parsedBody: { name: 'Alice' } });

    const result = validate(req, schema);
    expect(result.success).toBe(true);
    expect(result.data?.body).toEqual({ name: 'Alice' });
  });

  it('returns errors for invalid body', () => {
    const schema = defineSchema({
      body: objectSchema({ name: { type: 'string' } }),
    });
    const req = createRequest({ parsedBody: { name: 42 } });

    const result = validate(req, schema);
    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors![0].target).toBe('body');
    expect(result.errors![0].issues.length).toBeGreaterThan(0);
  });

  it('validates query parameters', () => {
    const schema = defineSchema({
      query: objectSchema<{ search: string }>({ search: { type: 'string' } }),
    });
    const req = createRequest({ query: { search: 'test' } });

    const result = validate(req, schema);
    expect(result.success).toBe(true);
    expect(result.data?.query).toEqual({ search: 'test' });
  });

  it('validates route params', () => {
    const schema = defineSchema({
      params: objectSchema<{ id: string }>({ id: { type: 'string' } }),
    });
    const req = createRequest({ params: { id: '42' } });

    const result = validate(req, schema);
    expect(result.success).toBe(true);
    expect(result.data?.params).toEqual({ id: '42' });
  });

  it('validates all three targets simultaneously', () => {
    const schema = defineSchema({
      body: objectSchema<{ name: string }>({ name: { type: 'string' } }),
      query: objectSchema<{ page: string }>({ page: { type: 'string', required: false } }),
      params: objectSchema<{ id: string }>({ id: { type: 'string' } }),
    });
    const req = createRequest({
      parsedBody: { name: 'Alice' },
      query: { page: '1' },
      params: { id: '42' },
    });

    const result = validate(req, schema);
    expect(result.success).toBe(true);
    expect(result.data?.body).toEqual({ name: 'Alice' });
    expect(result.data?.query).toEqual({ page: '1' });
    expect(result.data?.params).toEqual({ id: '42' });
  });

  it('collects errors from multiple targets', () => {
    const schema = defineSchema({
      body: objectSchema({ name: { type: 'string' } }),
      params: objectSchema({ id: { type: 'string' } }),
    });
    const req = createRequest({
      parsedBody: null,
      params: {},
    });

    const result = validate(req, schema);
    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(2);
    const targets = result.errors!.map(e => e.target).sort();
    expect(targets).toEqual(['body', 'params']);
  });

  it('skips validation for undefined schemas', () => {
    const schema = defineSchema({}); // no schemas at all
    const req = createRequest({ parsedBody: { anything: true } });

    const result = validate(req, schema);
    expect(result.success).toBe(true);
  });

  it('passes through raw data when schema is not defined for a target', () => {
    const schema = defineSchema({
      body: objectSchema<{ name: string }>({ name: { type: 'string' } }),
    });
    const req = createRequest({
      parsedBody: { name: 'Alice' },
      query: { extra: 'param' },
      params: { id: '42' },
    });

    const result = validate(req, schema);
    expect(result.success).toBe(true);
    expect(result.data?.query).toEqual({ extra: 'param' });
    expect(result.data?.params).toEqual({ id: '42' });
  });

  it('formats error paths correctly', () => {
    const schema = defineSchema({
      body: objectSchema({ name: { type: 'string' }, email: { type: 'string' } }),
    });
    const req = createRequest({ parsedBody: {} });

    const result = validate(req, schema);
    expect(result.success).toBe(false);
    const issues = result.errors![0].issues;
    expect(issues.length).toBe(2);
    expect(issues[0].path).toBe('name');
    expect(issues[1].path).toBe('email');
  });
});

describe('withValidation', () => {
  it('calls handler with validated data on success', async () => {
    const schema = defineSchema({
      body: objectSchema<{ name: string }>({ name: { type: 'string' } }),
    });
    const handler = vi.fn((_req, reply) => reply.json({ ok: true }));
    const wrapped = withValidation(schema, handler);

    const req = createRequest({ parsedBody: { name: 'Alice' } });
    const reply = createReply();

    await wrapped(req, reply);

    expect(handler).toHaveBeenCalledOnce();
    const calledReq = handler.mock.calls[0][0];
    expect(calledReq.validated.body).toEqual({ name: 'Alice' });
  });

  it('returns 400 with error details on validation failure', async () => {
    const schema = defineSchema({
      body: objectSchema({ name: { type: 'string' } }),
    });
    const handler = vi.fn();
    const wrapped = withValidation(schema, handler);

    const req = createRequest({ parsedBody: null });
    const reply = createReply();

    await wrapped(req, reply);

    expect(handler).not.toHaveBeenCalled();
    expect(reply._status).toBe(400);
    expect((reply._data as any).code).toBe('VALIDATION_FAILED');
    expect((reply._data as any).details).toBeDefined();
  });

  it('preserves handler return value', async () => {
    const schema = defineSchema({});
    const handler = vi.fn((_req, reply) => reply.json({ result: 42 }));
    const wrapped = withValidation(schema, handler);

    const req = createRequest();
    const reply = createReply();

    await wrapped(req, reply);
    expect(reply._data).toEqual({ result: 42 });
  });
});

describe('validateRequest', () => {
  it('returns null on success and attaches validated data', () => {
    const schema = defineSchema({
      body: objectSchema<{ name: string }>({ name: { type: 'string' } }),
    });
    const req = createRequest({ parsedBody: { name: 'Bob' } });

    const error = validateRequest(req, schema);
    expect(error).toBeNull();
    expect((req as any).validated.body).toEqual({ name: 'Bob' });
  });

  it('returns error object on failure', () => {
    const schema = defineSchema({
      body: objectSchema({ name: { type: 'string' } }),
    });
    const req = createRequest({ parsedBody: null });

    const error = validateRequest(req, schema);
    expect(error).not.toBeNull();
    expect(error!.statusCode).toBe(400);
    expect((error!.body as any).code).toBe('VALIDATION_FAILED');
  });

  it('does not attach validated data on failure', () => {
    const schema = defineSchema({
      body: objectSchema({ name: { type: 'string' } }),
    });
    const req = createRequest({ parsedBody: null });

    validateRequest(req, schema);
    expect((req as any).validated).toBeUndefined();
  });

  it('puts coerced query on req.parsedQuery and leaves req.query raw', () => {
    const coercingQuery = createMockSchema<{ page: number }>(data => {
      const n = Number((data as Record<string, unknown>).page);
      if (Number.isNaN(n)) return { success: false, error: 'Expected number' };
      return { success: true, data: { page: n } };
    });
    const schema = defineSchema({ query: coercingQuery });
    const req = createRequest({ query: { page: '2' } });

    const error = validateRequest(req, schema);
    expect(error).toBeNull();
    // raw query untouched — still the original string
    expect(req.query).toEqual({ page: '2' });
    // coerced result on parsedQuery (matches Node/celsian runtime)
    expect(req.parsedQuery).toEqual({ page: 2 });
    expect(typeof (req.parsedQuery as { page: number }).page).toBe('number');
    // validated.query carries the coerced data
    expect((req as any).validated.query).toEqual({ page: 2 });
  });

  it('does not set req.parsedQuery when the schema declares no query', () => {
    const schema = defineSchema({
      body: objectSchema<{ name: string }>({ name: { type: 'string' } }),
    });
    const req = createRequest({ parsedBody: { name: 'Bob' }, query: { page: '2' } });

    const error = validateRequest(req, schema);
    expect(error).toBeNull();
    // no query schema → parsedQuery stays unset (matches celsian + adapters)
    expect(req.parsedQuery).toBeUndefined();
    // raw query untouched
    expect(req.query).toEqual({ page: '2' });
  });

  it('invalid query still returns a 400 error object', () => {
    const coercingQuery = createMockSchema<{ page: number }>(data => {
      const n = Number((data as Record<string, unknown>).page);
      if (Number.isNaN(n)) return { success: false, error: 'Expected number' };
      return { success: true, data: { page: n } };
    });
    const schema = defineSchema({ query: coercingQuery });
    const req = createRequest({ query: { page: 'abc' } });

    const error = validateRequest(req, schema);
    expect(error).not.toBeNull();
    expect(error!.statusCode).toBe(400);
    expect(req.parsedQuery).toBeUndefined();
    expect(req.query).toEqual({ page: 'abc' });
  });
});

describe('validation error format', () => {
  it('includes structured error code', () => {
    const schema = defineSchema({
      body: objectSchema({ name: { type: 'string' } }),
    });
    const req = createRequest({ parsedBody: {} });

    const result = validate(req, schema);
    expect(result.success).toBe(false);
    expect(result.errors![0].issues[0]).toHaveProperty('code');
  });

  it('produces human-readable error summary', () => {
    const schema = defineSchema({
      body: objectSchema({ name: { type: 'string' } }),
    });
    const req = createRequest({ parsedBody: null });
    const reply = createReply();

    const handler = vi.fn();
    const wrapped = withValidation(schema, handler);
    wrapped(req, reply);

    const body = reply._data as any;
    expect(body.error).toContain('Validation failed');
    expect(body.error).toContain('body');
  });

  it('handles multiple issues per target', () => {
    const schema = defineSchema({
      body: objectSchema({
        name: { type: 'string' },
        email: { type: 'string' },
        age: { type: 'number' },
      }),
    });
    const req = createRequest({ parsedBody: {} });

    const result = validate(req, schema);
    expect(result.success).toBe(false);
    expect(result.errors![0].issues.length).toBe(3);
  });

  it('pluralizes issue count correctly', () => {
    const schema = defineSchema({
      body: objectSchema({ name: { type: 'string' } }),
    });
    const req = createRequest({ parsedBody: null });
    const reply = createReply();
    const wrapped = withValidation(schema, vi.fn());
    wrapped(req, reply);

    const body = reply._data as any;
    expect(body.error).toContain('1 issue in body');
  });

  it('lists multiple failed targets', () => {
    const schema = defineSchema({
      body: objectSchema({ name: { type: 'string' } }),
      params: objectSchema({ id: { type: 'string' } }),
    });
    const req = createRequest({ parsedBody: null, params: {} });
    const reply = createReply();
    const wrapped = withValidation(schema, vi.fn());
    wrapped(req, reply);

    const body = reply._data as any;
    expect(body.error).toContain('body');
    expect(body.error).toContain('params');
  });
});

describe('Zod-like schema compatibility', () => {
  it('works with custom safeParse implementations', () => {
    const emailSchema = createMockSchema<string>((data) => {
      if (typeof data !== 'string' || !data.includes('@')) {
        return { success: false, error: 'Invalid email format' };
      }
      return { success: true, data };
    });

    const schema = defineSchema({
      body: {
        parse(data: unknown) {
          const obj = data as { email?: unknown };
          if (!obj || typeof obj !== 'object') throw new Error('Expected object');
          emailSchema.parse(obj.email);
          return data;
        },
        safeParse(data: unknown) {
          if (!data || typeof data !== 'object') {
            return {
              success: false,
              error: {
                issues: [{ path: [], message: 'Expected object', code: 'invalid_type' }],
              },
            };
          }
          const obj = data as { email?: unknown };
          const emailResult = emailSchema.safeParse(obj.email);
          if (!emailResult.success) {
            return {
              success: false,
              error: {
                issues: [{ path: ['email'], message: 'Invalid email format', code: 'custom' }],
              },
            };
          }
          return { success: true, data };
        },
      },
    });

    const goodReq = createRequest({ parsedBody: { email: 'test@example.com' } });
    expect(validate(goodReq, schema).success).toBe(true);

    const badReq = createRequest({ parsedBody: { email: 'not-an-email' } });
    const result = validate(badReq, schema);
    expect(result.success).toBe(false);
    expect(result.errors![0].issues[0].path).toBe('email');
  });
});
