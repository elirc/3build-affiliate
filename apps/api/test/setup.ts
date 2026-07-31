import { beforeEach } from 'vitest';
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
  // A key held over from a previous test would make the next request with the
  // same key replay a response for a row that no longer exists.
  'IdempotencyKey',
  // Sessions must not survive a test. A leftover refresh token from a previous
  // test is a live credential for a user that no longer exists, and reuse
  // detection is precisely the kind of feature whose tests would pass or fail
  // depending on what ran before them.
  'RefreshToken',
  'NotificationPreference',
  'Notification',
  // Before WebhookEndpoint, which is before User: a delivery references an
  // endpoint, and an endpoint references the brand that registered it.
  'WebhookDelivery',
  'WebhookEndpoint',
  'FraudReview',
  'Commission',
  'Subscription',
  'Conversion',
  'ClickEvent',
  'TrackingLink',
  'CampaignApiKey',
  'CreativeAsset',
  'BalanceAdjustment',
  'CommissionOverrideEvent',
  'PayoutEvent',
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

/**
 * Deliberately no `afterAll` disconnect here.
 *
 * `setupFiles` runs once per *test file*, so an `afterAll` registered here
 * fires after every file -- tearing down the Prisma and Redis clients while
 * the remaining files still need them. The symptom was a suite that passed
 * file-by-file and failed as a whole, with foreign key violations in setup
 * where the parent row had been written on a connection that was closed
 * underneath it.
 *
 * Connections are closed once, for the whole run, in global-setup.ts.
 */
