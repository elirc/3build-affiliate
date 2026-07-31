import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { build } from '../src/server';
import { prisma } from '../src/config/prisma';
import { cleanupIdempotencyKeys } from '../src/plugins/idempotency';
import {
  login,
  makeAffiliate,
  makeApiKey,
  makeClickEvent,
  makeBrand,
  makeCampaign,
  makeRelationship,
  makeTrackingLink,
  postbackHeaders,
} from './factories';

/**
 * Idempotency as a shared concern.
 *
 * Only payout requests were idempotent before, via a unique constraint. That
 * guaranteed the invariant but not the semantics: a retry got whatever the
 * service returned the second time rather than the original response, and a
 * retry arriving mid-flight raced the first request.
 */
describe('idempotency middleware', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await build({ rateLimit: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function brandAuth() {
    const brand = await makeBrand();
    return { brand, auth: await login(app, brand.email) };
  }

  function createCampaign(
    auth: { authHeader: Record<string, string> },
    key: string | undefined,
    body: Record<string, unknown>
  ) {
    return app.inject({
      method: 'POST',
      url: '/api/brand/campaigns',
      headers: { ...auth.authHeader, ...(key ? { 'idempotency-key': key } : {}) },
      payload: body,
    });
  }

  /**
   * A fixed startDate, deliberately.
   *
   * Written first as `new Date().toISOString()`, which made every call produce
   * a *different* body -- so a "retry" carried a different fingerprint and was
   * correctly refused with 422. The middleware was right and the fixture was
   * wrong, which is worth keeping as a comment: a retry means the same bytes,
   * and anything generated per call is not the same bytes.
   */
  const START_DATE = '2026-01-01T00:00:00.000Z';

  const campaignBody = (name = 'Summer Sale') => ({
    name,
    description: 'A campaign',
    landingPageUrl: 'https://example.com/landing',
    allowedDomains: ['example.com'],
    startDate: START_DATE,
    commissionStructure: { type: 'percentage' as const, percentage: 10 },
    lockPeriodDays: 0,
  });

  it('replays the original response byte for byte', async () => {
    const { auth } = await brandAuth();

    const first = await createCampaign(auth, 'key-1', campaignBody());
    expect(first.statusCode).toBe(201);

    const second = await createCampaign(auth, 'key-1', campaignBody());

    expect(second.statusCode).toBe(201);
    expect(second.json()).toEqual(first.json());
    expect(second.headers['idempotent-replay']).toBe('true');

    // One campaign, not two. Without the middleware a double-submitted form
    // creates two identical campaigns and nothing objects.
    expect(await prisma.campaign.count()).toBe(1);
  });

  it('refuses the same key with a different body', async () => {
    const { auth } = await brandAuth();

    await createCampaign(auth, 'key-2', campaignBody('First'));
    const res = await createCampaign(auth, 'key-2', campaignBody('Different'));

    // Replaying the first response here would hide a client bug: it asked for
    // something it did not get and was told everything was fine.
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('is unaffected without the header', async () => {
    const { auth } = await brandAuth();

    await createCampaign(auth, undefined, campaignBody());
    await createCampaign(auth, undefined, campaignBody());

    // No key, no idempotency -- two requests, two campaigns, and no rows kept.
    expect(await prisma.campaign.count()).toBe(2);
    expect(await prisma.idempotencyKey.count()).toBe(0);
  });

  it('creates one conversion from ten concurrent identical postbacks', async () => {
    // The case that matters most: a storefront that retries on timeout.
    const brand = await makeBrand();
    const campaign = await makeCampaign(brand.id);
    const affiliate = await makeAffiliate();
    await makeRelationship(brand.id, affiliate.id);
    const link = await makeTrackingLink(affiliate.id, campaign.id);
    const key = await makeApiKey(campaign.id);
    await makeClickEvent(link.id, {
      cookieId: 'cookie-99',
      timestamp: new Date(Date.now() - 3600_000),
    });

    const body = JSON.stringify({
      externalOrderId: 'order-99',
      conversionValue: 100,
      attributionCookieId: 'cookie-99',
    });

    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        app.inject({
          method: 'POST',
          url: `/api/conversions/${campaign.id}`,
          headers: {
            ...postbackHeaders(key.keyId, key.secret, body),
            'idempotency-key': 'retry-99',
          },
          payload: body,
        })
      )
    );

    expect(await prisma.conversion.count()).toBe(1);

    // Every response is either the original, a replay of it, or an honest
    // "still working". None is a spurious error.
    const created = responses.filter((r) => r.statusCode === 201);
    const inFlight = responses.filter((r) => r.statusCode === 409);
    expect(created.length + inFlight.length).toBe(10);
    expect(created.length).toBeGreaterThanOrEqual(1);
  });

  it('tells a concurrent retry to wait rather than racing', async () => {
    const { auth } = await brandAuth();

    const [a, b] = await Promise.all([
      createCampaign(auth, 'key-race', campaignBody()),
      createCampaign(auth, 'key-race', campaignBody()),
    ]);

    const codes = [a.statusCode, b.statusCode].sort();
    // One does the work; the other is told to come back, with a Retry-After
    // so it does not guess. Rejecting without saying when guarantees a client
    // hammers you.
    expect(codes).toEqual([201, 409]);

    const inFlight = a.statusCode === 409 ? a : b;
    expect(inFlight.json().error.code).toBe('IDEMPOTENT_REQUEST_IN_FLIGHT');
    expect(inFlight.headers['retry-after']).toBe('1');

    expect(await prisma.campaign.count()).toBe(1);
  });

  it('caches a deterministic 4xx', async () => {
    const { auth } = await brandAuth();

    const bad = { ...campaignBody(), name: 'x' };
    const first = await createCampaign(auth, 'key-bad', bad);
    expect(first.statusCode).toBeGreaterThanOrEqual(400);
    expect(first.statusCode).toBeLessThan(500);

    const second = await createCampaign(auth, 'key-bad', bad);
    // The same bad request fails the same way, so re-running validation buys
    // nothing.
    expect(second.statusCode).toBe(first.statusCode);
    expect(second.headers['idempotent-replay']).toBe('true');
  });

  it('sweeps expired keys', async () => {
    const { auth } = await brandAuth();
    await createCampaign(auth, 'key-old', campaignBody());

    await prisma.idempotencyKey.updateMany({
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const { deleted } = await cleanupIdempotencyKeys();
    expect(deleted).toBe(1);
    expect(await prisma.idempotencyKey.count()).toBe(0);
  });

  it('scopes a key to its endpoint', async () => {
    // The same key against a different operation is not a retry of this one.
    const { auth } = await brandAuth();

    await createCampaign(auth, 'shared-key', campaignBody());

    const other = await app.inject({
      method: 'POST',
      url: '/api/affiliate/payouts',
      headers: { ...auth.authHeader, 'idempotency-key': 'shared-key' },
      payload: { method: 'MANUAL' },
    });

    // Rejected for being a brand calling an affiliate endpoint -- not
    // silently served the campaign response.
    expect(other.statusCode).toBe(403);
  });
});
