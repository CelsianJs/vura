/**
 * Users API — serverless CRUD
 * Each method becomes its own Lambda/Worker invocation.
 */
export const route = { kind: 'serverless' };

const users = [
  { id: '1', name: 'Alice', email: 'alice@example.com' },
  { id: '2', name: 'Bob', email: 'bob@example.com' },
];

export function GET(req: any, reply: any) {
  return reply.json({ users });
}

export async function POST(req: any, reply: any) {
  const body = req.parsedBody as { name: string; email: string };
  const user = { id: String(users.length + 1), name: body.name, email: body.email };
  users.push(user);
  return reply.status(201).json(user);
}
