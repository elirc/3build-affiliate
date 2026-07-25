import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { build } from '../src/server';
import { prisma } from '../src/config/prisma';
import { redis } from '../src/config/redis';
import { beat } from '../src/lib/heartbeat';
import {
  DLQ_KEY,
  QUEUE_KEY,
  drainClickEvents,
  replayDeadLetters,
} from '../src/workers/click-event.worker';
import { systemService } from '../src/services/system.service';
import {
  login,
  makeAdmin,
  makeAffiliate,
  makeBrand,
  makeCampaign,
  makeRelationship,
  makeTrackingLink,
} from './factories';

describe('system health', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await build({ rateLimit: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function adminAuth() {
    // Cleared each time: the endpoint caches for 10 seconds, and tests within
    // that window would otherwise see a previous test's answer.
    systemService().clearCache();
    const admin = await makeAdmin();
    return login(app, admin.email);
  }

  function get(auth: { authHeader: Record<string, string> }) {
    return app.inject({
      method: 'GET',
      url: '/api/admin/system',
      headers: auth.authHeader,
    });
  }

  it('reports the database and Redis as reachable', async () => {
    const auth = await adminAuth();
    const body = get2(await get(auth));

    expect(body.checks.find((c) => c.name === 'Database')!.status).toBe('healthy');
    expect(body.checks.find((c) => c.name === 'Redis')!.status).toBe('healthy');
  });

  it('reports a worker with no heartbeat as down', async () => {
    // A key that expires is unambiguous. A "last run" timestamp column would
    // say "three days ago" forever, which looks the same as a worker that ran
    // three days ago and then stopped.
    const auth = await adminAuth();
    const body = get2(await get(auth));

    const worker = body.checks.find((c) => c.name === 'Click worker')!;
    expect(worker.status).toBe('down');
    expect(worker.detail).toContain('DISABLE_WORKERS');
  });

  it('reports a worker as healthy once it beats', async () => {
    await beat('click-event', 1000, { lastFlushed: 3 });
    const auth = await adminAuth();
    const body = get2(await get(auth));

    expect(body.checks.find((c) => c.name === 'Click worker')!.status).toBe(
      'healthy'
    );
  });

  it('reports a worker that is running but failing as degraded, not down', async () => {
    // Alive-and-failing is a different state from absent, and they need
    // different responses.
    await beat('click-event', 1000, { lastError: 'connection reset' });
    const auth = await adminAuth();
    const body = get2(await get(auth));

    const worker = body.checks.find((c) => c.name === 'Click worker')!;
    expect(worker.status).toBe('degraded');
    expect(worker.detail).toContain('connection reset');
  });

  it('surfaces a growing click queue', async () => {
    const auth = await adminAuth();
    await redis.lpush(QUEUE_KEY, JSON.stringify({ trackingLinkId: 'x' }));

    const body = get2(await get(auth));
    const queue = body.checks.find((c) => c.name === 'Click queue')!;
    expect(queue.value).toBe(1);
  });

  it('moves a failed batch to the dead-letter queue instead of losing it', async () => {
    // The regression that matters. Events are RPOPed off the main queue
    // before the transaction runs, so before the DLQ existed a failed flush
    // lost them outright -- the log said "flush failed" and the clicks were
    // simply gone.
    await redis.del(QUEUE_KEY, DLQ_KEY);

    // A tracking link id that does not exist makes the transaction fail.
    await redis.lpush(
      QUEUE_KEY,
      JSON.stringify({
        trackingLinkId: 'no-such-link',
        affiliateId: 'a',
        campaignId: 'c',
        cookieId: 'cookie',
        timestamp: Date.now(),
        ip: 'hash',
        userAgent: 'test',
        referrer: '',
        subIds: {},
      })
    );

    await expect(drainClickEvents()).rejects.toThrow();

    expect(await redis.llen(DLQ_KEY)).toBe(1);
    expect(await redis.llen(QUEUE_KEY)).toBe(0);
  });

  it('replays the dead-letter queue back onto the main queue', async () => {
    await redis.del(QUEUE_KEY, DLQ_KEY);
    await redis.lpush(DLQ_KEY, JSON.stringify({ trackingLinkId: 'x' }));

    const result = await replayDeadLetters();

    expect(result.replayed).toBe(1);
    expect(await redis.llen(DLQ_KEY)).toBe(0);
    expect(await redis.llen(QUEUE_KEY)).toBe(1);
  });

  it('discards malformed events rather than looping on them forever', async () => {
    // Malformed JSON will never parse, however many times it is retried.
    // Requeuing it would block the DLQ permanently.
    await redis.del(QUEUE_KEY, DLQ_KEY);
    await redis.lpush(QUEUE_KEY, 'not json at all{');

    const result = await drainClickEvents();

    expect(result.flushed).toBe(0);
    expect(await redis.llen(DLQ_KEY)).toBe(0);
  });

  it('flags conversions left unreviewed for over a week', async () => {
    const brand = await makeBrand();
    const campaign = await makeCampaign(brand.id);
    const affiliate = await makeAffiliate();
    await makeRelationship(brand.id, affiliate.id);
    const link = await makeTrackingLink(affiliate.id, campaign.id);

    await prisma.conversion.create({
      data: {
        trackingLinkId: link.id,
        campaignId: campaign.id,
        affiliateId: affiliate.id,
        externalOrderId: 'stale-1',
        conversionValue: '100.00',
        commissionAmount: '20.00',
        status: 'PENDING',
        occurredAt: new Date(Date.now() - 10 * 86400 * 1000),
      },
    });

    const auth = await adminAuth();
    const body = get2(await get(auth));

    const stale = body.checks.find((c) => c.name === 'Stale conversions')!;
    expect(stale.status).toBe('degraded');
    // The detail says why it matters, not just that it is true.
    expect(stale.detail).toContain('not being paid');
  });

  it('rolls the worst check up to the overall status', async () => {
    const auth = await adminAuth();
    const body = get2(await get(auth));
    // At least one worker has no heartbeat in the test environment.
    expect(body.status).toBe('down');
  });

  it('keeps the health page away from non-admins', async () => {
    const brand = await makeBrand();
    const brandAuth = await login(app, brand.email);

    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/system',
      headers: brandAuth.authHeader,
    });
    expect(res.statusCode).toBe(403);
  });
});

interface HealthBody {
  status: string;
  checks: Array<{ name: string; status: string; detail: string; value?: number }>;
}

function get2(res: { json: () => unknown }): HealthBody {
  return res.json() as HealthBody;
}
