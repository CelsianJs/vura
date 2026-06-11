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
  it('vura-core src LOC is below the v0.3.0 baseline of 5650 (hot routes quality fixes added ~138 LOC)', () => {
    // v0.2.0 baseline (commit 19d9442) was 5001 LOC.
    // Task 9 (hot routes A2.5) added ~335 LOC → ~5336.  Budget was 5500.
    // Code-quality pass (binary frames, param routes, drain rewrite, shutdown
    // guard, narrow ws catch, HotRequest type): +138 LOC → ~5478.
    // Budget raised to 5650 (~172 headroom). Any significant new feature must
    // bump this ceiling with an honest explanation.
    expect(locOf(join(__dirname, '..', 'src'))).toBeLessThan(5650);
  });
});
