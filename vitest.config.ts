import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Hermetic test collection: agent worktrees live under .claude/worktrees/
    // and contain full repo copies — without this exclude, root `vitest run`
    // (and test:selfhost-audit) would collect and run their test files too.
    // configDefaults.exclude preserves the stock excludes (node_modules,
    // dist, etc.).
    exclude: [...configDefaults.exclude, '**/.claude/**'],
  },
});
