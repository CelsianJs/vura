export const route = { kind: 'hot' };

export function POST(req, reply) {
  return reply.json({ echo: req.parsedBody, timestamp: Date.now() });
}
