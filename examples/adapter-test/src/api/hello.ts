export const route = { kind: 'serverless' as const };
export async function GET(req: any, reply: any) {
  return reply.json({ message: 'hello' });
}
