/**
 * Health check endpoint — runs on the hot server.
 * Returns system info: uptime, memory usage, and Node.js version.
 */
export const route = { kind: 'hot' };

export function GET(req: any, reply: any) {
  const mem = process.memoryUsage();
  return reply.json({
    status: 'ok',
    uptime: process.uptime(),
    memory: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      external: mem.external,
    },
    node: process.version,
    platform: process.platform,
    timestamp: Date.now(),
  });
}
