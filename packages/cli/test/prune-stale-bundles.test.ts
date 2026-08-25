/**
 * Pruning of orphaned client bundles.
 *
 * Bundle filenames carry a content hash, so every edit to a client or hybrid
 * page emits a new name and orphans the old one. Nothing removed those, so
 * `dist/static/_then/pages` grew with every incremental build and shipped the
 * dead copies to whatever the project deployed to.
 *
 * The `fs` argument is injected, so these run against an in-memory tree.
 */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { pruneStaleBundles } from '../src/commands/build.js';

/** A minimal in-memory directory tree with the two calls the pruner makes. */
function fakeFs(tree: Record<string, string[]>) {
  const removed: string[] = [];
  const dirs = { ...tree };
  return {
    removed,
    dirs,
    fs: {
      async readdir(p: string, _o: { withFileTypes: true }) {
        if (!(p in dirs)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return dirs[p].map((name) => ({
          name,
          isDirectory: () => `${p}/${name}` in dirs,
        }));
      },
      async rm(p: string, _o?: { recursive?: boolean; force?: boolean }) {
        removed.push(p);
        for (const [dir, names] of Object.entries(dirs)) {
          const idx = names.indexOf(p.slice(dir.length + 1));
          if (p.startsWith(dir + '/') && idx >= 0 && !p.slice(dir.length + 1).includes('/')) {
            names.splice(idx, 1);
          }
        }
        delete dirs[p];
      },
    },
  };
}

describe('pruneStaleBundles', () => {
  it('removes a bundle this build did not emit', async () => {
    const { fs, removed } = fakeFs({ '/d': ['blog.aaa.js', 'blog.bbb.js'] });
    const n = await pruneStaleBundles('/d', new Set(['/d/blog.bbb.js']), fs as any);
    expect(n).toBe(1);
    expect(removed).toEqual([join('/d', 'blog.aaa.js')]);
  });

  it('keeps every bundle this build did emit', async () => {
    // A page that was not edited is still rebuilt, so it is in the keep set.
    // Deleting it because it "looks old" would break the deploy.
    const { fs, removed } = fakeFs({ '/d': ['blog.aaa.js', 'dash.ccc.js'] });
    const n = await pruneStaleBundles('/d', new Set(['/d/blog.aaa.js', '/d/dash.ccc.js']), fs as any);
    expect(n).toBe(0);
    expect(removed).toEqual([]);
  });

  it('recurses into nested page directories', async () => {
    const { fs, removed } = fakeFs({
      '/d': ['loaders', 'top.aaa.js'],
      '/d/loaders': ['island.old.js', 'island.new.js'],
    });
    const n = await pruneStaleBundles(
      '/d',
      new Set(['/d/top.aaa.js', '/d/loaders/island.new.js']),
      fs as any,
    );
    expect(n).toBe(1);
    expect(removed).toEqual([join('/d/loaders', 'island.old.js')]);
  });

  it('removes a directory left empty by a deleted page', async () => {
    const { fs, removed } = fakeFs({
      '/d': ['gone'],
      '/d/gone': ['page.aaa.js'],
    });
    const n = await pruneStaleBundles('/d', new Set(), fs as any);
    expect(n).toBe(1);
    expect(removed).toContain(join('/d/gone', 'page.aaa.js'));
    expect(removed).toContain('/d/gone');
  });

  it('leaves a directory that still holds a live bundle', async () => {
    const { fs, removed } = fakeFs({
      '/d': ['loaders'],
      '/d/loaders': ['island.new.js'],
    });
    await pruneStaleBundles('/d', new Set(['/d/loaders/island.new.js']), fs as any);
    expect(removed).toEqual([]);
  });

  it('is a no-op when the directory does not exist', async () => {
    // A project with no client or hybrid pages never creates it.
    const { fs } = fakeFs({});
    expect(await pruneStaleBundles('/nope', new Set(), fs as any)).toBe(0);
  });
});
