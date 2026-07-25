import { defineConfig } from 'vitest/config';

/**
 * Two kinds of test live in this package and they have different needs.
 *
 * Unit tests are pure and fast, and run anywhere. Integration tests talk to a
 * real Postgres and a real Redis, so they need those running and they must not
 * run in parallel against the same database -- two suites truncating tables
 * under each other produces failures that look like race conditions in the
 * application rather than in the test setup.
 *
 * `npm test` runs the unit tests. `npm run test:integration` runs the rest.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['test/**', 'node_modules/**'],
  },
});
