/**
 * RFC 0001 loaders, proven in a built and booted application.
 *
 * Why this suite exists, and why it is here rather than in packages/core:
 *
 * 0.6.0 shipped route-level loaders with 25 passing tests and the feature did
 * not work in a single real app. Every one of those tests imported the loader
 * runtime directly, so none of them saw what `vura build` does to it:
 *
 *   - a bare `@celsian/vura-core` import in a server page resolves to a
 *     hand-maintained shim that did not re-export `useLoaderData` at all, so
 *     the build failed outright;
 *   - the same import in a client or hybrid page pulled `node:fs` into a
 *     browser bundle, so that build failed too;
 *   - every page and layout is bundled separately and each bundle inlines its
 *     own copy of the loader runtime, so a module-scoped context object meant
 *     the provider and the consumer were reading different contexts, and
 *     `useLoaderData()` inside any layout reported "found no loader data";
 *   - the generated client entry booted the component with no provider at all,
 *     so a hybrid page rendered its data on the server and lost it on hydrate.
 *
 * None of that is visible from inside the package. It is visible the moment a
 * real project is built and served, which is what these tests do.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { scaffoldAndBuild, bootServer } from './helpers.js';

let app: Awaited<ReturnType<typeof scaffoldAndBuild>>;
let server: Awaited<ReturnType<typeof bootServer>>;

beforeAll(async () => {
  app = await scaffoldAndBuild();
  server = await bootServer({ NODE_ENV: 'production', PORT: '0' });
}, 300_000);

afterAll(async () => {
  await server?.kill();
});

const base = () => server.url;

function payloadOf(html: string): Record<string, any> {
  const match = html.match(
    /<script id="__VURA_LOADER__" type="application\/json">([\s\S]*?)<\/script>/,
  );
  if (!match) throw new Error('no __VURA_LOADER__ payload in this document');
  return JSON.parse(match[1]!);
}

describe('L1: a layered loader chain in a built server app', () => {
  it('renders every segment of the chain, layouts included', async () => {
    const html = await (await fetch(`${base()}/loaders/nested`)).text();

    // The outer layout, the inner layout and the page each read their OWN
    // loader data. This is the assertion that fails when the loader context is
    // module-scoped instead of process-scoped.
    expect(html).toContain('SITE:AUDIT-SITE');
    expect(html).toContain('AUDIT-DEPT');
    expect(html).toContain('<li>alpha</li>');
    expect(html).toContain('<li>beta</li>');
  });

  it('serializes every segment into the document for hydration', async () => {
    const payload = payloadOf(await (await fetch(`${base()}/loaders/nested`)).text());
    expect(Object.keys(payload).sort()).toEqual(['layout:0', 'layout:1', 'page']);
    expect(payload['layout:0'].site).toBe('AUDIT-SITE');
    expect(payload['layout:1'].dept).toBe('AUDIT-DEPT');
    expect(payload.page.items).toEqual(['alpha', 'beta']);
  });

  it('runs the chain in parallel, not in sequence', async () => {
    const payload = payloadOf(await (await fetch(`${base()}/loaders/nested`)).text());
    const starts = [
      payload['layout:0'].startedAt,
      payload['layout:1'].startedAt,
      payload.page.startedAt,
    ];
    // Each loader sleeps 120ms. Run in sequence the three start stamps would be
    // ~120ms apart; run in parallel they are the same tick. A 60ms window is
    // wide enough for a loaded CI box and less than half a sleep.
    expect(Math.max(...starts) - Math.min(...starts)).toBeLessThan(60);
  });
});

describe('L2: loader control flow', () => {
  it('turns `throw ctx.notFound()` into a 404, not a 500', async () => {
    const res = await fetch(`${base()}/loaders/gate?mode=missing`);
    expect(res.status).toBe(404);
  });

  it('turns `throw ctx.redirect()` into a real redirect with a Location', async () => {
    const res = await fetch(`${base()}/loaders/gate?mode=moved`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/loaders/nested');
  });

  it('passes the query through to the loader context', async () => {
    const html = await (await fetch(`${base()}/loaders/gate?mode=hello`)).text();
    expect(html).toContain('MODE:hello');
  });
});

describe('L3: build-time loaders', () => {
  it('renders a static page with its loader data already in the HTML', async () => {
    const html = await (await fetch(`${base()}/loaders/prebuilt`)).text();
    expect(html).toContain('BUILD-TIME-DATA');
    expect(payloadOf(html).page.builtAt).toBe('BUILD-TIME-DATA');
  });

  it('wraps a build-time page in its layout chain, like a server page', async () => {
    // A `_layout.tsx` in a directory of static or hybrid pages used to be
    // silently ignored: the same page rendered with its layout in `vura dev`
    // and without it in the build.
    const html = await (await fetch(`${base()}/loaders/prebuilt`)).text();
    expect(html).toContain('SITE:AUDIT-SITE');
    expect(payloadOf(html)['layout:0'].site).toBe('AUDIT-SITE');
  });
});

describe('L4: a hybrid page keeps its loader data across hydration', () => {
  it('server-renders the loader data and ships the payload with the bundle', async () => {
    const html = await (await fetch(`${base()}/loaders/island`)).text();
    expect(html).toContain('ISLAND-LOADED');
    // Inside its layout, and with the layout's own segment in the payload, so
    // the browser can rebuild the same tree.
    expect(html).toContain('SITE:AUDIT-SITE');
    expect(payloadOf(html)['layout:0'].site).toBe('AUDIT-SITE');
    expect(payloadOf(html).page.greeting).toBe('ISLAND-LOADED');
    expect(html).toMatch(/<script type="module" src="\/_then\/pages\/loaders\/island\.[a-f0-9]+\.js">/);
  });

  it('re-opens the loader scope in the browser bundle', async () => {
    const dir = join(app.dir, 'dist', 'static', '_then', 'pages', 'loaders');
    const bundleName = readdirSync(dir).find(f => f.startsWith('island.') && f.endsWith('.js'));
    expect(bundleName, 'island client bundle should exist').toBeTruthy();
    const bundle = readFileSync(join(dir, bundleName!), 'utf8');

    // The generated entry reads the serialized payload and hydrates inside the
    // provider. Without this the component throws on hydrate and the user sees
    // the boot-error panel instead of their page.
    expect(bundle).toContain('__VURA_LOADER__');
    // And it rebuilds the layout chain, because that is the tree the server
    // rendered: hydrating only the page component would walk a DOM it does not
    // expect. The layout's own markup is in the bundle, and the entry reads its
    // segment out of the payload by key. (The string 'AUDIT-SITE' is not: that
    // value comes from the layout's loader, which runs on the server.)
    expect(bundle).toContain('SITE:');
    expect(bundle).toContain('layout:');
  });

  it('does not drag Node built-ins into the browser bundle', async () => {
    const dir = join(app.dir, 'dist', 'static', '_then', 'pages', 'loaders');
    const bundleName = readdirSync(dir).find(f => f.startsWith('island.') && f.endsWith('.js'));
    const bundle = readFileSync(join(dir, bundleName!), 'utf8');

    // `@celsian/vura-core` reaches node:fs, node:crypto and node:http. A page
    // importing it for useLoaderData must still bundle for a browser.
    expect(bundle).not.toMatch(/from ?["']node:/);
    expect(bundle).not.toMatch(/require\(["']node:/);
  });
});

describe('L5: the emitted container manifest', () => {
  it('pins what-framework to the version this project actually installed', async () => {
    const distPkgPath = join(app.dir, 'dist', 'package.json');
    expect(existsSync(distPkgPath), 'dist/package.json should exist').toBe(true);
    const distPkg = JSON.parse(readFileSync(distPkgPath, 'utf8'));

    const installed = JSON.parse(
      readFileSync(join(app.dir, 'node_modules', 'what-framework', 'package.json'), 'utf8'),
    ).version;

    // A container that npm-installs dist/package.json has to get the framework
    // the app was built against. Resolving this by requiring
    // 'what-framework/package.json' silently returned null in every real
    // install, because the exports map does not list that subpath — so the
    // dependency was simply missing and the container died on first render.
    expect(distPkg.dependencies?.['what-framework']).toBe(installed);
  });
});
