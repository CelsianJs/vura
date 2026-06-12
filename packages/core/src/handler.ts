/**
 * Handler Types — deprecated aliases for CelsianRequest/CelsianReply.
 *
 * @deprecated Import from @celsian/core or @vura/core directly.
 * ThenRequest/ThenReply/ThenHandler will be removed in vura v0.6.
 * The runtime functions (finalizeNodeHandlerResult) remain here until
 * the Node dev/hot-server paths are migrated in Tasks 5-7.
 */

// Re-export deprecated type aliases from compat (canonical home post-A1.3)
export type { ThenRequest, ThenReply, ThenHandler } from './compat.js';

import type { ServerResponse } from 'node:http';

export interface NodeHandlerFinalizationState {
  statusCode: number;
  headers: Record<string, string>;
}

export interface NodeHandlerFinalizationResult {
  finalized: boolean;
}

/**
 * Finalize handler return values for Node response targets.
 *
 * This is the canonical Node-side normalization shared by dev/hot server paths:
 * - returned Web Response passes through status, headers, and body
 * - returned plain objects/arrays are JSON encoded
 * - undefined/null after no explicit reply becomes 204 No Content
 * - explicit reply helpers win because the response is already ended
 */
export async function finalizeNodeHandlerResult(
  result: unknown,
  res: Pick<ServerResponse, 'writableEnded' | 'writeHead' | 'end'>,
  state: NodeHandlerFinalizationState,
): Promise<NodeHandlerFinalizationResult> {
  if (res.writableEnded) return { finalized: true };

  if (isWebResponse(result)) {
    const headers: Record<string, string> = {};
    result.headers.forEach((value, key) => { headers[key] = value; });
    res.writeHead(result.status, headers);
    res.end(await result.text());
    return { finalized: true };
  }

  if (result !== null && typeof result === 'object') {
    res.writeHead(state.statusCode, state.headers);
    res.end(JSON.stringify(result));
    return { finalized: true };
  }

  res.writeHead(204);
  res.end();
  return { finalized: true };
}

function isWebResponse(value: unknown): value is Response {
  return typeof Response !== 'undefined' && value instanceof Response;
}
