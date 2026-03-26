/**
 * /api/users/:id — Serverless route
 * GET: extract param, return user data
 * POST: parse body, create resource
 */

export const route = { kind: 'serverless' as const };

const users: Record<string, { id: string; name: string; email: string }> = {
  '42': { id: '42', name: 'Alice', email: 'alice@example.com' },
  '99': { id: '99', name: 'Bob', email: 'bob@example.com' },
};

export function GET(req: any, reply: any) {
  const { id } = req.params;
  const user = users[id];

  if (!user) {
    return reply.status(404).json({ error: 'User not found', id });
  }

  return reply.json({ user });
}

export function POST(req: any, reply: any) {
  const body = req.parsedBody as { name?: string; email?: string };
  const { id } = req.params;

  if (!body?.name) {
    return reply.status(400).json({ error: 'Name is required' });
  }

  const newUser = { id, name: body.name, email: body.email || '' };
  users[id] = newUser;

  return reply.status(201).json({ user: newUser });
}
