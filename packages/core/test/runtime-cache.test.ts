import { describe, it, expect, vi, afterEach } from 'vitest';
import { createVuraCache } from '../src/runtime/cache.js';
import { revalidatePath, revalidateTag } from '../src/index.js';
// @ts-ignore: present at runtime, absent from what-framework/server.d.ts
import { setRevalidationHandler, getRevalidationHandler } from 'what-framework/server';

/**
 * Adaptations from plan (grounded against what-fw source):
 *
 * 1. engine.handle(routeMatch, render) — what-isr/src/isr.js. Returns
 *    { html, head, state, status, cacheStatus, headers }.  cacheStatus values:
 *    'MISS' (cold), 'HIT' (fresh), 'STALE' (expired+SWR), 'BYPASS' (mode=server).
 *
 * 2. createRevalidateWebhook(engine, { secret, header }) — what-isr/src/webhook.js.
 *    Default header is 'x-what-revalidate-secret'; vura uses 'x-vura-revalidate-secret'
 *    (passed explicitly in createVuraCache). Webhook fn: (reqLike:{headers,body}) →
 *    {status, body}. No secret → 401; correct secret → 200.
 *
 * 3. setRevalidationHandler — what-server/src/revalidation-registry.js, re-exported
 *    from what-framework/server. Module-level singleton; revalidatePath/revalidateTag
 *    from vura-core re-export the same registry functions. Setting a manual handler
 *    in this test overrides the engine bound by createVuraCache — that's intentional
 *    for isolated unit testing of the dispatch path.
 */

describe('createVuraCache', () => {
  it('builds a memory-store engine by default and serves HIT on second call', async () => {
    const { engine } = createVuraCache({});
    const routeMatch = { path: '/p', query: {}, config: { revalidate: 60 } };
    let renders = 0;
    const render = async () => { renders++; return { html: '<p>x</p>', status: 200, path: '/p' }; };
    const first = await engine.handle(routeMatch, render);
    const second = await engine.handle(routeMatch, render);
    expect(first.cacheStatus).toBe('MISS');
    expect(second.cacheStatus).toBe('HIT');
    expect(renders).toBe(1);
  });

  it('exposes a secret-guarded webhook', async () => {
    const { webhook } = createVuraCache({ revalidateSecret: 's3cret' });
    // Missing secret header → 401
    const denied = await webhook!({ headers: {}, body: { paths: ['/p'] } });
    expect(denied.status).toBe(401);
    // Correct secret header → 200
    const ok = await webhook!({ headers: { 'x-vura-revalidate-secret': 's3cret' }, body: { paths: ['/p'] } });
    expect(ok.status).toBe(200);
  });

  it('binds vura-core revalidateTag/revalidatePath to the engine', async () => {
    // Swap in a spy handler — isolates this test from whichever engine was bound above.
    // revalidatePath/revalidateTag from '@celsian/vura-core' (index.ts) re-export from
    // what-framework/server which reads the same module-level _handler.
    const purged: string[] = [];
    setRevalidationHandler({
      revalidatePath: async (p: string) => { purged.push(p); },
      revalidateTag: async (t: string) => { purged.push(`tag:${t}`); },
    });
    await revalidatePath('/blog/a');
    await revalidateTag('blog');
    expect(purged).toEqual(['/blog/a', 'tag:blog']);
  });

  it('e2e: revalidatePath via createVuraCache registry causes next handle to be a MISS', async () => {
    // Re-create a fresh cache — createVuraCache overwrites the registry handler,
    // so this test is independent of whichever handler was installed by tests above.
    const { engine } = createVuraCache({});
    const routeMatch = { path: '/p', query: {}, config: { revalidate: 60 } };
    let renders = 0;
    const render = async () => { renders++; return { html: '<p>x</p>', status: 200, path: '/p' }; };

    // Populate the cache (MISS then HIT).
    const first = await engine.handle(routeMatch, render);
    expect(first.cacheStatus).toBe('MISS');
    const second = await engine.handle(routeMatch, render);
    expect(second.cacheStatus).toBe('HIT');
    expect(renders).toBe(1);

    // Revalidate through the exported wrapper — proves registry wiring, no bypass.
    await revalidatePath('/p');

    // Next handle must render again (MISS).
    const third = await engine.handle(routeMatch, render);
    expect(third.cacheStatus).toBe('MISS');
    expect(renders).toBe(2);
  });
});

describe('the no-op warning survives the bundle split', () => {
  /**
   * A built server inlines its own copy of this module into every route
   * bundle, so a module-scoped init flag is one slot per bundle.
   * `vi.resetModules()` plus a second import reproduces that: two instances of
   * the module, one process. `createVuraCache()` runs in the entry copy at
   * boot; an API route calling `revalidateTag()` runs in its own.
   *
   * Before the fix that route copy read its own `false`, and every purge from
   * an API route printed "no cache is bound; this is a no-op" over an
   * invalidation that had actually landed. An operator reading production logs
   * was told their purges were broken while they were working.
   */
  async function twoCopies() {
    const entryCopy = await import('../src/runtime/cache.js');
    vi.resetModules();
    const routeCopy = await import('../src/runtime/cache.js');
    expect(routeCopy).not.toBe(entryCopy);
    return { entryCopy, routeCopy };
  }

  let warnSpy: ReturnType<typeof vi.spyOn> | undefined;

  afterEach(() => {
    warnSpy?.mockRestore();
    warnSpy = undefined;
  });

  function captureWarnings(): string[] {
    const lines: string[] = [];
    warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    return lines;
  }

  it('stays quiet when a different copy bound the cache', async () => {
    const { entryCopy, routeCopy } = await twoCopies();
    entryCopy.createVuraCache({});

    const warnings = captureWarnings();
    await routeCopy.revalidateTag('posts');
    await routeCopy.revalidatePath('/posts');

    expect(warnings.filter((line) => line.includes('no cache is bound'))).toEqual([]);
  });

  it('still warns when nothing is bound at all', async () => {
    // The other half of the claim: the warning has to keep firing when it is
    // true, or silencing it would just be deleting the diagnostic.
    const { routeCopy } = await twoCopies();
    const previous = getRevalidationHandler();
    setRevalidationHandler(null as never);
    try {
      const warnings = captureWarnings();
      await routeCopy.revalidateTag('posts');

      expect(warnings.some((line) => line.includes('no cache is bound'))).toBe(true);
    } finally {
      setRevalidationHandler(previous as never);
    }
  });

  it('a purge from another copy really reaches the bound engine', async () => {
    // The warning was the visible half of the bug report; this is the half
    // that says the purge worked all along, so the log line was the defect.
    const { entryCopy, routeCopy } = await twoCopies();
    const { engine } = entryCopy.createVuraCache({});

    const routeMatch = { path: '/split', query: {}, config: { revalidate: 60 } };
    let renders = 0;
    const render = async () => { renders++; return { html: '<p>x</p>', status: 200, path: '/split' }; };

    expect((await engine.handle(routeMatch, render)).cacheStatus).toBe('MISS');
    expect((await engine.handle(routeMatch, render)).cacheStatus).toBe('HIT');

    await routeCopy.revalidatePath('/split');

    expect((await engine.handle(routeMatch, render)).cacheStatus).toBe('MISS');
    expect(renders).toBe(2);
  });
});
