import { PrismaClient, Prisma } from '@prisma/client';
import argon2 from 'argon2';

/**
 * Volume, so that a query plan means something.
 *
 * `prisma/seed.ts` creates one brand, one affiliate and one campaign, which is
 * exactly enough to click through the UI and exactly not enough to optimise
 * anything: at twelve rows Postgres reads the whole table because reading the
 * whole table is genuinely the fastest thing to do. Every plan is a sequential
 * scan, every query is sub-millisecond, and nothing that will hurt in
 * production is visible.
 *
 * This script exists to make the plans honest. It is deterministic given the
 * same `--seed`, so a before/after comparison is comparing the same data and
 * not two different random universes.
 *
 * **It is destructive.** It truncates the tracking tables before it writes, so
 * point DATABASE_URL at a scratch database rather than at anything you would
 * miss:
 *
 * ```bash
 * createdb affiliate_perf
 * DATABASE_URL=postgresql://.../affiliate_perf npm run seed:bulk
 * ```
 */

export interface BulkSeedOptions {
  brands?: number;
  affiliatesPerBrand?: number;
  campaignsPerBrand?: number;
  links?: number;
  clicks?: number;
  conversions?: number;
  /** How far back the oldest click is. Analytics windows are 30-90 days. */
  days?: number;
  /** Anything derived from this is reproducible; nothing else is random. */
  seed?: number;
  log?: (message: string) => void;
}

const DEFAULTS = {
  brands: 5,
  affiliatesPerBrand: 12,
  campaignsPerBrand: 5,
  links: 400,
  clicks: 500_000,
  conversions: 60_000,
  days: 90,
  seed: 20260731,
} as const;

/**
 * Rows per `createMany`.
 *
 * One statement per row is the mistake this whole story is about; one
 * statement for 500,000 rows overruns the parameter limit and buffers the lot
 * in memory. Five thousand is the flat part of the curve.
 */
const CHUNK = 5_000;

/** Deterministic PRNG (mulberry32). `Math.random()` would make runs incomparable. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (X11; Linux x86_64; rv:122.0) Gecko/20100101 Firefox/122.0',
];
const BOT_AGENTS = [
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
];
const REFERRERS = [
  'https://www.google.com/',
  'https://t.co/',
  'https://news.ycombinator.com/',
  'https://www.reddit.com/r/saas',
  '',
];
const SUB_ID_KEYS = ['utm_source', 'placement', 'creative'];
const SUB_ID_VALUES = ['newsletter', 'sidebar', 'review-post', 'youtube', 'banner-a'];

/**
 * Clicks are not spread evenly over links, and a plan built against data that
 * says they are is a plan for a system that does not exist. A handful of
 * placements carry most of the traffic, which is what makes an index on
 * `trackingLinkId` selective for the long tail and useless for the head.
 */
function zipfPick(random: () => number, n: number) {
  const u = random();
  return Math.min(n - 1, Math.floor(n * u * u * u));
}

export async function bulkSeed(prisma: PrismaClient, options: BulkSeedOptions = {}) {
  // `??` per field rather than a spread: an options object built from CLI
  // flags carries explicit `undefined`s, and `{ ...DEFAULTS, ...options }`
  // lets those overwrite the defaults with nothing.
  const opts = {
    brands: options.brands ?? DEFAULTS.brands,
    affiliatesPerBrand: options.affiliatesPerBrand ?? DEFAULTS.affiliatesPerBrand,
    campaignsPerBrand: options.campaignsPerBrand ?? DEFAULTS.campaignsPerBrand,
    links: options.links ?? DEFAULTS.links,
    clicks: options.clicks ?? DEFAULTS.clicks,
    conversions: options.conversions ?? DEFAULTS.conversions,
    days: options.days ?? DEFAULTS.days,
    seed: options.seed ?? DEFAULTS.seed,
  };
  const log = options.log ?? ((m: string) => console.log(m));
  const random = rng(opts.seed);
  const started = Date.now();

  const now = Date.now();
  const windowMs = opts.days * 86400 * 1000;

  // Truncated rather than upserted. Re-running has to produce the same
  // database, and "insert if missing" over half a million rows costs more than
  // writing them again.
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "Commission", "Subscription", "FraudReview", "Conversion",
       "ClickEvent", "TrackingLink", "CampaignApiKey", "CreativeAsset", "Campaign",
       "BrandAffiliate" RESTART IDENTITY CASCADE`
  );

  // One hash, reused. Argon2 is deliberately expensive; hashing 65 of them
  // would take longer than the half million click rows.
  const passwordHash = await argon2.hash('Password123!', { type: argon2.argon2id });

  const brandIds = Array.from({ length: opts.brands }, (_, i) => `perf-brand-${i}`);
  const affiliateIds = Array.from(
    { length: opts.brands * opts.affiliatesPerBrand },
    (_, i) => `perf-aff-${i}`
  );

  await prisma.user.createMany({
    skipDuplicates: true,
    data: [
      ...brandIds.map((id, i) => ({
        id,
        email: `perf-brand-${i}@example.com`,
        passwordHash,
        firstName: 'Brand',
        lastName: `Number ${i}`,
        role: 'BRAND' as const,
        companyName: `Perf Brand ${i}`,
        emailVerified: true,
      })),
      ...affiliateIds.map((id, i) => ({
        id,
        email: `perf-aff-${i}@example.com`,
        passwordHash,
        firstName: 'Affiliate',
        lastName: `Number ${i}`,
        role: 'AFFILIATE' as const,
        emailVerified: true,
      })),
    ],
  });

  await prisma.brandAffiliate.createMany({
    data: affiliateIds.map((affiliateId, i) => ({
      id: `perf-rel-${i}`,
      brandId: brandIds[i % opts.brands]!,
      affiliateId,
      // A few rejected relationships, so the breakdown's `status = 'APPROVED'`
      // filter has something to exclude.
      status: i % 17 === 0 ? ('PENDING' as const) : ('APPROVED' as const),
    })),
  });

  const campaignCount = opts.brands * opts.campaignsPerBrand;
  await prisma.campaign.createMany({
    data: Array.from({ length: campaignCount }, (_, i) => ({
      id: `perf-camp-${i}`,
      brandId: brandIds[i % opts.brands]!,
      name: `Perf Campaign ${i}`,
      slug: `perf-campaign-${i}`,
      landingPageUrl: 'https://example.com/landing',
      allowedDomains: ['example.com'],
      status: 'ACTIVE' as const,
      commissionStructure: { type: 'percentage', percentage: 10 + (i % 5) * 5 },
      startDate: new Date(now - windowMs),
    })),
  });

  // Links belong to an affiliate the brand actually approved, so the joins in
  // the breakdown queries resolve the way they do in production.
  const links = Array.from({ length: opts.links }, (_, i) => {
    const brandIndex = i % opts.brands;
    const campaignIndex =
      brandIndex + opts.brands * Math.floor((i / opts.brands) % opts.campaignsPerBrand);
    const affiliateIndex =
      brandIndex + opts.brands * Math.floor((i / opts.brands) % opts.affiliatesPerBrand);
    return {
      id: `perf-link-${i}`,
      affiliateId: affiliateIds[affiliateIndex]!,
      campaignId: `perf-camp-${campaignIndex}`,
      shortCode: `perf${i.toString(36)}`,
      destinationUrl: 'https://example.com/product',
      createdAt: new Date(now - windowMs),
    };
  });
  await prisma.trackingLink.createMany({ data: links });

  log(
    `users ${brandIds.length + affiliateIds.length} · campaigns ${campaignCount} · links ${links.length}`
  );

  // ---- Click events ------------------------------------------------------

  let written = 0;
  let batch: Prisma.ClickEventCreateManyInput[] = [];
  for (let i = 0; i < opts.clicks; i++) {
    const link = links[zipfPick(random, links.length)]!;
    const isBot = random() < 0.06;
    const userAgent = isBot
      ? BOT_AGENTS[Math.floor(random() * BOT_AGENTS.length)]!
      : USER_AGENTS[Math.floor(random() * USER_AGENTS.length)]!;
    const hasSubIds = random() < 0.3;

    batch.push({
      id: `perf-click-${i}`,
      trackingLinkId: link.id,
      timestamp: new Date(now - Math.floor(random() * windowMs)),
      ipHash: `iphash-${Math.floor(random() * 50_000)}`,
      userAgent,
      referrer: REFERRERS[Math.floor(random() * REFERRERS.length)]!,
      deviceType: isBot ? 'bot' : i % 3 === 0 ? 'mobile' : 'desktop',
      browser: isBot ? null : 'Chrome',
      os: isBot ? null : 'Mac OS',
      attributionCookieId: `perf-cookie-${i}`,
      trafficKind: isBot ? 'crawler' : 'human',
      isCounted: !isBot,
      subIds: hasSubIds
        ? {
            [SUB_ID_KEYS[Math.floor(random() * SUB_ID_KEYS.length)]!]:
              SUB_ID_VALUES[Math.floor(random() * SUB_ID_VALUES.length)]!,
          }
        : Prisma.DbNull,
    });

    if (batch.length === CHUNK) {
      await prisma.clickEvent.createMany({ data: batch });
      written += batch.length;
      batch = [];
      if (written % 100_000 === 0) log(`clicks ${written}/${opts.clicks}`);
    }
  }
  if (batch.length > 0) {
    await prisma.clickEvent.createMany({ data: batch });
    written += batch.length;
  }
  log(`clicks ${written}`);

  // ---- Conversions -------------------------------------------------------

  const linkOfCampaign = new Map<string, string[]>();
  for (const l of links) {
    const list = linkOfCampaign.get(l.campaignId) ?? [];
    list.push(l.id);
    linkOfCampaign.set(l.campaignId, list);
  }

  let convBatch: Prisma.ConversionCreateManyInput[] = [];
  let convWritten = 0;
  for (let i = 0; i < opts.conversions; i++) {
    const link = links[zipfPick(random, links.length)]!;
    const value = 20 + Math.floor(random() * 480);
    const roll = random();
    const status = roll < 0.7 ? 'APPROVED' : roll < 0.9 ? 'PENDING' : 'REJECTED';

    convBatch.push({
      id: `perf-conv-${i}`,
      trackingLinkId: link.id,
      campaignId: link.campaignId,
      affiliateId: link.affiliateId,
      externalOrderId: `perf-order-${i}`,
      conversionValue: new Prisma.Decimal(value.toFixed(2)),
      commissionAmount: new Prisma.Decimal((value * 0.15).toFixed(2)),
      status: status as 'APPROVED' | 'PENDING' | 'REJECTED',
      occurredAt: new Date(now - Math.floor(random() * windowMs)),
      subIds:
        random() < 0.3
          ? {
              [SUB_ID_KEYS[Math.floor(random() * SUB_ID_KEYS.length)]!]:
                SUB_ID_VALUES[Math.floor(random() * SUB_ID_VALUES.length)]!,
            }
          : Prisma.DbNull,
    });

    if (convBatch.length === CHUNK) {
      await prisma.conversion.createMany({ data: convBatch });
      convWritten += convBatch.length;
      convBatch = [];
    }
  }
  if (convBatch.length > 0) {
    await prisma.conversion.createMany({ data: convBatch });
    convWritten += convBatch.length;
  }
  log(`conversions ${convWritten}`);

  // The denormalised counters have to agree with the rows, or a test that
  // compares the two is testing the seed rather than the code.
  await prisma.$executeRawUnsafe(`
    UPDATE "TrackingLink" tl
    SET "clickCount" = COALESCE(agg.clicks, 0)
    FROM (
      SELECT "trackingLinkId" AS id, COUNT(*) AS clicks
      FROM "ClickEvent" WHERE "isCounted" GROUP BY 1
    ) agg
    WHERE agg.id = tl.id
  `);
  await prisma.$executeRawUnsafe(`
    UPDATE "TrackingLink" tl
    SET "conversionCount" = COALESCE(agg.n, 0), "revenue" = COALESCE(agg.revenue, 0)
    FROM (
      SELECT "trackingLinkId" AS id, COUNT(*) AS n, SUM("conversionValue") AS revenue
      FROM "Conversion" WHERE "status" = 'APPROVED' GROUP BY 1
    ) agg
    WHERE agg.id = tl.id
  `);

  // ANALYZE, because without it the planner is still working from the
  // statistics it had when the tables were empty: it estimates one row where
  // there are half a million, picks a nested loop, and the plan you capture is
  // evidence of nothing except that you forgot to run it.
  //
  // VACUUM as well, because of the visibility map. An index-only scan still
  // has to check whether each row is visible to this transaction, and it can
  // skip that check only for pages the visibility map marks all-visible --
  // which only VACUUM sets. On a freshly bulk-loaded table the map is empty,
  // so every "index only" scan silently fetches from the heap anyway and the
  // plan you were trying to demonstrate does not appear. Autovacuum would get
  // here eventually; "eventually" is not a benchmark protocol.
  await prisma.$executeRawUnsafe('VACUUM ANALYZE');

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  log(`done in ${seconds}s`);

  return {
    brands: brandIds.length,
    affiliates: affiliateIds.length,
    campaigns: campaignCount,
    links: links.length,
    clicks: written,
    conversions: convWritten,
    seconds: Number(seconds),
  };
}

/** Only when run as a script -- importing this module must not write anything. */
async function main() {
  const prisma = new PrismaClient();
  const numeric = (flag: string) => {
    const raw = process.argv.find((a) => a.startsWith(`--${flag}=`));
    return raw ? Number(raw.split('=')[1]) : undefined;
  };

  try {
    const result = await bulkSeed(prisma, {
      clicks: numeric('clicks'),
      conversions: numeric('conversions'),
      links: numeric('links'),
      seed: numeric('seed'),
    });
    console.log(result);
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1]?.includes('seed-bulk')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
