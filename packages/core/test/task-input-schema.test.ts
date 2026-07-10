/**
 * Vura Tasks Phase 1 — typed input schemas + attempt metadata + envelope.
 *
 * Covers:
 *   - validateTaskInput: bare Zod-like schema, defineSchema RouteSchema, no-schema
 *     pass-through, unrecognised shape pass-through, coercion.
 *   - runTaskOnce input validation: 400 body + zero attempts on failure; handler
 *     not invoked; coerced value reaches the handler.
 *   - attempt metadata: success first try, success after retries, exhausted
 *     retries (indexes, ISO startedAt, durationMs, per-attempt error strings).
 *   - buildTaskEnvelope: ok/taskName/attempts/result shape on success and failure.
 *
 * Zod is not a dependency here — tests use a hand-rolled Zod-like schema, the same
 * approach as validation.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { defineSchema, validateTaskInput } from '../src/validation.js';
import type { ZodLikeSchema } from '../src/validation.js';
import { runTaskOnce, buildTaskEnvelope } from '../src/runtime/tasks.js';

// ─── Zod-like helpers (mirror validation.test.ts) ───

/** A schema that requires `name: string` and coerces `count` to a number. */
function personSchema(): ZodLikeSchema<{ name: string; count: number }> {
  return {
    parse(data: unknown) {
      const r = this.safeParse(data);
      if (!r.success) throw new Error(r.error?.issues[0]?.message ?? 'invalid');
      return r.data as { name: string; count: number };
    },
    safeParse(data: unknown) {
      if (data == null || typeof data !== 'object') {
        return { success: false, error: { issues: [{ path: [], message: 'Expected object', code: 'invalid_type' }] } };
      }
      const obj = data as Record<string, unknown>;
      const issues: Array<{ path: (string | number)[]; message: string; code: string }> = [];
      if (typeof obj.name !== 'string') {
        issues.push({ path: ['name'], message: 'name is required', code: 'invalid_type' });
      }
      const count = obj.count === undefined ? 0 : Number(obj.count);
      if (Number.isNaN(count)) {
        issues.push({ path: ['count'], message: 'count must be numeric', code: 'invalid_type' });
      }
      if (issues.length > 0) return { success: false, error: { issues } };
      return { success: true, data: { name: obj.name as string, count } };
    },
  };
}

// ─── validateTaskInput ───────────────────────────────────────────────────────

describe('validateTaskInput', () => {
  it('passes through when no schema is exported', () => {
    const r = validateTaskInput({ anything: true }, undefined);
    expect(r).toEqual({ ok: true, value: { anything: true } });
  });

  it('passes through for an unrecognised schema shape', () => {
    const r = validateTaskInput({ a: 1 }, { not: 'a schema' });
    expect(r).toEqual({ ok: true, value: { a: 1 } });
  });

  it('validates a bare Zod-like schema and returns the coerced value', () => {
    const r = validateTaskInput({ name: 'x', count: '5' }, personSchema());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ name: 'x', count: 5 });
  });

  it('validates a defineSchema({ body }) RouteSchema', () => {
    const schema = defineSchema({ body: personSchema() });
    const r = validateTaskInput({ name: 'y', count: 2 }, schema);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ name: 'y', count: 2 });
  });

  it('returns the standard 400 error body on failure', () => {
    const r = validateTaskInput({ count: 'nope' }, personSchema());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('VALIDATION_FAILED');
      expect(r.body.error).toMatch(/Validation failed/);
      expect(r.body.details[0]?.target).toBe('body');
      expect(JSON.stringify(r.body.details)).toContain('name is required');
    }
  });
});

// ─── runTaskOnce input validation ────────────────────────────────────────────

describe('runTaskOnce input validation', () => {
  it('does not invoke the handler and consumes no attempts on invalid input', async () => {
    let called = 0;
    const result = await runTaskOnce({
      name: 'validated',
      config: { retries: 3 },
      handler: () => { called++; return 'ok'; },
      inputSchema: personSchema(),
    }, { input: { count: 'bad' } });

    expect(called).toBe(0);
    expect(result.status).toBe('failed');
    expect(result.attempts).toBe(0);
    expect(result.attemptRecords).toEqual([]);
    expect(result.validationError?.statusCode).toBe(400);
    expect((result.validationError?.body as { code: string }).code).toBe('VALIDATION_FAILED');
  });

  it('passes the coerced value to the handler on valid input', async () => {
    let seen: unknown;
    const result = await runTaskOnce({
      name: 'validated',
      config: {},
      handler: ({ input }) => { seen = input; return input; },
      inputSchema: personSchema(),
    }, { input: { name: 'z', count: '9' } });

    expect(result.status).toBe('completed');
    expect(seen).toEqual({ name: 'z', count: 9 });
    expect(result.validationError).toBeUndefined();
  });

  it('is a no-op when the task exports no input schema', async () => {
    const result = await runTaskOnce({
      name: 'plain', config: {}, handler: ({ input }) => input,
    }, { input: { raw: true } });
    expect(result.status).toBe('completed');
    expect(result.result).toEqual({ raw: true });
  });
});

// ─── Attempt metadata ────────────────────────────────────────────────────────

describe('runTaskOnce attempt metadata', () => {
  it('records a single successful attempt on first try', async () => {
    const result = await runTaskOnce({
      name: 't', config: {}, handler: () => 'done',
    }, { input: null });

    expect(result.attemptRecords).toHaveLength(1);
    expect(result.attempts).toBe(1);
    const [a] = result.attemptRecords;
    expect(a.index).toBe(1);
    expect(a.error).toBeUndefined();
    expect(typeof a.durationMs).toBe('number');
    expect(a.durationMs).toBeGreaterThanOrEqual(0);
    // startedAt is a valid ISO string
    expect(a.startedAt).toBe(new Date(a.startedAt).toISOString());
  });

  it('records failed attempts then the success (retries)', async () => {
    const result = await runTaskOnce({
      name: 't', config: { retries: 2 },
      handler: ({ attempt }) => { if (attempt < 3) throw new Error(`boom-${attempt}`); return 'ok'; },
    }, { input: null });

    expect(result.status).toBe('completed');
    expect(result.attemptRecords).toHaveLength(3);
    expect(result.attemptRecords.map((a) => a.index)).toEqual([1, 2, 3]);
    expect(result.attemptRecords[0].error).toBe('boom-1');
    expect(result.attemptRecords[1].error).toBe('boom-2');
    expect(result.attemptRecords[2].error).toBeUndefined();
  });

  it('records every attempt with an error when retries are exhausted', async () => {
    const result = await runTaskOnce({
      name: 't', config: { retries: 2 },
      handler: () => { throw new Error('always'); },
    }, { input: null });

    expect(result.status).toBe('failed');
    expect(result.error).toBe('always');
    expect(result.attemptRecords).toHaveLength(3);
    expect(result.attempts).toBe(3);
    for (const a of result.attemptRecords) {
      expect(a.error).toBe('always');
      expect(a.startedAt).toBe(new Date(a.startedAt).toISOString());
    }
  });
});

// ─── buildTaskEnvelope ───────────────────────────────────────────────────────

describe('buildTaskEnvelope', () => {
  it('builds { ok, taskName, attempts, result } on success', async () => {
    const result = await runTaskOnce({ name: 'echo', config: {}, handler: () => ({ v: 1 }) }, { input: null });
    const env = buildTaskEnvelope('tasks.echo', result);
    expect(env).toEqual({
      ok: true,
      taskName: 'tasks.echo',
      attempts: result.attemptRecords,
      result: { v: 1 },
    });
  });

  it('omits result and sets ok:false on failure', async () => {
    const result = await runTaskOnce({ name: 'x', config: {}, handler: () => { throw new Error('nope'); } }, { input: null });
    const env = buildTaskEnvelope('tasks.x', result);
    expect(env.ok).toBe(false);
    expect(env.taskName).toBe('tasks.x');
    expect('result' in env).toBe(false);
    expect(env.attempts[0].error).toBe('nope');
  });
});
