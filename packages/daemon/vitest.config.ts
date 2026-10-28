import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Real shells and sockets: a test waits on output.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
