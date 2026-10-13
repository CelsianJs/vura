import { sharedValue } from '../shared.js';
export const route = { kind: 'serverless' };
export function GET() { return { value: sharedValue }; }
export function POST(req: { body: unknown }) { return req.body; }
