/**
 * Single user operations — serverless.
 * GET    /api/users/:id  — get user by ID
 * PUT    /api/users/:id  — update user fields
 * DELETE /api/users/:id  — remove user
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

export function GET(req: any, reply: any) {
  const { id } = req.params;
  const user = users.find(u => u.id === id);

  if (!user) {
    return reply.status(404).json({ error: 'User not found', id });
  }

  return reply.json(user);
}

export async function PUT(req: any, reply: any) {
  const { id } = req.params;
  const user = users.find(u => u.id === id);

  if (!user) {
    return reply.status(404).json({ error: 'User not found', id });
  }

  const body = req.parsedBody as Partial<User>;
  if (body.name) user.name = body.name;
  if (body.email) user.email = body.email;
  if (body.role) user.role = body.role;

  return reply.json(user);
}

export function DELETE(req: any, reply: any) {
  const { id } = req.params;
  const index = users.findIndex(u => u.id === id);

  if (index === -1) {
    return reply.status(404).json({ error: 'User not found', id });
  }

  const [removed] = users.splice(index, 1);
  return reply.json({ deleted: true, user: removed });
}
