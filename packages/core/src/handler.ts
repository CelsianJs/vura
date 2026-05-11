/**
 * Handler Types — CelsianJS-compatible req/reply interface.
 *
 * These types define the API surface that handler authors use.
 * The same types work whether running in dev, serverless (Workers/Lambda),
 * or hot server mode.
 */

import type { IncomingHttpHeaders, ServerResponse } from 'node:http';

// ─── Request ───

export interface ThenRequest {
  /** HTTP method (uppercase) */
  method: string;
  /** URL pathname */
  url: string;
  /** Request headers */
  headers: Record<string, string | string[] | undefined> | IncomingHttpHeaders;
  /** Extracted route params (e.g. { id: "42" } from /api/users/:id) */
  params: Record<string, string>;
  /** Parsed query string params */
  query: Record<string, string>;
  /** Parsed request body (JSON or form data) */
  parsedBody: unknown;
  /** Alias for parsedBody, kept for CelsianJS-style handler ergonomics */
  body?: unknown;
  /** Validated data — populated when a route schema is defined and validation passes */
  validated?: {
    body: unknown;
    query: unknown;
    params: unknown;
  };
}

// ─── Reply ───

export interface ThenReply {
  /** Set response status code */
  status(code: number): ThenReply;
  /** Set a response header */
  header(name: string, value: string): ThenReply;
  /** Send JSON response */
  json(data: unknown): unknown;
  /** Send text/HTML response */
  send(data: string): unknown;
  /** Redirect to a URL. Defaults to 302 (temporary redirect). */
  redirect(url: string, status?: number): unknown;
}

// ─── Handler Function ───

export type ThenHandler = (req: ThenRequest, reply: ThenReply) => unknown | Promise<unknown>;

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
