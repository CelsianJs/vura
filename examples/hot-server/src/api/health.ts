export const route = { kind: 'hot' };

export function GET(req, reply) {
  return reply.json({
    status: 'ok',
    uptime: process.uptime(),
    memory: process.memoryUsage().rss,
    region: process.env.FLY_REGION || 'local',
  });
}
