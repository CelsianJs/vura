/**
 * WebSocket upgrade helpers — Origin allowlist for hot routes.
 *
 * Kept as a separate module (rather than inline in server.ts) deliberately:
 * the dev-server ws work will extract the full upgrade handler here, and the
 * helper must stay pure/unit-testable either way.
 */

/**
 * Decide whether a WebSocket upgrade request's `Origin` header is acceptable
 * for a hot route, based on the route's opt-in `origins` config:
 *
 * ```ts
 * export const route = { kind: 'hot', origins: ['https://app.example.com'] };
 * ```
 *
 * Semantics:
 *
 * - `allowlist === undefined` → **allow** (backward compatible: routes that
 *   never set `origins` keep today's accept-all behavior).
 * - `origin === undefined` with an allowlist set → **allow**. Rationale:
 *   browsers ALWAYS send an `Origin` header on WebSocket handshakes, and
 *   Cross-Site WebSocket Hijacking (CSWSH) — the attack this guard exists
 *   for — is strictly a browser attack riding on ambient cookies. A request
 *   with no `Origin` header is by definition a non-browser client, and a
 *   non-browser client can forge any `Origin` value anyway, so rejecting it
 *   adds no security — it only breaks curl/wscat/server-to-server clients.
 * - Otherwise both sides are normalized via `new URL(x).origin` when
 *   parseable and compared case-insensitively, so allowlist entries may
 *   carry trailing slashes, paths, or default ports
 *   (`'https://app.example.com/'` matches `Origin: https://app.example.com`).
 * - A malformed `Origin` header (unparseable, empty, or the literal opaque
 *   serialization `'null'` sent by sandboxed iframes / `file://` pages)
 *   with an allowlist set → **deny**.
 * - An empty allowlist `[]` → **deny all browser origins** (the user
 *   explicitly set it, so the explicit set wins; no-Origin clients still
 *   pass per the rule above).
 *
 * @param origin    Raw `Origin` header from the upgrade request, if any.
 * @param allowlist The route's `config.origins` value, if any.
 * @returns `true` when the upgrade should proceed, `false` to reject (403).
 */
export function isOriginAllowed(
  origin: string | undefined,
  allowlist: string[] | undefined,
): boolean {
  if (allowlist === undefined) return true; // opt-in feature: unset = open
  if (origin === undefined) return true; // non-browser client — see JSDoc

  const normalizedOrigin = normalizeOrigin(origin);
  if (normalizedOrigin === undefined) return false; // malformed header

  for (const entry of allowlist) {
    // Allowlist entries that don't parse as URLs fall back to a raw
    // lowercase comparison (the author may have written a bare origin form
    // the URL parser rejects); the header side is already validated above.
    const normalizedEntry = normalizeOrigin(entry) ?? entry.toLowerCase();
    if (normalizedEntry === normalizedOrigin) return true;
  }
  return false;
}

/**
 * Normalize a value to its lowercase URL origin, or `undefined` when it
 * cannot be treated as a concrete origin.
 *
 * Non-special schemes (e.g. `chrome-extension://…`) serialize their origin
 * as the literal string `'null'`; we fall back to the raw lowercase value in
 * that case so two unrelated opaque origins never compare equal via
 * `'null' === 'null'`.
 */
function normalizeOrigin(value: string): string | undefined {
  try {
    const o = new URL(value).origin;
    if (o === 'null') return value.toLowerCase();
    return o.toLowerCase();
  } catch {
    return undefined;
  }
}
