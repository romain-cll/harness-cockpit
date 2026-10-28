import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Kills the daemons a failed test left behind (they outlive their app).
    globalSetup: ['test/global-teardown.ts'],
    // One file at a time: the teardown's own test kills every daemon under the tests' temporary
    // folders, those of a launch running in another file included.
    fileParallelism: false,
    testTimeout: 30_000,
    // Starting the dev server or the app takes a while.
    hookTimeout: 120_000,
  },
});
