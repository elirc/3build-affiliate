import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
    setupFiles: ['./test/setup.ts'],

    // One worker. These suites share a database, and truncating tables under
    // a parallel suite produces failures that look like application race
    // conditions rather than test-harness ones.
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },

    // Real I/O plus argon2 hashing in the factories. The default 5s is not
    // enough on a contended machine and produces flakes, not signal.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
