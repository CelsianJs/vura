import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/compiler-native/test/**/*.test.ts'],
  },
});
