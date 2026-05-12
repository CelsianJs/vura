/**
 * GET /api/health — Hot route (persistent server)
 * Tracks uptime — impossible with serverless.
 */
import type { ThenRequest, ThenReply } from '@celsian/then-core';

export const route = { kind: 'hot' as const };

const startedAt = Date.now();
let requestCount = 0;

export function GET(_req: ThenRequest, reply: ThenReply) {
  requestCount++;
  return reply.json({
    status: 'ok',
    uptime: Math.round((Date.now() - startedAt) / 1000),
    requests: requestCount,
    framework: 'ThenJS',
    backend: 'CelsianJS',
  });
}
