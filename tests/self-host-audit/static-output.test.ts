/**
 * "Static pages ship zero framework JavaScript" (CLAIMS.md rows 4 and 22),
 * asserted against a real build instead of re-checked by hand.
 *
 * Both rows sat at `planned (CI assertion not yet wired)` since June, with a
 * manual re-verification noted against 0.4.0. This is the assertion they were
 * waiting for, run on every commit as part of the self-host audit.
 *
 * The claim is about JavaScript, not about script tags. A static page with a
 * loader emits `<script id="__VURA_LOADER__" type="application/json">`, which
 * the browser parses as data and never executes, so the assertion allows that
 * one type and nothing else.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { scaffoldAndBuild } from './helpers.js';

let app: Awaited<ReturnType<typeof scaffoldAndBuild>>;

beforeAll(async () => {
  app = await scaffoldAndBuild();
}, 300_000);

/** Every `<script …>` open tag in a document, with its attributes. */
function scriptTags(html: string): string[] {
  return html.match(/<script\b[^>]*>/g) ?? [];
}

function staticPage(...segments: string[]): string {
  const path = join(app.dir, 'dist', 'static', ...segments);
  expect(existsSync(path), `${segments.join('/')} should exist`).toBe(true);
  return readFileSync(path, 'utf8');
}

describe('S1: static pages ship zero framework JavaScript', () => {
  it('a static page references no browser bundle', () => {
    // `_then/` is where every client and hybrid bundle is emitted, so one
    // reference to it is one bundle the visitor has to download.
    expect(staticPage('index.html')).not.toContain('_then/');
    expect(staticPage('loaders', 'prebuilt', 'index.html')).not.toContain('_then/');
  });

  it('a static page carries no executable script tag', () => {
    for (const html of [staticPage('index.html'), staticPage('loaders', 'prebuilt', 'index.html')]) {
      for (const tag of scriptTags(html)) {
        expect(tag, `unexpected script tag: ${tag}`).toContain('type="application/json"');
      }
    }
  });

  it('a static page still renders its content, so "zero JS" is not "zero page"', () => {
    // A blank document would pass both assertions above.
    expect(staticPage('index.html')).toContain('<div id="app">');
    expect(staticPage('loaders', 'prebuilt', 'index.html')).toContain('BUILD-TIME-DATA');
  });

  it('client and hybrid pages DO ship a bundle, so the assertion above has teeth', () => {
    // If `_then/` stopped being emitted altogether the static assertions would
    // pass for the wrong reason.
    expect(staticPage('widget', 'index.html')).toContain('_then/');
    expect(staticPage('mixed', 'index.html')).toContain('_then/');
  });
});

describe('S2: the build ships only the bundles it emitted', () => {
  it('every file under _then/pages is referenced by a page', () => {
    // Bundle names carry a content hash, so editing a page emits a new name
    // and orphans the old one. Nothing removed those, so `dist/` grew with
    // every incremental build and the dead copies shipped to whatever the
    // project deployed to.
    const root = join(app.dir, 'dist', 'static', '_then', 'pages');
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)],
      );
    const bundles = walk(root).map((f) => f.slice(root.length + 1).replace(/\\/g, '/'));
    expect(bundles.length).toBeGreaterThan(0);

    // Collect every /_then/pages/... reference across the built HTML.
    const htmlRoot = join(app.dir, 'dist', 'static');
    const walkHtml = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? (e.name === '_then' ? [] : walkHtml(join(d, e.name)))
          : e.name.endsWith('.html')
            ? [join(d, e.name)]
            : [],
      );
    const referenced = new Set<string>();
    for (const f of walkHtml(htmlRoot)) {
      for (const m of readFileSync(f, 'utf8').matchAll(/\/_then\/pages\/([^"']+)/g)) {
        referenced.add(m[1]);
      }
    }

    const orphans = bundles.filter((b) => !referenced.has(b));
    expect(orphans, `orphaned bundles left in dist: ${orphans.join(', ')}`).toEqual([]);
  });
});
