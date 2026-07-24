import { describe, expect, it } from 'vitest';
import {
  applyToCampaignSchema,
  commissionStructureSchema,
  createCampaignSchema,
  createTrackingLinkSchema,
  listCampaignsQuerySchema,
  registerSchema,
  reportConversionSchema,
  requestPayoutSchema,
} from '../index';

describe('auth schemas', () => {
  it('accepts valid affiliate registration input', () => {
    const result = registerSchema.safeParse({
      email: 'affiliate@example.com',
      password: 'Password123!',
      firstName: 'Ada',
      lastName: 'Lovelace',
      role: 'AFFILIATE',
    });

    expect(result.success).toBe(true);
  });

  it('rejects unsupported registration roles', () => {
    expect(
      registerSchema.safeParse({
        email: 'admin@example.com',
        password: 'Password123!',
        firstName: 'Grace',
        lastName: 'Hopper',
        role: 'ADMIN',
      }).success
    ).toBe(false);
  });
});

describe('campaign schemas', () => {
  it('applies campaign defaults for omitted optional controls', () => {
    const result = createCampaignSchema.parse({
      name: 'Partner Program',
      landingPageUrl: 'https://example.com/landing',
      allowedDomains: ['example.com'],
      startDate: '2026-01-01T00:00:00.000Z',
      commissionStructure: { type: 'percentage', percentage: 20 },
    });

    expect(result.attributionModel).toBe('LAST_CLICK');
    expect(result.attributionWindowDays).toBe(30);
    expect(result.cookieLifetimeDays).toBe(30);
    expect(result.lockPeriodDays).toBe(30);
    expect(result.isOpen).toBe(true);
  });

  it('rejects non-ascending tier thresholds', () => {
    const result = commissionStructureSchema.safeParse({
      type: 'tiered_percentage',
      tiers: [
        { minSales: 10, percentage: 20 },
        { minSales: 5, percentage: 25 },
      ],
    });

    expect(result.success).toBe(false);
  });

  it('coerces pagination query strings and caps page size', () => {
    expect(listCampaignsQuerySchema.parse({ page: '2', pageSize: '50' })).toMatchObject({
      page: 2,
      pageSize: 50,
    });

    expect(listCampaignsQuerySchema.safeParse({ pageSize: '500' }).success).toBe(false);
  });
});

describe('tracking and conversion schemas', () => {
  it('rejects tracking destinations without absolute URLs', () => {
    expect(
      createTrackingLinkSchema.safeParse({
        campaignId: 'campaign-1',
        destinationUrl: '/relative-path',
      }).success
    ).toBe(false);
  });

  it('accepts max-length application messages', () => {
    expect(
      applyToCampaignSchema.safeParse({
        campaignId: 'campaign-1',
        message: 'x'.repeat(1000),
      }).success
    ).toBe(true);
  });

  it('defaults first-time customer on conversion reports', () => {
    const result = reportConversionSchema.parse({
      externalOrderId: 'order-123',
      conversionValue: 149.99,
    });

    expect(result.isFirstTimeCustomer).toBe(true);
  });
});

describe('payout schemas', () => {
  it('defaults payout requests to Stripe Connect', () => {
    expect(requestPayoutSchema.parse({}).method).toBe('stripe_connect');
  });
});
