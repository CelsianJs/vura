/**
 * Simple serverless endpoint.
 * Deployed as an individual Lambda/Worker function.
 */
export const route = { kind: 'serverless' };

export function GET(req: any, reply: any) {
  return reply.json({ message: 'Hello from ThenJS!', timestamp: Date.now() });
}
