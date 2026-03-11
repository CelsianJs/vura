/**
 * Health check — always on the hot server.
 */
export const route = { kind: 'hot' };

export function GET(req: any, reply: any) {
  return reply.json({
    status: 'ok',
    uptime: process.uptime(),
    memory: process.memoryUsage().rss,
  });
}
