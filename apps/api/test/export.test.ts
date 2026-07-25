import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { build } from '../src/server';
import { prisma } from '../src/config/prisma';
import {
  login,
  makeAdmin,
  makeAffiliate,
  makeBrand,
  makeCampaign,
  makeRelationship,
  makeTrackingLink,
} from './factories';

describe('CSV export', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await build({ rateLimit: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function scenario(campaignName = 'Spring Sale') {
    const brand = await makeBrand();
    const campaign = await prisma.campaign.update({
      where: { id: (await makeCampaign(brand.id)).id },
      data: { name: campaignName },
    });
    const affiliate = await makeAffiliate();
    await makeRelationship(brand.id, affiliate.id);
    const link = await makeTrackingLink(affiliate.id, campaign.id);

    const conversion = await prisma.conversion.create({
      data: {
        trackingLinkId: link.id,
        campaignId: campaign.id,
        affiliateId: affiliate.id,
        externalOrderId: 'order-1',
        conversionValue: '149.99',
        commissionAmount: '30.00',
        status: 'APPROVED',
        occurredAt: new Date('2026-03-04T05:06:07.000Z'),
      },
    });
    await prisma.commission.create({
      data: {
        affiliateId: affiliate.id,
        campaignId: campaign.id,
        conversionId: conversion.id,
        amount: '30.00',
        status: 'APPROVED',
      },
    });

    return {
      brand,
      campaign,
      affiliate,
      brandAuth: await login(app, brand.email),
      affiliateAuth: await login(app, affiliate.email),
    };
  }

  it('exports conversions as CSV with the right headers', async () => {
    const s = await scenario();

    const res = await app.inject({
      method: 'GET',
      url: '/api/brand/conversions/export',
      headers: s.brandAuth.authHeader,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain('conversions-');

    const lines = res.body.trim().split('\r\n');
    expect(lines[0]).toBe(
      'Order ID,Campaign,Affiliate,Affiliate email,Order value,Commission,Status,Occurred at,Reported at'
    );
    expect(lines[1]).toContain('order-1');
    expect(lines[1]).toContain('149.99');
    // ISO-8601 UTC, not a locale format.
    expect(lines[1]).toContain('2026-03-04T05:06:07.000Z');
  });

  it('escapes a campaign name containing quotes and commas', async () => {
    // The case from the story. Without escaping, every column after this one
    // shifts and the file is silently wrong.
    const s = await scenario('Bob\'s "Big", Sale');

    const res = await app.inject({
      method: 'GET',
      url: '/api/brand/conversions/export',
      headers: s.brandAuth.authHeader,
    });

    expect(res.body).toContain('"Bob\'s ""Big"", Sale"');

    // The row still has the right number of fields.
    const dataLine = res.body.trim().split('\r\n')[1]!;
    expect(countCsvFields(dataLine)).toBe(9);
  });

  it('neutralises a formula in a user-supplied value', async () => {
    // Excel, Sheets and LibreOffice execute these. Every value here is
    // user-supplied, so the export is safe on our side and dangerous on the
    // recipient's -- which is exactly why it is easy to miss.
    const s = await scenario();
    await prisma.conversion.updateMany({
      where: { campaignId: s.campaign.id },
      data: { externalOrderId: '=cmd|\'/c calc\'!A1' },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/brand/conversions/export',
      headers: s.brandAuth.authHeader,
    });

    expect(res.body).toContain("'=cmd");
    // And it does not start a field with a bare "=".
    expect(res.body).not.toMatch(/(^|,)=cmd/);
  });

  it('returns a header-only file when nothing matches', async () => {
    // Not an empty file: an empty download looks broken. A header row says
    // the query ran and matched nothing.
    const s = await scenario();

    const res = await app.inject({
      method: 'GET',
      url: '/api/brand/conversions/export?status=REJECTED',
      headers: s.brandAuth.authHeader,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.trim().split('\r\n')).toHaveLength(1);
  });

  it('filters by status and date range', async () => {
    const s = await scenario();

    const inRange = await app.inject({
      method: 'GET',
      url: '/api/brand/conversions/export?from=2026-03-01T00:00:00.000Z&to=2026-03-31T00:00:00.000Z',
      headers: s.brandAuth.authHeader,
    });
    expect(inRange.body.trim().split('\r\n')).toHaveLength(2);

    const outOfRange = await app.inject({
      method: 'GET',
      url: '/api/brand/conversions/export?from=2026-04-01T00:00:00.000Z',
      headers: s.brandAuth.authHeader,
    });
    expect(outOfRange.body.trim().split('\r\n')).toHaveLength(1);
  });

  it('never exports another brand’s conversions', async () => {
    // The export reuses the same scoping as the on-screen list. An export
    // that builds its own WHERE clause is one that eventually forgets this.
    const s = await scenario();
    const otherBrand = await makeBrand();
    const otherAuth = await login(app, otherBrand.email);

    const res = await app.inject({
      method: 'GET',
      url: '/api/brand/conversions/export',
      headers: otherAuth.authHeader,
    });

    expect(res.body.trim().split('\r\n')).toHaveLength(1);
    expect(res.body).not.toContain('order-1');
  });

  it('exports an affiliate’s own commissions only', async () => {
    const s = await scenario();
    const stranger = await makeAffiliate();
    const strangerAuth = await login(app, stranger.email);

    const mine = await app.inject({
      method: 'GET',
      url: '/api/affiliate/commissions/export',
      headers: s.affiliateAuth.authHeader,
    });
    expect(mine.body).toContain('order-1');

    const theirs = await app.inject({
      method: 'GET',
      url: '/api/affiliate/commissions/export',
      headers: strangerAuth.authHeader,
    });
    expect(theirs.body).not.toContain('order-1');
  });

  it('keeps the payout export to admins', async () => {
    const s = await scenario();
    const admin = await makeAdmin();
    const adminAuth = await login(app, admin.email);

    const allowed = await app.inject({
      method: 'GET',
      url: '/api/admin/payouts/export',
      headers: adminAuth.authHeader,
    });
    expect(allowed.statusCode).toBe(200);

    for (const auth of [s.brandAuth, s.affiliateAuth]) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/payouts/export',
        headers: auth.authHeader,
      });
      expect(res.statusCode).toBe(403);
    }
  });

  it('pages through a large export', async () => {
    // The pager uses a 500-row page. 600 rows exercises the boundary, which
    // is where an off-by-one drops or duplicates a page.
    const s = await scenario();
    const link = await prisma.trackingLink.findFirstOrThrow({
      where: { campaignId: s.campaign.id },
    });

    await prisma.conversion.createMany({
      data: Array.from({ length: 600 }, (_, i) => ({
        trackingLinkId: link.id,
        campaignId: s.campaign.id,
        affiliateId: s.affiliate.id,
        externalOrderId: `bulk-${i}`,
        conversionValue: '10.00',
        commissionAmount: '2.00',
        status: 'APPROVED' as const,
        occurredAt: new Date(),
      })),
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/brand/conversions/export',
      headers: s.brandAuth.authHeader,
    });

    // 600 bulk + 1 from the scenario + header.
    expect(res.body.trim().split('\r\n')).toHaveLength(602);
  });

  it('requires authentication', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/brand/conversions/export',
    });
    expect(res.statusCode).toBe(401);
  });
});

/** Counts fields respecting RFC 4180 quoting. */
function countCsvFields(line: string): number {
  let count = 1;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') i++;
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      count++;
    }
  }
  return count;
}
