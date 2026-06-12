/**
 * Vura compat — ThenRequest/ThenReply aliases for CelsianRequest/CelsianReply.
 *
 * The compat shim bridges the old Vura handler contract (ThenRequest) to the
 * Celsian request object. The three deltas:
 *   1. req.body  → always aliases parsedBody (undefined when no parsed body,
 *      e.g. GET requests). The raw stream remains available via req.bodyUsed /
 *      req.clone() — handlers needing the raw stream should use celsian's native
 *      API directly.
 *   2. req.headers → CelsianRequest extends Web Request so headers is a Headers
 *      object; index access (req.headers['content-type']) still works via .get()
 *      but plain object access is not needed since Headers supports forEach/get.
 *   3. req.url   → full URL string (unchanged: CelsianRequest extends Request,
 *      req.url is already the full URL).
 *
 * @deprecated ThenRequest/ThenReply — use CelsianRequest/CelsianReply from
 * @celsian/core. Will be removed in vura v0.5.
 */

import type { CelsianRequest, CelsianReply } from '@celsian/core';

/** @deprecated Use CelsianRequest from @celsian/core. Removed in vura v0.5. */
export type ThenRequest = CelsianRequest & {
  body?: unknown;
  /** Validated + coerced query (set by celsian when a `schema.query` is declared). */
  parsedQuery?: unknown;
  validated?: { body: unknown; query: unknown; params: unknown };
};

/** @deprecated Use CelsianReply from @celsian/core. */
export type ThenReply = CelsianReply;

/** @deprecated */
export type ThenHandler = (req: ThenRequest, reply: ThenReply) => unknown | Promise<unknown>;

/**
 * Patch the ThenRequest body delta onto a CelsianRequest (in place, per request).
 *
 * CelsianRequest extends Web Request, so `body` is a getter on the Request
 * prototype returning the raw ReadableStream (or null on GET). We shadow it
 * unconditionally with an instance property getter that returns parsedBody —
 * defineProperty on the instance always wins over prototype getters in JS
 * property lookup.
 *
 * req.body always aliases parsedBody (undefined when no parsed body, e.g. GET);
 * the raw stream remains available via req.bodyUsed/req.clone() — handlers
 * needing the raw stream should use celsian's native API.
 */
export function applyThenCompat(req: CelsianRequest): ThenRequest {
  const r = req as ThenRequest;
  // Unconditional install — covers GET (body=null), POST with body, and any
  // re-patched request. configurable:true keeps the shim idempotent on retries.
  Object.defineProperty(r, 'body', {
    get: () => (r as CelsianRequest).parsedBody,
    configurable: true,
    enumerable: false,
  });
  return r;
}
