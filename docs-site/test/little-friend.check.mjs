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

test('every page loads Little Friend once, in the head, on the production host only', () => {
  const pages = documents(dist);
  assert.ok(pages.length >= 30, 'build the complete site before checking analytics');
  for (const path of pages) {
    const html = readFileSync(path, 'utf8');
    const head = html.slice(0, html.indexOf('</head>'));
    assert.equal(html.split('lf_jg7NE1oVlHETc0OHstDeWYRb').length - 1, 1, path);
    assert.match(head, /if \(host !== 'vura\.io' && host !== 'www\.vura\.io'\) return;/, path);
    assert.match(head, /https:\/\/cdn\.littlefriend\.io\//, path);
  }
});

test('the privacy policy describes Little Friend and session replay', () => {
  const html = readFileSync(join(dist, 'privacy/index.html'), 'utf8');
  assert.match(html, /We use Little Friend for privacy-friendly analytics/);
  assert.match(html, /recordings are deleted within 7 days/);
  assert.doesNotMatch(html, /carries no third-party trackers/);
});
