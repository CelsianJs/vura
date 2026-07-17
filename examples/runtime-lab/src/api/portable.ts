import type { ThenRequest } from '@celsian/vura-core';
import { handleProbe } from '../lib/probe-contract.js';

// This route deliberately begins as a Function. The dogfood suite promotes it
// to Hot and demotes it again without changing its URL or handler contract.
export const route = { kind: 'serverless' as const };

export function GET(req: ThenRequest): Response {
  return handleProbe(req, 'portable');
}
