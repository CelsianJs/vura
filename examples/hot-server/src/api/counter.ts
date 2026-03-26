export const route = { kind: 'hot' };

let count = 0;

export function GET(req, reply) {
  return reply.json({ count });
}

export function POST(req, reply) {
  count++;
  return reply.json({ count });
}
