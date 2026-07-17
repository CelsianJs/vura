import type { ThenRequest } from '@celsian/vura-core';
import { handleProbe } from '../lib/probe-contract.js';

export const route = { kind: 'hot' as const };

export function GET(req: ThenRequest): Response {
  return handleProbe(req, 'hot');
}
