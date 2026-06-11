/**
 * Vura ISR Cache Engine
 *
 * Wraps what-isr's createCacheEngine with vura-opinionated defaults and wires
 * revalidatePath / revalidateTag into what-framework's revalidation registry so
 * app code can import them from '@celsian/vura-core'.
 *
 * Type-gap notes (what-fw@0.11.1):
 *   - what-framework/server.d.ts does not yet export setRevalidationHandler,
 *     revalidatePath, or revalidateTag — they exist at runtime via
 *     revalidation-registry.js → what-server → what-framework/server.
 *     @ts-ignore used on those import lines until upstream types ship.
 *   - createRevalidateWebhook options type is { secret: string }; runtime also
 *     accepts `header` (webhook.js:21). Cast to { secret: string } to satisfy tsc.
 *   - createMemoryStore types { max?: number } — used as-is (canonical typed key).
 */

import {
  createCacheEngine,
  createMemoryStore,
  createFilesystemStore,
  createRedisStore,
  createRevalidateWebhook,
  createCloudflareCDN,
  createFastlyCDN,
} from 'what-isr';

// These three symbols exist at runtime but are absent from what-framework/server.d.ts@0.11.1.
// @ts-ignore
import { setRevalidationHandler } from 'what-framework/server';
// @ts-ignore
import { revalidatePath as _whatRevalidatePath } from 'what-framework/server';
// @ts-ignore
import { revalidateTag as _whatRevalidateTag } from 'what-framework/server';

// ---------------------------------------------------------------------------
// Public re-exports — delegate to what-framework's registry (module singleton).
// createVuraCache populates the registry via setRevalidationHandler.
// App code (and tests) can also call setRevalidationHandler directly to swap
// in a different handler (e.g. a spy in tests).
// ---------------------------------------------------------------------------

/**
 * Invalidate a cached path.
 * Requires createVuraCache() (or a manual setRevalidationHandler call) first.
 */
export async function revalidatePath(path: string, options?: Record<string, unknown>): Promise<void> {
  return _whatRevalidatePath(path, options);
}

/**
 * Invalidate all cached entries tagged with `tag`.
 * Requires createVuraCache() (or a manual setRevalidationHandler call) first.
 */
export async function revalidateTag(tag: string, options?: Record<string, unknown>): Promise<void> {
  return _whatRevalidateTag(tag, options);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface VuraCacheConfig {
  /** Backing store type (default: 'memory') */
  store?: 'memory' | 'filesystem' | 'redis';
  /** Directory for filesystem store (default: .vura/cache) */
  dir?: string;
  /** Redis client instance — vura does NOT own the connection lifecycle */
  redisClient?: unknown;
  /** Max in-memory entries for memory store (default: 1000) */
  maxEntries?: number;
  /**
   * Shared secret for the POST /__vura/revalidate webhook.
   * If omitted, `webhook` in the return value is `undefined`.
   */
  revalidateSecret?: string;
  /** Optional CDN edge-purge adapter */
  cdn?:
    | { provider: 'cloudflare'; zoneId: string; apiToken: string }
    | { provider: 'fastly'; serviceId: string; apiToken: string };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a what-isr cache engine configured for vura.
 *
 * Wires engine.revalidatePath / revalidateTag into what-framework's revalidation
 * registry (setRevalidationHandler) so every call to revalidatePath/revalidateTag
 * exported from @celsian/vura-core dispatches to the live engine.
 *
 * @example
 * ```ts
 * // server.ts
 * import { createVuraCache } from '@celsian/vura-core';
 * const { engine, webhook } = createVuraCache({
 *   store: 'filesystem',
 *   revalidateSecret: process.env.VURA_REVALIDATE_SECRET,
 * });
 * ```
 */
export function createVuraCache(config: VuraCacheConfig) {
  // --- store ---
  const store =
    config.store === 'filesystem'
      ? createFilesystemStore({ dir: config.dir ?? '.vura/cache' })
      : config.store === 'redis'
        ? createRedisStore({ client: config.redisClient })
        : createMemoryStore({ max: config.maxEntries ?? 1000 });

  // --- cdn adapter (optional) ---
  const cdn =
    config.cdn?.provider === 'cloudflare'
      ? createCloudflareCDN({
          zoneId: (config.cdn as { provider: 'cloudflare'; zoneId: string; apiToken: string }).zoneId,
          apiToken: (config.cdn as { provider: 'cloudflare'; zoneId: string; apiToken: string }).apiToken,
        })
      : config.cdn?.provider === 'fastly'
        ? createFastlyCDN({
            serviceId: (config.cdn as { provider: 'fastly'; serviceId: string; apiToken: string }).serviceId,
            apiToken: (config.cdn as { provider: 'fastly'; serviceId: string; apiToken: string }).apiToken,
          })
        : undefined;

  // --- engine ---
  const engine = createCacheEngine({ store, cdn });

  // Wire into what-framework's revalidation registry so both vura's own
  // revalidatePath/revalidateTag and what-framework server-side action
  // invalidation delegate to this engine.
  setRevalidationHandler({
    revalidatePath: engine.revalidatePath.bind(engine),
    revalidateTag: engine.revalidateTag.bind(engine),
  });

  // --- webhook ---
  // Default what-isr header is 'x-what-revalidate-secret'; vura brands its own.
  // Runtime accepts `header` but @0.11.1 types only declare `secret` — cast away.
  const webhook = config.revalidateSecret
    ? createRevalidateWebhook(engine, {
        secret: config.revalidateSecret,
        header: 'x-vura-revalidate-secret',
      } as { secret: string })
    : undefined;

  return { engine, webhook, store };
}
