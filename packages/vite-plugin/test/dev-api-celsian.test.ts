/**
 * Task 6 — dev API middleware served by CelsianApp.handle
 *
 * Tests that the vite-plugin's API middleware (after the A1.3 rebase) uses
 * createApiApp under the hood. We spin a minimal connect-style middleware
 * test by invoking the createApiApp + nodeToWebRequest/writeWebResponse
 * pipeline directly — the same path the vite-plugin now takes — rather than
 * instantiating a full ViteDevServer, which would require a project on disk.
 *
 * This verifies:
 *   (a) JSON round-trip through the celsian path (POST /api/echo echoes body)
 *   (b) A global onRequest hook from a _hooks.ts-style object fires before
 *       the handler and can mutate a shared side-effect array.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { describe, it, expect, afterAll } from 'vitest';
import {
  createApiApp,
  nodeToWebRequest,
  writeWebResponse,
  type RuntimeApiRoute,
  type GlobalHooks,
} from '../../core/src/index.js';

// ─── Fixture: one /api/echo route ───────────────────────────────────────────

function makeEchoRoute(): RuntimeApiRoute {
  return {
    urlPattern: '/api/echo',
    methods: ['POST'],
    kind: 'serverless' as const,
    filePath: 'src/api/echo.ts',
    config: {},
    module: {
      POST: async (req: any, reply: any) => {
        return reply.json({ echoed: req.parsedBody });
      },
    },
  };
}

// ─── Minimal connect-style test server ──────────────────────────────────────

function makeTestServer(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>) {
  const server = createServer(async (req, res) => {
    try {
      await handler(req, res);
    } catch (err: any) {
      if (!res.writableEnded) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
  });
  return new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        port: addr.port,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('dev API middleware — CelsianApp.handle path', () => {
  it('(a) POST /api/echo round-trips JSON body via createApiApp.handle', async () => {
    const app = createApiApp({ routes: [makeEchoRoute()] });

    const { port, close } = await makeTestServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      if (!url.pathname.startsWith('/api/')) {
        res.writeHead(404);
        res.end();
        return;
      }
      const webReq = nodeToWebRequest(req, url);
      const webRes = await app.handle(webReq);
      // 404 from celsian means no route matched — pass through in real middleware.
      // In this fixture the route always matches.
      await writeWebResponse(res, webRes);
    });

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/echo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hello: 'world' }),
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ echoed: { hello: 'world' } });
    } finally {
      await close();
    }
  });

  it('(b) global onRequest hook from _hooks.ts-style object fires before handler', async () => {
    const fired: string[] = [];

    const globalHooks: GlobalHooks = {
      onRequest: [
        (_req: any, _reply: any) => {
          fired.push('onRequest');
        },
      ],
    };

    const app = createApiApp({ routes: [makeEchoRoute()], globalHooks });

    const { port, close } = await makeTestServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      if (!url.pathname.startsWith('/api/')) {
        res.writeHead(404);
        res.end();
        return;
      }
      const webReq = nodeToWebRequest(req, url);
      const webRes = await app.handle(webReq);
      await writeWebResponse(res, webRes);
    });

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/echo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ping: true }),
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ echoed: { ping: true } });
      // Hook must have fired once before the handler returned
      expect(fired).toEqual(['onRequest']);
    } finally {
      await close();
    }
  });

  it('(c) unmatched /api/* routes return 404 from app.handle (next() semantics)', async () => {
    const app = createApiApp({ routes: [makeEchoRoute()] });

    const { port, close } = await makeTestServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const webReq = nodeToWebRequest(req, url);
      const webRes = await app.handle(webReq);
      // Mirror the real middleware: 404 from celsian = no route match = next()
      if (webRes.status === 404) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ passedThrough: true }));
        return;
      }
      await writeWebResponse(res, webRes);
    });

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/unknown`, {
        method: 'GET',
      });
      const json = await res.json();
      expect(json).toEqual({ passedThrough: true });
    } finally {
      await close();
    }
  });
});
