import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function locOf(dir: string): number {
  let total = 0;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) total += locOf(p);
    else if (e.endsWith('.ts')) total += readFileSync(p, 'utf-8').split('\n').length;
  }
  return total;
}

describe('A1.4 success metric', () => {
  it('vura-core src LOC is below the post-Task-13 ceiling of 5920', () => {
    // v0.2.0 baseline (commit 19d9442) was 5001 LOC.
    // Task 9 (hot routes A2.5): +~335 → ~5336; quality pass → ~5478.
    // Task 11 (A2.6): deleted old tasks.ts (-402), added runtime/tasks.ts
    //   (runTaskOnce + cron wiring + /__tasks admin, +~320) and trimmed
    //   server.ts → actual 5585 as of the Task 11 quality pass.
    // Task 13 (A2.7 auth helpers): reworked auth.ts to dual-seam architecture
    //   (Proxy on reply.headers + sync method wrapping via node:crypto createHmac;
    //   removed async Web Crypto, added plain-object/string-return coverage) → actual 5860.
    // Client-mount fix (2026-06-11): generateClientPageEntry in static-render.ts
    //   (+~29 — browser entry wrapper so client/hybrid bundles actually call
    //   mount/hydrate) → actual 5882. Ceiling 5920 leaves ~38 headroom.
    expect(locOf(join(__dirname, '..', 'src'))).toBeLessThan(5920);
  });
});
