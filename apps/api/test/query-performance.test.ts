import { describe, expect, it } from 'vitest';
import { rangeFromDays } from '@affiliate/analytics';
import { prisma } from '../src/config/prisma';
import { bulkSeed } from '../prisma/seed-bulk';
import { analyticsService } from '../src/services/analytics.service';
import { breakdownService, subIdService } from '../src/services/breakdown.service';

/**
 * A budget, enforced.
 *
 * Skipped unless `BULK_SEED=1`, because it seeds half a million rows and CI
 * has better things to do on every pull request. That makes it a *regression*
 * test rather than a gate: run it when you touch a query, an index, or the
 * shape of the data, and it will tell you whether the plan you reasoned about
 * is still the plan Postgres picks.
 *
 * ```bash
 * createdb affiliate_perf
 * TEST_DATABASE_URL=postgresql://.../affiliate_perf BULK_SEED=1 \
 *   npm run test:integration --workspace=apps/api -- query-performance
 * ```
 *
 * The plans and the numbers this defends are in
 * `fabledocs/05-query-performance.md`.
 */

const ENABLED = process.env.BULK_SEED === '1';

/**
 * The budget this test enforces, which is deliberately not the target.
 *
 * The target is 100ms -- roughly where a dashboard stops feeling instant. On
 * the machine these queries were tuned on the affiliate-level ones meet it and
 * the brand-level ones do not: they land at 220-380ms, and a bare `COUNT(*)`
 * over the same index range, with no formatting and no sort, already costs
 * 187ms there. No index closes that gap; a daily rollup would, and that is a
 * story of its own.
 *
 * So the assertion guards against *regression* -- the same queries were
 * 900-3,300ms before this branch -- rather than asserting an aspiration this
 * hardware cannot meet. Set QUERY_BUDGET_MS to 100 on a real server and find
 * out. The measurements are in fabledocs/05-query-performance.md.
 */
const BUDGET_MS = Number(process.env.QUERY_BUDGET_MS ?? 750);

/** The brand and affiliate `seed-bulk.ts` gives the most traffic to. */
const BRAND_ID = 'perf-brand-0';
const AFFILIATE_ID = 'perf-aff-0';

/**
 * Median of three, after a warm-up.
 *
 * A single timing on a laptop that is also running Docker measures the laptop.
 * The first call is discarded because it pays for the connection, the plan and
 * a cold buffer cache, none of which a production request repeats on every
 * hit.
 */
async function medianMs(run: () => Promise<unknown>): Promise<number> {
  await run();

  const samples: number[] = [];
  for (let i = 0; i < 3; i++) {
    const started = performance.now();
    await run();
    samples.push(performance.now() - started);
  }
  return samples.sort((a, b) => a - b)[1]!;
}

describe.skipIf(!ENABLED)('dashboard queries at volume', () => {
  /**
   * One test, deliberately.
   *
   * `test/setup.ts` truncates every table before each test -- including
   * before the first one, which is why the seed cannot live in `beforeAll`
   * either. A second `it` would therefore re-seed half a million rows to ask
   * one more question.
   */
  it(
    'answers every dashboard query inside its budget',
    async () => {
      const seeded = await bulkSeed(prisma, { log: () => {} });

      // Otherwise a seed that quietly wrote nothing would make every query
      // fast and this whole file meaningless.
      expect(seeded.clicks).toBeGreaterThanOrEqual(500_000);
      expect(seeded.conversions).toBeGreaterThanOrEqual(50_000);
      expect(seeded.links).toBeGreaterThanOrEqual(200);
      expect(await prisma.clickEvent.count()).toBe(seeded.clicks);

      const analytics = analyticsService();
      const breakdown = breakdownService();
      const subIds = subIdService();
      const window = rangeFromDays(30);

      const timings: Record<string, number> = {
        'brand series': await medianMs(() => analytics.forBrand(BRAND_ID, window)),
        'brand campaigns': await medianMs(() => breakdown.byCampaign(BRAND_ID)),
        'brand affiliates': await medianMs(() => breakdown.byAffiliate(BRAND_ID)),
        'affiliate series': await medianMs(() =>
          analytics.forAffiliate(AFFILIATE_ID, window)
        ),
        'affiliate links': await medianMs(() =>
          breakdown.forAffiliateLinks(AFFILIATE_ID)
        ),
        'affiliate campaigns': await medianMs(() =>
          breakdown.forAffiliateOwnCampaigns(AFFILIATE_ID)
        ),
        'sub-id report': await medianMs(() =>
          subIds.report(AFFILIATE_ID, 'utm_source')
        ),
      };

      // Printed whether or not the assertion passes: a run that comes in at
      // 95ms is worth seeing, and a failure is much easier to act on next to
      // the six numbers that passed.
      console.table(timings);

      for (const [name, ms] of Object.entries(timings)) {
        expect(ms, `${name} took ${ms.toFixed(0)}ms`).toBeLessThan(BUDGET_MS);
      }
    },
    900_000
  );
});
