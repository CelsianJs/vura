/**
 * ThenJS Hot Server — Standalone Node.js server for hot route deployment.
 *
 * This is the persistent server entry point that loads CelsianJS-compatible
 * route handlers and serves them via Node's built-in HTTP server.
 *
 * Used for Fly.io / Railway / any long-running container deployment.
 */

import { createServer } from 'node:http';

// Route handlers are imported at build time via esbuild bundling
import * as health from './src/api/health.ts';
import * as echo from './src/api/echo.ts';
import * as counter from './src/api/counter.ts';

// ─── Route Table ───

const ROUTES = [
  { pattern: '/api/health', method: 'GET', handler: health.GET },
  { pattern: '/api/echo', method: 'POST', handler: echo.POST },
  { pattern: '/api/counter', method: 'GET', handler: counter.GET },
  { pattern: '/api/counter', method: 'POST', handler: counter.POST },
];

// ─── CelsianJS-compatible req/reply shim ───
// Same pattern used by @celsian/then-cli deploy for Cloudflare Workers and Lambda

function createReq(method, url, headers, params, query, parsedBody) {
  return {
    method,
    url: url.pathname,
    headers,
    params,
    query,
    parsedBody,
  };
}

function createReply() {
  let statusCode = 200;
  const headers = { 'content-type': 'application/json' };

  const reply = {
    status(code) { statusCode = code; return reply; },
    header(name, value) { headers[name] = value; return reply; },
    json(data) {
      return { _type: 'response', statusCode, headers, body: JSON.stringify(data) };
    },
    send(body) {
      if (typeof body === 'string' && !headers['content-type']) {
        headers['content-type'] = 'text/plain';
      }
      return { _type: 'response', statusCode, headers, body };
    },
  };
  return reply;
}

async function parseBody(req) {
  return new Promise((resolve) => {
    const method = req.method?.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'DELETE') {
      return resolve(null);
    }

    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (!body) return resolve(null);
      const ct = req.headers['content-type'] || '';
      if (ct.includes('application/json')) {
        try { return resolve(JSON.parse(body)); } catch { return resolve(null); }
      }
      if (ct.includes('application/x-www-form-urlencoded')) {
        return resolve(Object.fromEntries(new URLSearchParams(body)));
      }
      return resolve(body);
    });
    req.on('error', () => resolve(null));
  });
}

// ─── HTTP Server ───

const PORT = parseInt(process.env.PORT || '3000', 10);

const server = createServer(async (nodeReq, nodeRes) => {
  const url = new URL(nodeReq.url, `http://localhost:${PORT}`);
  const method = nodeReq.method?.toUpperCase();

  // Root — list routes
  if (url.pathname === '/') {
    nodeRes.writeHead(200, { 'content-type': 'application/json' });
    nodeRes.end(JSON.stringify({
      framework: 'ThenJS',
      mode: 'hot-server',
      routes: ROUTES.map(r => `${r.method} ${r.pattern}`),
    }));
    return;
  }

  // Health check
  if (url.pathname === '/__health') {
    nodeRes.writeHead(200, { 'content-type': 'application/json' });
    nodeRes.end(JSON.stringify({ ok: true, framework: 'ThenJS', mode: 'hot-server' }));
    return;
  }

  // Match route
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    if (route.pattern !== url.pathname) continue;

    const parsedBody = await parseBody(nodeReq);
    const headers = {};
    for (const [key, val] of Object.entries(nodeReq.headers)) {
      if (typeof val === 'string') headers[key] = val;
    }
    const query = Object.fromEntries(url.searchParams.entries());
    const req = createReq(method, url, headers, {}, query, parsedBody);

    const reply = createReply();

    try {
      const response = await route.handler(req, reply);
      if (response && response._type === 'response') {
        nodeRes.writeHead(response.statusCode, response.headers);
        nodeRes.end(response.body);
        return;
      }
      if (response && typeof response === 'object') {
        nodeRes.writeHead(200, { 'content-type': 'application/json' });
        nodeRes.end(JSON.stringify(response));
        return;
      }
      nodeRes.writeHead(500, { 'content-type': 'application/json' });
      nodeRes.end(JSON.stringify({ error: 'Handler returned no response' }));
      return;
    } catch (err) {
      nodeRes.writeHead(500, { 'content-type': 'application/json' });
      nodeRes.end(JSON.stringify({ error: 'Internal Server Error', message: err.message }));
      return;
    }
  }

  // 404
  nodeRes.writeHead(404, { 'content-type': 'application/json' });
  nodeRes.end(JSON.stringify({ error: 'Not Found', path: url.pathname }));
});

server.listen(PORT, () => {
  console.log(`ThenJS hot server listening on :${PORT}`);
  console.log(`  Routes:`);
  for (const route of ROUTES) {
    console.log(`    ${route.method.padEnd(6)} ${route.pattern}`);
  }
});
