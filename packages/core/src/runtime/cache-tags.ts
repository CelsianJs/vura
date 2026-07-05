/**
 * Vura cache-tag header builder — turns a page's declared `tags` into the
 * `x-vura-cache-tag` response header value (mirrored onto `Cache-Tag`).
 *
 * Vura Platform's edge router reads `x-vura-cache-tag`, splits it on commas,
 * trims each entry, and namespaces it as `project:{id}:{tag}` before stamping
 * Cloudflare's `Cache-Tag` and recording per-tag cache analytics (see
 * vura-platform `apps/edge-router/src/cache-tags.ts`). So the contract is a
 * comma-separated, trimmed list; the bare `Cache-Tag` is only for a self-hosted
 * CF/Fastly zone (the edge overwrites it on the platform).
 *
 * The value is stamped straight onto an HTTP response, so this builder is the
 * choke point that keeps it well-formed and bounded: control characters
 * (< 0x20 + DEL) are stripped so a tag can never inject a header break; commas
 * inside a tag are treated as separators (never smuggled through); each tag is
 * truncated to {@link MAX_VURA_CACHE_TAG_LENGTH}; at most
 * {@link MAX_VURA_CACHE_TAGS} tags are emitted; duplicates are dropped
 * order-preserving. Caps stay well under Cloudflare's ~1000-tag / 16 KB limit,
 * leaving head-room for the edge's `project:{id}:` prefix.
 */

/** Maximum number of tags emitted on a single response. */
export const MAX_VURA_CACHE_TAGS = 64;

/** Maximum length (characters) of a single emitted tag. */
export const MAX_VURA_CACHE_TAG_LENGTH = 128;

// Control chars (< 0x20, includes CR/LF/TAB) and DEL (0x7f) are stripped to keep
// the header value a single well-formed HTTP field with no injection surface.
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f]", "g");

/**
 * Normalise a page's declared cache tags into the `x-vura-cache-tag` header
 * value: a comma-separated, sanitised, capped, deduped list.
 *
 * Accepts the shapes a page config can carry (`string[]`, a comma-separated
 * `string`, or nothing) and is defensive about anything else.
 *
 * @returns the header value, or `null` when there is nothing valid to emit
 *          (caller should omit the header entirely).
 */
export function buildVuraCacheTagHeader(tags: unknown): string | null {
  const raw = Array.isArray(tags)
    ? tags
    : typeof tags === 'string'
      ? [tags]
      : [];

  const seen = new Set<string>();
  const out: string[] = [];

  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    // Split on comma so a comma inside a tag becomes separate tags rather than
    // silently corrupting the header the edge later splits.
    for (const part of entry.split(',')) {
      const cleaned = part.replace(CONTROL_CHARS, '').trim().slice(0, MAX_VURA_CACHE_TAG_LENGTH);
      if (!cleaned || seen.has(cleaned)) continue;
      seen.add(cleaned);
      out.push(cleaned);
      if (out.length >= MAX_VURA_CACHE_TAGS) return out.join(',');
    }
  }

  return out.length > 0 ? out.join(',') : null;
}
