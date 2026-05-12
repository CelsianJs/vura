/**
 * /api/users — Serverless CRUD
 */
import type { ThenRequest, ThenReply } from '@celsian/then-core';

export const route = { kind: 'serverless' as const };

const users = [
  { id: 1, name: 'Alice', role: 'admin' },
  { id: 2, name: 'Bob', role: 'user' },
  { id: 3, name: 'Charlie', role: 'user' },
];

export function GET(_req: ThenRequest, reply: ThenReply) {
  return reply.json({ users });
}

export function POST(req: ThenRequest, reply: ThenReply) {
  const body = req.parsedBody as { name: string; role?: string };
  if (!body?.name) {
    return reply.status(400).json({ error: 'Name is required' });
  }
  const newUser = { id: users.length + 1, name: body.name, role: body.role ?? 'user' };
  users.push(newUser);
  return reply.status(201).json({ user: newUser });
}
