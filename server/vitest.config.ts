import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The two-client integration test runs a real match lifecycle.
    testTimeout: 25_000,
    hookTimeout: 10_000,
  },
});
