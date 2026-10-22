import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      // @colyseus/core dynamically imports @pm2/io (optional peer) to export
      // KeyMetrics stats. The real library's instrumentation writes to
      // process.send(), which crashes vitest's IPC pool. Stub it in tests
      // only; production keeps the real package.
      '@pm2/io': path.resolve(__dirname, 'test/stubs/pm2io.ts'),
    },
  },
  test: {
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 20_000,
    teardownTimeout: 10_000,
    // Worker threads have no process.send(); @pm2/io's KeyMetrics transport
    // (optionally loaded by @colyseus/core for CCU stats) writes to it when
    // it exists, which corrupts vitest's fork-pool IPC. Threads sidestep it.
    pool: 'threads',
  },
});
