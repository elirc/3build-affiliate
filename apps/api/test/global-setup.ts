import { execSync } from 'node:child_process';

/**
 * Runs once, before any integration suite.
 *
 * Points DATABASE_URL at a dedicated test database and applies migrations to
 * it. Using a separate database rather than the development one means running
 * the suite cannot destroy the data someone was in the middle of clicking
 * through, which is the kind of thing that makes people stop running tests.
 *
 * `migrate deploy` rather than `migrate dev`: deploy is non-interactive and
 * fails loudly on drift. `dev` would offer to reset the database, and an
 * interactive prompt in CI hangs until the job times out.
 */
export async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? deriveTestUrl();
  process.env.DATABASE_URL = url;

  execSync('npx prisma migrate deploy --schema prisma/schema.prisma', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url },
  });
}

/**
 * Runs once, after every suite.
 *
 * The connections belong here rather than in an `afterAll` in setup.ts:
 * `setupFiles` runs per test file, so an `afterAll` there closes the clients
 * after the *first* file and leaves the rest of the run using dead
 * connections. Vitest tears the worker down at the end anyway, so this is
 * mostly about not leaving a socket open long enough for CI to complain.
 */
export async function teardown() {
  const { prisma } = await import('../src/config/prisma');
  const { redis } = await import('../src/config/redis');
  await prisma.$disconnect();
  redis.disconnect();
}

/**
 * Derives `<dev database>_test` from DATABASE_URL so the common case needs no
 * extra configuration. CI sets TEST_DATABASE_URL explicitly.
 */
function deriveTestUrl(): string {
  const base = process.env.DATABASE_URL;
  if (!base) {
    throw new Error(
      'Integration tests need DATABASE_URL (or TEST_DATABASE_URL) to be set'
    );
  }
  const parsed = new URL(base);
  parsed.pathname = `${parsed.pathname.replace(/\/$/, '')}_test`;
  return parsed.toString();
}
