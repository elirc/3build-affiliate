import { afterAll, beforeEach } from 'vitest';
import { prisma } from '../src/config/prisma';
import { redis } from '../src/config/redis';

/**
 * Tables in dependency order, children first.
 *
 * TRUNCATE ... CASCADE would save maintaining this list, but it also silently
 * empties tables a future migration adds without anyone deciding that is
 * correct. An explicit list means adding a model forces a deliberate choice
 * about whether tests should reset it.
 */
const TABLES = [
  'FraudReview',
  'Commission',
  'Conversion',
  'ClickEvent',
  'TrackingLink',
  'CampaignApiKey',
  'CreativeAsset',
  'BalanceAdjustment',
  'Payout',
  'Campaign',
  'BrandAffiliate',
  'User',
];

/**
 * Every test starts from an empty database.
 *
 * The alternative -- wrapping each test in a transaction and rolling back --
 * is faster, but the code under test uses its own transactions, and nesting
 * those inside a test transaction changes the very behaviour these suites
 * exist to verify. Truncation is slower and honest.
 */
export async function resetDatabase() {
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`
  );
}

beforeEach(async () => {
  await resetDatabase();
  // Redis carries link caches and the click queue between tests, and a
  // leftover entry from a previous test is exactly the sort of thing that
  // makes a suite pass in isolation and fail in sequence.
  await redis.flushdb();
});

afterAll(async () => {
  await prisma.$disconnect();
  redis.disconnect();
});
