import { describe, it, expect } from 'vitest';
import {
  buildVuraCacheTagHeader,
  MAX_VURA_CACHE_TAGS,
  MAX_VURA_CACHE_TAG_LENGTH,
} from '../src/runtime/cache-tags.js';

/**
 * buildVuraCacheTagHeader is the choke point that turns a page's declared
 * `tags` into the `x-vura-cache-tag` header value. The contract it must uphold
 * (verified against vura-platform apps/edge-router/src/cache-tags.ts which
 * splits the value on commas and trims each entry):
 *   comma-separated · trimmed · empties dropped · deduped · length- & count-capped
 *   · never carries a control character (HTTP header-injection safe).
 */
describe('buildVuraCacheTagHeader', () => {
  it('returns null for nothing to emit', () => {
    expect(buildVuraCacheTagHeader(undefined)).toBeNull();
    expect(buildVuraCacheTagHeader(null)).toBeNull();
    expect(buildVuraCacheTagHeader([])).toBeNull();
    expect(buildVuraCacheTagHeader('')).toBeNull();
    expect(buildVuraCacheTagHeader('   ')).toBeNull();
    expect(buildVuraCacheTagHeader([' ', ''])).toBeNull();
    expect(buildVuraCacheTagHeader(42)).toBeNull();
  });

  it('joins an array of tags with commas', () => {
    expect(buildVuraCacheTagHeader(['posts', 'nav'])).toBe('posts,nav');
  });

  it('accepts a comma-separated string and re-splits it', () => {
    expect(buildVuraCacheTagHeader('posts, nav')).toBe('posts,nav');
  });

  it('trims whitespace and drops empty entries', () => {
    expect(buildVuraCacheTagHeader(['  posts  ', '', '  ', 'nav'])).toBe('posts,nav');
  });

  it('treats a comma inside a single tag as a separator (no smuggling)', () => {
    // An array entry that itself contains a comma must not corrupt the header —
    // it becomes two tags, exactly how the edge later splits it.
    expect(buildVuraCacheTagHeader(['posts,nav'])).toBe('posts,nav');
  });

  it('dedupes order-preserving, first occurrence wins', () => {
    expect(buildVuraCacheTagHeader(['posts', 'nav', 'posts', 'nav'])).toBe('posts,nav');
    expect(buildVuraCacheTagHeader('a,b,a,c,b')).toBe('a,b,c');
  });

  it('strips control characters so a tag cannot inject a header break', () => {
    expect(buildVuraCacheTagHeader(['pos\r\nts', 'na\tv', 'ok\u0000'])).toBe('posts,nav,ok');
    // A tag that is nothing but control chars collapses to empty and is dropped.
    expect(buildVuraCacheTagHeader(['\r\n\t'])).toBeNull();
  });

  it('truncates each tag to MAX_VURA_CACHE_TAG_LENGTH', () => {
    const long = 'x'.repeat(MAX_VURA_CACHE_TAG_LENGTH + 50);
    const out = buildVuraCacheTagHeader([long]);
    expect(out).toBe('x'.repeat(MAX_VURA_CACHE_TAG_LENGTH));
    expect(out).not.toBeNull();
    expect(out!.length).toBe(MAX_VURA_CACHE_TAG_LENGTH);
  });

  it('caps the number of tags at MAX_VURA_CACHE_TAGS', () => {
    const many = Array.from({ length: MAX_VURA_CACHE_TAGS + 25 }, (_, i) => `t${i}`);
    const out = buildVuraCacheTagHeader(many);
    const emitted = out!.split(',');
    expect(emitted.length).toBe(MAX_VURA_CACHE_TAGS);
    // Deterministic: keeps the first N in declared order.
    expect(emitted[0]).toBe('t0');
    expect(emitted[MAX_VURA_CACHE_TAGS - 1]).toBe(`t${MAX_VURA_CACHE_TAGS - 1}`);
  });

  it('counts unique tags toward the cap, not raw entries', () => {
    // MAX+10 entries but all duplicates collapse to one.
    const dupes = Array.from({ length: MAX_VURA_CACHE_TAGS + 10 }, () => 'same');
    expect(buildVuraCacheTagHeader(dupes)).toBe('same');
  });
});
