export const route = { kind: 'serverless' as const };
export async function GET(req: any, reply: any) {
  return reply.json({ id: req.params.id });
}
export async function POST(req: any, reply: any) {
  return reply.status(201).json({ id: req.params.id, body: req.parsedBody });
}
