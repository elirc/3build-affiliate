import { describe, expect, it } from 'vitest';
import { prisma } from '../src/config/prisma';
import { redis } from '../src/config/redis';
import { newDbTiming, runWithDbTiming } from '../src/lib/db-timing';
import { QUEUE_KEY, drainClickEvents } from '../src/workers/click-event.worker';
import {
  makeAffiliate,
  makeBrand,
  makeCampaign,
  makeRelationship,
  makeTrackingLink,
} from './factories';

/**
 * Equivalence tests for the `createMany` rewrite of `flushBatch`.
 *
 * A faster write path that writes different rows is not an optimisation, it is
 * a bug with a good benchmark. So these assert the *output* -- every column of
 * every row, and the denormalised counters -- rather than the duration. The
 * duration is in the pull request; the contract is here.
 */

const CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const GOOGLEBOT =
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

async function scenario() {
  const brand = await makeBrand();
  const campaign = await makeCampaign(brand.id);
  const affiliate = await makeAffiliate();
  await makeRelationship(brand.id, affiliate.id);
  return {
    affiliate,
    campaign,
    linkA: await makeTrackingLink(affiliate.id, campaign.id),
    linkB: await makeTrackingLink(affiliate.id, campaign.id),
  };
}

function queue(payload: Record<string, unknown>) {
  return redis.lpush(
    QUEUE_KEY,
    JSON.stringify({
      timestamp: Date.now() - 60_000,
      ip: 'hashed-ip',
      userAgent: CHROME,
      referrer: '',
      subIds: {},
      ...payload,
    })
  );
}

describe('click batch flush', () => {
  it('writes every column exactly as the per-row loop did', async () => {
    const s = await scenario();
    const at = Date.now() - 120_000;

    await queue({
      trackingLinkId: s.linkA.id,
      cookieId: 'cookie-fields',
      timestamp: at,
      ip: 'ip-hash-1',
      userAgent: CHROME,
      referrer: 'https://news.ycombinator.com/',
      subIds: { subid: 'newsletter', placement: 'header' },
    });

    await drainClickEvents();

    const row = await prisma.clickEvent.findFirstOrThrow();
    expect(row).toMatchObject({
      trackingLinkId: s.linkA.id,
      timestamp: new Date(at),
      ipHash: 'ip-hash-1',
      userAgent: CHROME,
      referrer: 'https://news.ycombinator.com/',
      // Derived from the user agent by UAParser, not taken from the payload.
      deviceType: 'desktop',
      browser: 'Chrome',
      os: 'Mac OS',
      attributionCookieId: 'cookie-fields',
      trafficKind: 'human',
      isCounted: true,
      subIds: { subid: 'newsletter', placement: 'header' },
    });
  });

  it('still normalises sub-IDs on the way in', async () => {
    // The cap belongs at the store, not only at the redirect edge: this worker
    // consumes a Redis list and does not know who wrote to it.
    const s = await scenario();
    await queue({
      trackingLinkId: s.linkA.id,
      cookieId: 'cookie-subids',
      subIds: {
        a: '1',
        b: '2',
        c: '3',
        d: '4',
        e: '5',
        f: 'over the limit',
        _ref: 'reserved',
      },
    });

    await drainClickEvents();

    const row = await prisma.clickEvent.findFirstOrThrow();
    expect(row.subIds).toEqual({ a: '1', b: '2', c: '3', d: '4', e: '5' });
  });

  it('turns an empty referrer into null rather than an empty string', async () => {
    // Small, and exactly the kind of thing a rewrite silently changes. An
    // empty string is a referrer that was reported as empty; NULL is one that
    // was not reported.
    const s = await scenario();
    await queue({ trackingLinkId: s.linkA.id, cookieId: 'cookie-ref', referrer: '' });

    await drainClickEvents();

    expect((await prisma.clickEvent.findFirstOrThrow()).referrer).toBeNull();
  });

  it('writes a hundred rows and moves each link counter by its own count', async () => {
    const s = await scenario();

    // 60 counted on link A, 20 counted on link B, 20 bots split between them.
    for (let i = 0; i < 60; i++) {
      await queue({ trackingLinkId: s.linkA.id, cookieId: `a-${i}` });
    }
    for (let i = 0; i < 20; i++) {
      await queue({ trackingLinkId: s.linkB.id, cookieId: `b-${i}` });
    }
    for (let i = 0; i < 20; i++) {
      await queue({
        trackingLinkId: i % 2 === 0 ? s.linkA.id : s.linkB.id,
        cookieId: `bot-${i}`,
        userAgent: GOOGLEBOT,
      });
    }

    const result = await drainClickEvents();

    expect(result.flushed).toBe(100);
    expect(await prisma.clickEvent.count()).toBe(100);

    // Bot rows are written but must not move a counter -- deleting them would
    // make the filtered totals unverifiable.
    expect(await prisma.clickEvent.count({ where: { isCounted: false } })).toBe(20);

    const a = await prisma.trackingLink.findUniqueOrThrow({ where: { id: s.linkA.id } });
    const b = await prisma.trackingLink.findUniqueOrThrow({ where: { id: s.linkB.id } });
    expect(a.clickCount).toBe(60);
    expect(b.clickCount).toBe(20);
  });

  it('costs a number of statements that scales with links, not with events', async () => {
    // This is the N+1 itself, asserted rather than described. The old loop
    // issued one INSERT per event inside the transaction: a hundred round
    // trips to write a hundred rows. It is now one `createMany` plus one
    // UPDATE per distinct link.
    const s = await scenario();
    for (let i = 0; i < 100; i++) {
      await queue({
        trackingLinkId: i % 2 === 0 ? s.linkA.id : s.linkB.id,
        cookieId: `n-${i}`,
      });
    }

    const timing = newDbTiming();
    await runWithDbTiming(timing, () => drainClickEvents());

    // Lower bound as well as upper: a zero would mean the timing middleware
    // stopped recording, and the upper bound would then pass for the wrong
    // reason.
    expect(timing.queries).toBeGreaterThanOrEqual(2);
    expect(timing.queries).toBeLessThan(10);
    expect(await prisma.clickEvent.count()).toBe(100);
  });

  it('applies nothing at all when the slice fails, so bisection cannot duplicate', async () => {
    // The reason `flushBatch` has to stay one transaction. `bisectCommit`
    // retries *halves* of a failed slice, so anything a failed attempt had
    // already written would be written a second time -- duplicate clicks and
    // double-counted counters, with no error anywhere to explain them.
    const s = await scenario();
    for (let i = 0; i < 6; i++) {
      await queue({ trackingLinkId: s.linkA.id, cookieId: `good-${i}` });
    }
    // Two events whose tracking link does not exist. No schema can catch this;
    // only the foreign key knows.
    await queue({ trackingLinkId: 'does-not-exist', cookieId: 'bad-1' });
    await queue({ trackingLinkId: 'also-missing', cookieId: 'bad-2' });

    const result = await drainClickEvents();

    expect(result.flushed).toBe(6);
    expect(result.deadLettered).toBe(2);

    const rows = await prisma.clickEvent.findMany({
      select: { attributionCookieId: true },
    });
    expect(rows).toHaveLength(6);
    // Exactly once each. A partial apply would show up here as a duplicate
    // cookie id long before anyone noticed the counter was wrong.
    expect(new Set(rows.map((r) => r.attributionCookieId)).size).toBe(6);

    const link = await prisma.trackingLink.findUniqueOrThrow({
      where: { id: s.linkA.id },
    });
    expect(link.clickCount).toBe(6);
  });
});
