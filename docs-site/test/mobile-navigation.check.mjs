import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));

function documents(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? documents(path) : entry.name === 'index.html' ? [path] : [];
  });
}

test('every documentation page exposes the complete navigation without JavaScript', () => {
  const pages = documents(dist).filter((path) => readFileSync(path, 'utf8').includes('class="sidebar"'));
  assert.ok(pages.length >= 30, 'build the complete documentation before checking navigation');
  for (const path of pages) {
    const html = readFileSync(path, 'utf8');
    const mobile = html.match(/<details\b[^>]*class="mobile-docs-nav"[^>]*>([\s\S]*?)<\/details>/);
    assert.ok(mobile, `${path}: mobile documentation navigation is missing`);
    assert.match(mobile[1], /<summary>Documentation<\/summary>/);
    assert.match(mobile[1], /<nav aria-label="Documentation">/);
    const desktop = html.match(/<aside\b[^>]*class="sidebar"[^>]*>([\s\S]*?)<\/aside>/);
    const links = (fragment) => [...fragment.matchAll(/<a\b[^>]*href="([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(links(mobile[1]), links(desktop[1]), `${path}: mobile and desktop destinations differ`);
    // Legal pages use the docs layout but are not sidebar destinations.
    if (desktop[1].includes('class="active"')) {
      assert.equal([...mobile[1].matchAll(/aria-current="page"/g)].length, 1, `${path}: only the exact destination is the current page`);
    }
    assert.doesNotMatch(mobile[0], /\bon(?:click|keydown)=/i, 'native disclosure must work without script handlers');
  }
});

test('documentation tables have a focusable scroll region without losing table semantics', () => {
  let tables = 0;
  for (const path of documents(dist)) {
    const html = readFileSync(path, 'utf8');
    const count = [...html.matchAll(/<table\b/g)].length;
    if (!count) continue;
    tables += count;
    const regions = [...html.matchAll(/<div class="table-scroll" role="region" aria-label="Scrollable table" tabindex="0"><table\b/g)].length;
    assert.equal(regions, count, `${path}: each table must scroll within its container`);
  }
  assert.ok(tables > 0, 'exercise actual documentation tables');
});
