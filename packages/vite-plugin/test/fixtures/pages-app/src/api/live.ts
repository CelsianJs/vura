/**
 * `/api/live` — hot API route (always-on; would hold module-level state in prod).
 */
export const route = { kind: 'hot' as const };

let hits = 0;

export function GET() {
  hits += 1;
  return { hits };
}
