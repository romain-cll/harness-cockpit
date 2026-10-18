import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    // Starting the dev server or the app takes a while.
    hookTimeout: 120_000,
  },
});
