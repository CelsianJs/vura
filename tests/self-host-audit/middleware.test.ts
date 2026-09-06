/**
 * Project middleware, proven in a built and booted application.
 *
 * Vura had lifecycle hooks (`src/api/_hooks.ts`) that ran for API routes only:
 * verified by execution, an `onRequest` hook fires for `/api/hello` and does
 * not fire for a server-rendered page or a static one. So the most ordinary
 * requirement there is, an auth guard that keeps an unauthenticated visitor
 * away from a page before it renders, had nowhere to live.
 *
 * These assertions run against the real thing: scaffold, build, boot, HTTP.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
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
const AUTHED = { cookie: 'session=letmein' };

describe('W1: middleware guards a page', () => {
  it('redirects an unauthenticated request before the page renders', async () => {
    const res = await fetch(`${base()}/guarded`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
    // The page's content must not appear in the redirect body.
    expect(await res.text()).not.toContain('SECRET-CONTENT');
  });

  it('lets an authenticated request through to the page', async () => {
    const res = await fetch(`${base()}/guarded`, { headers: AUTHED });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('SECRET-CONTENT');
  });
});

describe('W2: middleware guards an API route', () => {
  it('redirects an unauthenticated API request', async () => {
    const res = await fetch(`${base()}/api/guarded`, { redirect: 'manual' });
    expect(res.status).toBe(302);
  });

  it('lets an authenticated API request through', async () => {
    const res = await fetch(`${base()}/api/guarded`, { headers: AUTHED });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ secret: true });
  });
});

describe('W3: the matcher decides what runs', () => {
  it('leaves unmatched paths alone', async () => {
    // No cookie, and no redirect: this path is outside the matcher.
    const res = await fetch(`${base()}/`, { redirect: 'manual' });
    expect(res.status).toBe(200);
  });

  it('does not attach its header to unmatched paths', async () => {
    const res = await fetch(`${base()}/`);
    expect(res.headers.get('x-vura-middleware')).toBeNull();
  });
});

describe('W4: headers set without short-circuiting', () => {
  it('merges onto the page response', async () => {
    const res = await fetch(`${base()}/guarded`, { headers: AUTHED });
    expect(res.headers.get('x-vura-middleware')).toBe('ran');
  });

  it('merges onto the API response', async () => {
    const res = await fetch(`${base()}/api/guarded`, { headers: AUTHED });
    expect(res.headers.get('x-vura-middleware')).toBe('ran');
  });

  it('is present on the redirect it produced', async () => {
    const res = await fetch(`${base()}/guarded`, { redirect: 'manual' });
    expect(res.headers.get('x-vura-middleware')).toBe('ran');
  });
});

describe('W5: the build emits it', () => {
  it('bundles src/middleware.ts next to the server entry', () => {
    expect(existsSync(join(app.dir, 'dist', 'server', 'middleware.js'))).toBe(true);
  });

  it('records it in the manifest', () => {
    expect(app.readManifest().middleware).toBe('src/middleware.ts');
  });
});
