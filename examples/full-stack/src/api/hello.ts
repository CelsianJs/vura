/**
 * GET /api/hello — Serverless route
 * Runs on CF Workers or Lambda (stateless, auto-scaling)
 */
import type { ThenRequest, ThenReply } from '@celsian/then-core';

export const route = { kind: 'serverless' as const };

export function GET(req: ThenRequest, reply: ThenReply) {
  return reply.json({
    message: 'Hello from ThenJS!',
    timestamp: new Date().toISOString(),
  });
}
