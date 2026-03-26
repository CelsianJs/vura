/**
 * Users collection — serverless CRUD.
 * GET  /api/users       — list all users (supports ?role= filter)
 * POST /api/users       — create a new user
 */
export const route = { kind: 'serverless' };

interface User {
  id: string;
  name: string;
  email: string;
  role: string;
  createdAt: string;
}

const users: User[] = [
  { id: '1', name: 'Alice', email: 'alice@example.com', role: 'admin', createdAt: '2025-01-01T00:00:00Z' },
  { id: '2', name: 'Bob', email: 'bob@example.com', role: 'user', createdAt: '2025-01-15T00:00:00Z' },
  { id: '3', name: 'Charlie', email: 'charlie@example.com', role: 'user', createdAt: '2025-02-01T00:00:00Z' },
];

let nextId = 4;

export function GET(req: any, reply: any) {
  const role = req.query?.role;
  const filtered = role ? users.filter(u => u.role === role) : users;
  return reply.json({ users: filtered, total: filtered.length });
}

export async function POST(req: any, reply: any) {
  const body = req.parsedBody as { name: string; email: string; role?: string };

  if (!body?.name || !body?.email) {
    return reply.status(400).json({ error: 'name and email are required' });
  }

  const user: User = {
    id: String(nextId++),
    name: body.name,
    email: body.email,
    role: body.role ?? 'user',
    createdAt: new Date().toISOString(),
  };

  users.push(user);
  return reply.status(201).json(user);
}
