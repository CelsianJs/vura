/**
 * Single user endpoint with dynamic param.
 * Runs as a hot server endpoint (needs persistent state for demo).
 */
export const route = { kind: 'hot' };

export function GET(req: any, reply: any) {
  const { id } = req.params;
  return reply.json({ id, name: `User ${id}` });
}

export function DELETE(req: any, reply: any) {
  const { id } = req.params;
  return reply.json({ deleted: id });
}
