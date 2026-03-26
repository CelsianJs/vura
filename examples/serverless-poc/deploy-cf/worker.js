/**
 * ThenJS Serverless POC — Cloudflare Worker
 *
 * This is what @then/adapter-cloudflare generates:
 * a Worker entry that routes requests to handler functions.
 *
 * In production, CelsianJS handles routing. For this POC,
 * we use a minimal router to prove the deployment pipeline.
 */

// ─── Route Handlers (inline versions of src/api/ files) ───

function handleHello() {
  return Response.json({ message: 'Hello from ThenJS!', timestamp: Date.now() });
}

const users = [
  { id: '1', name: 'Alice', email: 'alice@example.com' },
  { id: '2', name: 'Bob', email: 'bob@example.com' },
];

function handleUsersGet() {
  return Response.json({ users });
}

async function handleUsersPost(request) {
  const body = await request.json();
  const user = { id: String(users.length + 1), name: body.name, email: body.email };
  users.push(user);
  return Response.json(user, { status: 201 });
}

function handleUserById(id) {
  return Response.json({ id, name: `User ${id}` });
}

function handleUserDelete(id) {
  return Response.json({ deleted: id });
}

function handleHealth() {
  return Response.json({ status: 'ok', runtime: 'cloudflare-workers', framework: 'thenjs' });
}

// ─── Minimal Router ───

function matchRoute(method, pathname) {
  // Static routes
  if (pathname === '/api/hello' && method === 'GET') return { handler: handleHello };
  if (pathname === '/api/users' && method === 'GET') return { handler: handleUsersGet };
  if (pathname === '/api/users' && method === 'POST') return { handler: handleUsersPost, needsBody: true };
  if (pathname === '/api/health' && method === 'GET') return { handler: handleHealth };
  if (pathname === '/__health' && method === 'GET') return { handler: handleHealth };

  // Dynamic: /api/users/:id
  const userMatch = pathname.match(/^\/api\/users\/([^/]+)$/);
  if (userMatch) {
    const id = userMatch[1];
    if (method === 'GET') return { handler: () => handleUserById(id) };
    if (method === 'DELETE') return { handler: () => handleUserDelete(id) };
  }

  return null;
}

// ─── Worker Entry ───

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method;

    // Root info
    if (url.pathname === '/' || url.pathname === '') {
      return Response.json({
        framework: 'ThenJS',
        runtime: 'Cloudflare Workers',
        routes: [
          'GET  /api/hello',
          'GET  /api/users',
          'POST /api/users',
          'GET  /api/users/:id',
          'DELETE /api/users/:id',
          'GET  /api/health',
        ],
      });
    }

    const match = matchRoute(method, url.pathname);
    if (!match) {
      return Response.json({ error: 'Not Found', path: url.pathname }, { status: 404 });
    }

    try {
      if (match.needsBody) {
        return await match.handler(request);
      }
      return match.handler();
    } catch (err) {
      return Response.json({ error: 'Internal Server Error', message: err.message }, { status: 500 });
    }
  },
};
