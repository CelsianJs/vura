#!/usr/bin/env node
/**
 * assert-served-pages.mjs <base-url>
 *
 * Assert that a running Vura deployment serves its PAGES, not just its API.
 *
 * Every self-host CI leg used to curl `/api/hello` and stop. That is exactly
 * why two of the four targets could build successfully, print a full page
 * table, and serve 404 (Cloudflare) or 403 (Lambda) for every page, for as
 * long as they did: nothing in CI ever asked for a page. One script, run by
 * every leg, is the point — four copies of these checks is four chances to fix
 * one target's coverage and not another's.
 *
 * What is asserted, and why each one is here:
 *
 *   /                  a prerendered page. On Cloudflare this is answered by
 *                      Workers Static Assets before the Worker runs; on Lambda
 *                      it comes off the pages function's own asset copy.
 *   /dashboard + its   a client-mode page ships a shell AND a browser bundle.
 *   browser bundle     Serving the shell without the bundle is a page that
 *                      never boots, so the bundle is fetched too.
 *   /posts             a server-mode page: rendered per request, with a loader.
 *                      The loader payload must be in the document, and two
 *                      requests must report different `loadedAt` values — a
 *                      build-time render would report the same one twice.
 *   /api/hello         the API surface, unchanged.
 *   /nope              an unknown path is the 404 page, not a stack trace and
 *                      not the platform's own error.
 *
 * Usage:
 *   node scripts/assert-served-pages.mjs http://localhost:8787
 */

const baseUrl = (process.argv[2] || '').replace(/\/+$/, '');
if (!baseUrl) {
  console.error('Usage: node scripts/assert-served-pages.mjs <base-url>');
  process.exit(1);
}

const failures = [];

function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok   ${name}`);
    return true;
  }
  console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  failures.push(name);
  return false;
}

async function get(path) {
  const res = await fetch(`${baseUrl}${path}`, { redirect: 'follow' });
  return { status: res.status, body: await res.text(), contentType: res.headers.get('content-type') || '' };
}

console.log(`Asserting served pages at ${baseUrl}`);

// ── Prerendered page ──
const home = await get('/');
check('GET / is 200', home.status === 200, `got ${home.status}`);
check('GET / renders page markup', /<h1[\s>]/.test(home.body), home.body.slice(0, 120));

// ── Client-mode page and its browser bundle ──
const dashboard = await get('/dashboard');
check('GET /dashboard is 200', dashboard.status === 200, `got ${dashboard.status}`);
const bundlePath = dashboard.body.match(/\/_then\/pages\/[A-Za-z0-9._/-]+\.js/)?.[0];
if (check('GET /dashboard references a browser bundle', Boolean(bundlePath))) {
  const bundle = await get(bundlePath);
  check(`GET ${bundlePath} is 200`, bundle.status === 200, `got ${bundle.status}`);
  check(`GET ${bundlePath} is JavaScript`, /javascript|ecmascript/.test(bundle.contentType), bundle.contentType);
}

// ── Server-mode page with a loader ──
const posts = await get('/posts');
check('GET /posts is 200', posts.status === 200, `got ${posts.status}`);
check('GET /posts ran the loader', posts.body.includes('LOADED:hello-from-the-loader'), posts.body.slice(0, 160));
check('GET /posts embeds the loader payload', posts.body.includes('id="__VURA_LOADER__"'));

// The loader must run per request. A page rendered once at build time and
// cached would return the same timestamp twice, which is the difference
// between a server-mode page and a prerendered one.
const readLoadedAt = async () => (await get('/posts')).body.match(/AT:([^<]+)</)?.[1];
const first = await readLoadedAt();
await new Promise(r => setTimeout(r, 1100));
const second = await readLoadedAt();
check(
  'GET /posts runs its loader per request',
  Boolean(first) && Boolean(second) && first !== second,
  `first=${first} second=${second}`,
);

// ── API, unchanged ──
const api = await get('/api/hello');
check('GET /api/hello is 200', api.status === 200, `got ${api.status}`);
check('GET /api/hello returns the route payload', api.body.includes('"message"'), api.body.slice(0, 120));

// ── Unknown path ──
const missing = await get('/nope');
check('GET /nope is 404', missing.status === 404, `got ${missing.status}`);
check('GET /nope is the 404 page', missing.body.includes('404'), missing.body.slice(0, 160));

if (failures.length > 0) {
  console.error(`\n${failures.length} page assertion(s) failed: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nAll page assertions passed.');
