import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Full-suite runs intentionally execute several real esbuild/server
    // integrations in parallel. Supported Node versions finish reliably but
    // can exceed Vitest's unit-test-oriented 5s/10s defaults under contention.
    testTimeout: 15_000,
    hookTimeout: 30_000,
    // Hermetic test collection: agent worktrees live under .claude/worktrees/
    // and contain full repo copies — without this exclude, root `vitest run`
    // (and test:selfhost-audit) would collect and run their test files too.
    // configDefaults.exclude preserves the stock excludes (node_modules,
    // dist, etc.).
    // compiler-native is an unpublished prototype whose tests require a
    // platform-specific .node artifact. Its dedicated build workflow compiles
    // that artifact and runs the parity suite; the public JS release gate must
    // remain hermetic on clean runners where no native package is installed.
    exclude: [
      ...configDefaults.exclude,
      '**/.claude/**',
      'packages/compiler-native/test/**',
    ],
  },
});
