/**
 * GET /api/error — Intentionally throws
 * Tests that error handling doesn't leak stack traces to the client.
 */

export const route = { kind: 'hot' as const };

export function GET(_req: any, _reply: any) {
  throw new Error('Intentional test error: this should not leak stack traces');
}
