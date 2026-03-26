/**
 * POST /api/echo — Serverless route
 * Echoes back the parsed request body. Tests body parsing.
 */

export const route = { kind: 'serverless' as const };

export function POST(req: any, reply: any) {
  return reply.json({
    echo: req.parsedBody,
    method: req.method,
    contentType: req.headers['content-type'] || 'none',
    timestamp: Date.now(),
  });
}
