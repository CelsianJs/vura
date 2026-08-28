/**
 * A build's output must describe that build, and nothing before it.
 *
 * Every emitter in the pipeline writes the artifacts for the routes and pages
 * that exist now, and none of them removed the artifacts of the ones that no
 * longer do. Deleting `src/api/thing.ts` and rebuilding left
 * `dist/functions/api_thing/`, `dist/server/api/thing.js` and the adapter's own
 * copy on disk: unreferenced by the regenerated entry and manifest, so not a
 * live endpoint, but still shipped by anything that deploys `dist` wholesale.
 * `dist` accreted deleted code until somebody ran `rm -rf` by hand.
 *
 * These tests run the real `build()` over a real project twice, because that
 * second build is the only place the defect exists. A unit test over the sweep
 * itself would pass against the shipped code, which had the sweep for hashed
 * client bundles and for nothing else.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { build } from '../src/build.js';
import { buildManifest } from '../src/manifest.js';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const API_ROUTE = `export const route = { kind: 'serverless' };
export async function GET(_req: any, reply: any) { return reply.json({ ok: true }); }
`;

const TASK_ROUTE = `export const route = { kind: 'task', schedule: '*/5 * * * *' };
export async function POST() { return { done: true }; }
`;

const SERVER_PAGE = `export const page = { mode: 'server', title: 'p' };
export default function P() { return <div>p</div>; }
`;

function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), 'vura-prune-'));
  roots.push(root);
  mkdirSync(join(root, 'src', 'api'), { recursive: true });
  mkdirSync(join(root, 'src', 'pages'), { recursive: true });

  writeFileSync(join(root, 'src', 'api', 'keeper.ts'), API_ROUTE);
  writeFileSync(join(root, 'src', 'api', 'thing.ts'), API_ROUTE);
  writeFileSync(join(root, 'src', 'api', 'sweeper.ts'), TASK_ROUTE);
  writeFileSync(join(root, 'src', 'pages', 'kept.tsx'), SERVER_PAGE);
  writeFileSync(join(root, 'src', 'pages', 'dropped.tsx'), SERVER_PAGE);
  return root;
}

async function rebuild(root: string) {
  return build(await buildManifest(root), {}, root);
}

/** Artifacts of the route and page each test deletes between the two builds. */
const staleArtifacts = (root: string) => [
  join(root, 'dist', 'functions', 'api_thing', 'index.js'),
  join(root, 'dist', 'functions', 'api_thing', 'route.js'),
  join(root, 'dist', 'server', 'api', 'thing.js'),
  join(root, 'dist', 'server', 'pages', 'dropped.js'),
];

/** Artifacts that must survive it. */
const liveArtifacts = (root: string) => [
  join(root, 'dist', 'functions', 'api_keeper', 'index.js'),
  join(root, 'dist', 'functions', 'api_keeper', 'route.js'),
  join(root, 'dist', 'functions', 'package.json'),
  join(root, 'dist', 'functions', 'task_api_sweeper', 'index.js'),
  join(root, 'dist', 'server', 'api', 'keeper.js'),
  join(root, 'dist', 'server', 'pages', 'kept.js'),
  join(root, 'dist', 'server', 'entry.js'),
  join(root, 'dist', 'server', 'entry.source.mjs'),
  join(root, 'dist', 'server', 'package.json'),
];

describe('a rebuild reconciles dist with the sources that still exist', () => {
  it('removes the artifacts of a deleted route and page, and keeps the rest', async () => {
    const root = scaffold();
    await rebuild(root);

    // The first build has to have emitted them, or the second assertion is
    // vacuous: a file that was never written is trivially absent.
    for (const path of staleArtifacts(root)) {
      expect(existsSync(path), `${path} should exist after build 1`).toBe(true);
    }

    rmSync(join(root, 'src', 'api', 'thing.ts'));
    rmSync(join(root, 'src', 'pages', 'dropped.tsx'));
    await rebuild(root);

    for (const path of staleArtifacts(root)) {
      expect(existsSync(path), `${path} should be gone after build 2`).toBe(false);
    }
    for (const path of liveArtifacts(root)) {
      expect(existsSync(path), `${path} should survive build 2`).toBe(true);
    }
    // The emptied function directory goes with its contents.
    expect(existsSync(join(root, 'dist', 'functions', 'api_thing'))).toBe(false);
  }, 120_000);

  it('sweeps a directory whose every source is gone', async () => {
    // The bundlers return early when their collection is empty, so deleting
    // every API route skips the loop that would otherwise notice. The sweep
    // runs from build() for exactly this reason.
    const root = scaffold();
    await rebuild(root);
    expect(existsSync(join(root, 'dist', 'server', 'api', 'keeper.js'))).toBe(true);

    for (const f of ['keeper.ts', 'thing.ts', 'sweeper.ts']) {
      rmSync(join(root, 'src', 'api', f));
    }
    await rebuild(root);

    expect(existsSync(join(root, 'dist', 'server', 'api'))).toBe(false);
    expect(existsSync(join(root, 'dist', 'functions', 'api_keeper'))).toBe(false);
    expect(existsSync(join(root, 'dist', 'functions', 'task_api_sweeper'))).toBe(false);
    // Pages are untouched by an API deletion.
    expect(existsSync(join(root, 'dist', 'server', 'pages', 'kept.js'))).toBe(true);
  }, 120_000);

  it('leaves the previous output alone when a build fails partway', async () => {
    // Destroying good output on a failed build would be worse than the bug:
    // the sweep therefore runs after the writes rather than wiping first, and
    // a build that throws never reaches it.
    const root = scaffold();
    await rebuild(root);

    writeFileSync(join(root, 'src', 'api', 'keeper.ts'), 'export function GET( {{{ syntax error');
    await expect(rebuild(root)).rejects.toThrow();

    for (const path of [...staleArtifacts(root), ...liveArtifacts(root)]) {
      expect(existsSync(path), `${path} should survive a failed build`).toBe(true);
    }
  }, 120_000);
});
