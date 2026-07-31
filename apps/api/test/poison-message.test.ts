import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { build } from '../src/server';
import { prisma } from '../src/config/prisma';
import { redis } from '../src/config/redis';
import {
  DLQ_KEY,
  MAX_ATTEMPTS,
  PARKED_KEY,
  QUEUE_KEY,
  drainClickEvents,
  replayDeadLetters,
  type DeadLetterEnvelope,
} from '../src/workers/click-event.worker';
import {
  login,
  makeAdmin,
  makeAffiliate,
  makeBrand,
  makeCampaign,
  makeRelationship,
  makeTrackingLink,
} from './factories';

/**
 * One bad click event should cost one click event.
 *
 * Before this, `flushBatch` wrote up to 100 events in a single transaction. An
 * event that parsed as JSON but violated a foreign key threw inside it, the
 * whole transaction rolled back, and all 100 went to the DLQ -- where replay
 * put the poison message straight back and the same thing happened again.
 */
describe('poison click events', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await build({ rateLimit: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function link() {
    const brand = await makeBrand();
    const campaign = await makeCampaign(brand.id);
    const affiliate = await makeAffiliate();
    await makeRelationship(brand.id, affiliate.id);
    return makeTrackingLink(affiliate.id, campaign.id);
  }

  function event(trackingLinkId: string, overrides: Record<string, unknown> = {}) {
    return JSON.stringify({
      trackingLinkId,
      affiliateId: 'aff-1',
      campaignId: 'camp-1',
      cookieId: `cookie-${Math.random().toString(36).slice(2)}`,
      timestamp: Date.now(),
      ip: 'hashed-ip',
      userAgent: 'Mozilla/5.0 (test)',
      referrer: '',
      subIds: {},
      ...overrides,
    });
  }

  it('commits 99 good events and dead-letters the one bad one', async () => {
    // The headline case. The poison event has a trackingLinkId that does not
    // exist, which no schema can catch -- only the foreign key knows.
    const tl = await link();

    for (let i = 0; i < 99; i++) {
      await redis.lpush(QUEUE_KEY, event(tl.id));
    }
    await redis.lpush(QUEUE_KEY, event('does-not-exist'));

    const result = await drainClickEvents();

    expect(result.flushed).toBe(99);
    expect(result.deadLettered).toBe(1);
    expect(await prisma.clickEvent.count()).toBe(99);
    expect(await redis.llen(DLQ_KEY)).toBe(1);

    // The denormalised counter must agree with the rows that were written.
    const after = await prisma.trackingLink.findUniqueOrThrow({ where: { id: tl.id } });
    expect(after.clickCount).toBe(99);
  });

  it('costs exactly one transaction when nothing is wrong', async () => {
    // Retry machinery that slows down the 99.9% case is a bad trade, so the
    // happy path is asserted rather than assumed.
    const tl = await link();
    for (let i = 0; i < 20; i++) await redis.lpush(QUEUE_KEY, event(tl.id));

    const spy = vi.spyOn(prisma, '$transaction');
    await drainClickEvents();

    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('rejects a schema-invalid event before it reaches Postgres', async () => {
    const tl = await link();
    await redis.lpush(QUEUE_KEY, event(tl.id));
    // Missing trackingLinkId entirely.
    await redis.lpush(QUEUE_KEY, JSON.stringify({ cookieId: 'x', timestamp: Date.now() }));

    const result = await drainClickEvents();

    expect(result.flushed).toBe(1);
    expect(result.deadLettered).toBe(1);
    expect(await prisma.clickEvent.count()).toBe(1);

    const entry = JSON.parse((await redis.lrange(DLQ_KEY, 0, -1))[0]!) as DeadLetterEnvelope;
    expect(entry.reason).toContain('schema');
    expect(entry.attempts).toBe(1);
  });

  it('catches a timestamp in seconds rather than milliseconds', async () => {
    // The classic unit mistake. It parses, it is a number, and it would land
    // in 1970 -- quietly corrupting every time-bucketed report it appeared in.
    const tl = await link();
    await redis.lpush(QUEUE_KEY, event(tl.id, { timestamp: Math.floor(Date.now() / 1000) }));

    const result = await drainClickEvents();

    expect(result.flushed).toBe(0);
    expect(result.deadLettered).toBe(1);
  });

  it('still drops unparseable JSON rather than queueing it forever', async () => {
    await redis.lpush(QUEUE_KEY, 'not json at all{');
    const result = await drainClickEvents();

    expect(result.flushed).toBe(0);
    // Dropped, not dead-lettered: it can never parse, so there is nothing a
    // replay could achieve.
    expect(result.deadLettered).toBe(0);
    expect(await redis.llen(DLQ_KEY)).toBe(0);
  });

  it('writes an envelope with a reason, not a bare payload', async () => {
    await redis.lpush(QUEUE_KEY, event('missing-link'));
    await drainClickEvents();

    const entry = JSON.parse((await redis.lrange(DLQ_KEY, 0, -1))[0]!) as DeadLetterEnvelope;
    expect(entry.payload).toMatchObject({ trackingLinkId: 'missing-link' });
    expect(entry.reason).toBeTruthy();
    expect(entry.attempts).toBe(1);
    expect(entry.firstFailedAt).toBeLessThanOrEqual(entry.lastFailedAt);
  });

  it('parks a message that keeps failing instead of cycling it forever', async () => {
    // The loop the old DLQ had: replay put the poison message back on the
    // queue, it failed, it returned to the DLQ, and an operator replaying
    // again got the same result indefinitely.
    await redis.lpush(QUEUE_KEY, event('never-resolves'));

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await drainClickEvents();
      if (attempt < MAX_ATTEMPTS) {
        const replay = await replayDeadLetters();
        expect(replay.replayed).toBe(1);
      }
    }

    expect(await redis.llen(PARKED_KEY)).toBe(1);
    expect(await redis.llen(DLQ_KEY)).toBe(0);

    const parked = JSON.parse((await redis.lrange(PARKED_KEY, 0, -1))[0]!) as DeadLetterEnvelope;
    expect(parked.attempts).toBe(MAX_ATTEMPTS);

    // And a further replay does not put it back into circulation.
    const after = await replayDeadLetters();
    expect(after.replayed).toBe(0);
  });

  it('surfaces parked events on the admin health page', async () => {
    // A parked message stops consuming capacity, which is the point -- so
    // nothing else would ever tell an operator it exists.
    await redis.lpush(
      PARKED_KEY,
      JSON.stringify({
        payload: {},
        reason: 'FK violation',
        attempts: MAX_ATTEMPTS,
        firstFailedAt: Date.now(),
        lastFailedAt: Date.now(),
      })
    );

    const admin = await makeAdmin();
    const auth = await login(app, admin.email);
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/system',
      headers: auth.authHeader,
    });

    const body = res.json() as { checks: Array<{ name: string; status: string; value?: number }> };
    const parked = body.checks.find((c) => c.name === 'Parked click events')!;
    expect(parked.value).toBe(1);
    expect(parked.status).toBe('degraded');
  });
});
