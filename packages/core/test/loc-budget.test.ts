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
  it('vura-core src LOC is below the post-Task-11 ceiling of 5650', () => {
    // v0.2.0 baseline (commit 19d9442) was 5001 LOC.
    // Task 9 (hot routes A2.5): +~335 → ~5336; quality pass → ~5478.
    // Task 11 (A2.6): deleted old tasks.ts (-402), added runtime/tasks.ts
    //   (runTaskOnce + cron wiring + /__tasks admin, +~320) and trimmed
    //   server.ts → actual 5585 as of the Task 11 quality pass.
    // Ceiling 5650 leaves ~65 headroom; Task 13 (auth helpers) raises it
    //   honestly when it lands.
    expect(locOf(join(__dirname, '..', 'src'))).toBeLessThan(5650);
  });
});
