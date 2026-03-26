/**
 * GET /api/health — Hot route (persistent server)
 * Tracks uptime and request count.
 */

export const route = { kind: 'hot' as const };

const startedAt = Date.now();
let requestCount = 0;

export function GET(_req: any, reply: any) {
  requestCount++;
  return reply.json({
    status: 'ok',
    uptime: Math.round((Date.now() - startedAt) / 1000),
    requests: requestCount,
    framework: 'ThenJS',
  });
}
