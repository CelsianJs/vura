/**
 * `/api/ping` — serverless API route.
 */
export const route = { kind: 'serverless' as const };

export function GET() {
  return { pong: true };
}
