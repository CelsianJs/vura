/**
 * The Worker directory must describe the build that produced it.
 *
 * `buildEnd` rewrites `entry.js`, `wrangler.toml` and the bundle of every route
 * that still exists, and used to leave the bundle of every route that no longer
 * does. `entry.js` stops importing it, so it is dead weight rather than a live
 * endpoint, but `wrangler deploy` uploads the directory, not the import graph.
 *
 * This file uses the real filesystem on purpose. `adapter.test.ts` mocks
 * `node:fs/promises` to inspect what buildEnd *would* write, which cannot see
 * what it leaves behind.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cloudflareAdapter } from '../src/index.js';
import type { ApiRoute, RouteManifest, AdapterBuildContext } from '@celsian/vura-core';

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function route(name: string): ApiRoute {
  return {
    filePath: `src/api/${name}.ts`,
    urlPattern: `/api/${name}`,
    methods: ['GET'],
    kind: 'serverless',
    config: {},
  } as ApiRoute;
}

function contextFor(routes: ApiRoute[]): { ctx: AdapterBuildContext; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'vura-cf-prune-'));
  roots.push(root);
  for (const r of routes) {
    mkdirSync(join(root, r.filePath, '..'), { recursive: true });
    writeFileSync(join(root, r.filePath), 'export async function GET() { return { ok: true }; }\n');
  }
  const manifest = {
    api: routes,
    pages: [],
    actions: [],
    timestamp: new Date().toISOString(),
  } as unknown as RouteManifest;
  return {
    root,
    ctx: {
      serverEntry: join(root, 'dist', 'server', 'entry.js'),
      clientDir: join(root, 'dist', 'client'),
      manifest,
      projectRoot: root,
      outDir: join(root, 'dist'),
    } as AdapterBuildContext,
  };
}

describe('the cloudflare adapter reconciles dist/cloudflare/routes', () => {
  it('drops the bundle of a route that no longer exists', async () => {
    const adapter = cloudflareAdapter({ name: 'app', compatibilityDate: '2024-12-01' });
    const both = [route('keeper'), route('thing')];
    const { ctx, root } = contextFor(both);
    const routesDir = join(root, 'dist', 'cloudflare', 'routes');

    await adapter.buildEnd(ctx);
    // Vacuous unless build 1 actually emitted it.
    expect(existsSync(join(routesDir, 'src_api_thing.js'))).toBe(true);
    expect(existsSync(join(routesDir, 'src_api_keeper.js'))).toBe(true);

    rmSync(join(root, 'src', 'api', 'thing.ts'));
    (ctx.manifest as { api: ApiRoute[] }).api = [both[0]!];
    await adapter.buildEnd(ctx);

    expect(existsSync(join(routesDir, 'src_api_thing.js'))).toBe(false);
    expect(existsSync(join(routesDir, 'src_api_keeper.js'))).toBe(true);
    // The files the adapter rewrites every build are not route bundles and
    // live one level up, so the sweep must not reach them.
    for (const f of ['entry.js', 'wrangler.toml', 'package.json']) {
      expect(existsSync(join(root, 'dist', 'cloudflare', f)), f).toBe(true);
    }
  }, 60_000);

  it('leaves the previous bundles alone when a build fails partway', async () => {
    const adapter = cloudflareAdapter({ name: 'app', compatibilityDate: '2024-12-01' });
    const both = [route('keeper'), route('thing')];
    const { ctx, root } = contextFor(both);
    const routesDir = join(root, 'dist', 'cloudflare', 'routes');

    await adapter.buildEnd(ctx);
    writeFileSync(join(root, 'src', 'api', 'keeper.ts'), 'export function GET( {{{ broken');
    await expect(adapter.buildEnd(ctx)).rejects.toThrow();

    expect(existsSync(join(routesDir, 'src_api_keeper.js'))).toBe(true);
    expect(existsSync(join(routesDir, 'src_api_thing.js'))).toBe(true);
  }, 60_000);
});
