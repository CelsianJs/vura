export const route = { kind: 'hot' as const };
export async function GET(req: any, reply: any) {
  return reply.json({ type: 'hot' });
}
