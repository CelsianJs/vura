/**
 * Handler Types — CelsianJS-compatible req/reply interface.
 *
 * These types define the API surface that handler authors use.
 * The same types work whether running in dev, serverless (Workers/Lambda),
 * or hot server mode.
 */

import type { IncomingHttpHeaders } from 'node:http';

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
