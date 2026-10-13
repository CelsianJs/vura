/**
 * Three defects with one cause, in a real built server.
 *
 * `vura build` emits dist/server/entry.js plus a separate bundle per page, API
 * route and action, and every one of those bundles inlines its own copy of
 * @celsian/vura-core through the runtime shim. A module-level variable is
 * therefore one slot per bundle, not one per process. The codebase already
 * answers that with globalThis + Symbol.for in the actions registry, the loader
 * context and the HttpError brand; two places were missed, and a third gap sat
 * one layer down in how Celsian ends a failed request.
 *
 *   1. onResponse hooks never ran for a request whose handler threw, so every
 *      access log and every metrics counter omitted exactly the failures.
 *   2. A handler registered with setGlobalErrorHandler in src/api/_hooks.ts was
 *      invisible to reportError() called from a route: no output at all.
 *   3. revalidateTag() from a route printed "no cache is bound; this is a
 *      no-op" over an invalidation that had landed, so production logs told an
 *      operator their purges were broken while they worked.
 *
 * Unit tests cannot see any of this: they import one copy of everything. These
 * assertions read the stdout of `node dist/server/entry.js`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { scaffoldAndBuild, bootServer, bootDevServer } from './helpers.js';

let server: Awaited<ReturnType<typeof bootServer>>;

beforeAll(async () => {
  await scaffoldAndBuild();
  server = await bootServer({
    NODE_ENV: 'production',
    PORT: '0',
    VURA_POSTS_DB: `/tmp/vura-audit-split-${Date.now()}.json`,
  });
}, 300_000);

afterAll(async () => {
  await server?.kill();
});

const base = () => server.url;

/** onResponse is fire-and-forget, so give the line a moment to reach stdout. */
async function settled(): Promise<string> {
  await new Promise((r) => setTimeout(r, 150));
  return server.stdout();
}

describe('S1: onResponse hooks run for a failed request', () => {
  it('logs the success path, as it always did', async () => {
    const res = await fetch(`${base()}/api/counter`);
    expect(res.status).toBe(200);
    expect(await settled()).toContain('AUDIT-ONRESPONSE /api/counter status=200 hadError=false');
  });

  it('logs an unbranded throw with the sanitised 500 that was sent', async () => {
    const res = await fetch(`${base()}/api/explode`);
    expect(res.status).toBe(500);
    const out = await settled();
    expect(out).toContain('AUDIT-ONERROR audit-explosion');
    expect(out).toContain('AUDIT-ONRESPONSE /api/explode status=500 hadError=true');
  });

  it('logs a thrown HttpError with its own status, not a blanket 500', async () => {
    const res = await fetch(`${base()}/api/boom`);
    expect(res.status).toBe(404);
    expect(await settled()).toContain('AUDIT-ONRESPONSE /api/boom status=404 hadError=true');
  });
});

describe('S2: the global error handler is reachable from a route bundle', () => {
  it('reaches a handler registered in src/api/_hooks.ts', async () => {
    const res = await fetch(`${base()}/api/report`);
    expect(res.status).toBe(200);
    expect(await settled()).toContain('AUDIT-GLOBAL-HANDLER AUDIT-REPORTED-FROM-ROUTE');
  });

  it('still reaches it from the hooks file itself', async () => {
    // Control: this path shares the entry bundle's copy of core, so it worked
    // before the fix. A failure here means the fix broke the working case.
    await fetch(`${base()}/api/explode`);
    expect(await settled()).toContain('AUDIT-GLOBAL-HANDLER audit-explosion');
  });
});

describe('S3: a route-side revalidateTag does not claim to be a no-op', () => {
  it('purges the ISR page and says nothing about an unbound cache', async () => {
    const before = await (await fetch(`${base()}/posts`)).text();
    const cached = await (await fetch(`${base()}/posts`)).text();
    // Control: without a purge the page is served from cache, so a changed
    // body below is the purge and not the passage of time.
    expect(cached).toBe(before);

    const mutation = await fetch(`${base()}/api/posts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'split-audit' }),
    });
    expect(mutation.status).toBe(201);

    const after = await (await fetch(`${base()}/posts`)).text();
    expect(after).not.toBe(before);
    expect(after).toContain('split-audit');

    expect(await settled()).not.toContain('no cache is bound');
  });
});

describe('S4: `vura dev` runs onResponse for a failed request too', () => {
  // The onResponse gap is not a bundling defect: dev and the built server both
  // mount their API routes through createApiApp, so both stopped short of the
  // hooks on the error path. Dev is the half that has drifted every time
  // something shipped, so it is held to the same assertions.
  let dev: Awaited<ReturnType<typeof bootDevServer>>;

  beforeAll(async () => {
    await scaffoldAndBuild();
    dev = await bootDevServer();
  }, 300_000);

  afterAll(async () => {
    await dev?.kill();
  });

  async function devOutput(): Promise<string> {
    await new Promise((r) => setTimeout(r, 150));
    return dev.stdout();
  }

  it('logs a failed request with the status that was sent', async () => {
    const res = await fetch(`${dev.url}/api/explode`);
    expect(res.status).toBe(500);
    expect(await devOutput()).toContain('AUDIT-ONRESPONSE /api/explode status=500 hadError=true');
  }, 60_000);

  it('logs a successful request as it always did', async () => {
    const res = await fetch(`${dev.url}/api/counter`);
    expect(res.status).toBe(200);
    expect(await devOutput()).toContain('AUDIT-ONRESPONSE /api/counter status=200 hadError=false');
  }, 60_000);
});
