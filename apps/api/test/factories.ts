import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { prisma } from '../src/config/prisma';
import { hashPassword } from '../src/lib/hash';
import { sealSecret } from '../src/lib/secret-box';
import { signPostback } from '../src/lib/postback-signature';
import { env } from '../src/config/env';
import type { CampaignStatus, CommissionStructure } from '@affiliate/shared';

/**
 * Builders for test data.
 *
 * Every factory takes an overrides object and fills in something valid for
 * everything else. A test should mention only the fields it is actually about
 * -- `makeCampaign({ lockPeriodDays: 0 })` says "this test is about the lock
 * period" far more clearly than thirty lines of setup in which one value
 * differs.
 */

export const TEST_PASSWORD = 'Password123!';

/** argon2 is slow by design, so hash once and reuse across the suite. */
let cachedHash: string | null = null;
async function passwordHash() {
  if (!cachedHash) cachedHash = await hashPassword(TEST_PASSWORD);
  return cachedHash;
}

let counter = 0;
const uniq = () => `${Date.now().toString(36)}-${counter++}`;

export async function makeBrand(overrides: { email?: string; companyName?: string } = {}) {
  return prisma.user.create({
    data: {
      email: overrides.email ?? `brand-${uniq()}@example.com`,
      passwordHash: await passwordHash(),
      firstName: 'Brand',
      lastName: 'Owner',
      role: 'BRAND',
      companyName: overrides.companyName ?? 'Acme Inc.',
      emailVerified: true,
    },
  });
}

export async function makeAffiliate(
  overrides: { email?: string; payoutDetails?: boolean } = {}
) {
  // Payout details are set by default because a payable affiliate is the
  // ordinary case, and `requestPayout` refuses a method with none on file.
  // Without this, every test that happens to request a payout would have to
  // configure settings first, which buries what the test is actually about.
  //
  // Pass `payoutDetails: false` to build the unpayable case deliberately.
  const payable = overrides.payoutDetails ?? true;

  return prisma.user.create({
    data: {
      email: overrides.email ?? `affiliate-${uniq()}@example.com`,
      passwordHash: await passwordHash(),
      firstName: 'Affie',
      lastName: 'Liat',
      role: 'AFFILIATE',
      emailVerified: true,
      ...(payable
        ? {
            payoutMethod: 'MANUAL' as const,
            manualPayoutDetails: 'Test bank reference',
          }
        : {}),
    },
  });
}

export async function makeAdmin(overrides: { email?: string } = {}) {
  return prisma.user.create({
    data: {
      email: overrides.email ?? `admin-${uniq()}@example.com`,
      passwordHash: await passwordHash(),
      firstName: 'Ada',
      lastName: 'Min',
      role: 'ADMIN',
      emailVerified: true,
    },
  });
}

export async function makeCampaign(
  brandId: string,
  overrides: Partial<{
    status: CampaignStatus;
    commissionStructure: CommissionStructure;
    attributionModel: 'FIRST_CLICK' | 'LAST_CLICK' | 'LINEAR';
    attributionWindowDays: number;
    lockPeriodDays: number;
    isOpen: boolean;
    endDate: Date | null;
    allowedDomains: string[];
  }> = {}
) {
  return prisma.campaign.create({
    data: {
      brandId,
      name: `Campaign ${uniq()}`,
      slug: `campaign-${uniq()}`,
      landingPageUrl: 'https://acme.example.com',
      allowedDomains: overrides.allowedDomains ?? ['acme.example.com'],
      // ACTIVE by default: most tests are about something downstream of a
      // working campaign, and making each one activate first would bury the
      // interesting line.
      status: overrides.status ?? 'ACTIVE',
      commissionStructure: (overrides.commissionStructure ?? {
        type: 'percentage',
        percentage: 20,
      }) as object,
      attributionModel: overrides.attributionModel ?? 'LAST_CLICK',
      attributionWindowDays: overrides.attributionWindowDays ?? 30,
      cookieLifetimeDays: 30,
      lockPeriodDays: overrides.lockPeriodDays ?? 30,
      isOpen: overrides.isOpen ?? true,
      startDate: new Date(),
      endDate: overrides.endDate ?? null,
    },
  });
}

export async function makeRelationship(
  brandId: string,
  affiliateId: string,
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'DEACTIVATED' = 'APPROVED'
) {
  return prisma.brandAffiliate.create({
    data: {
      brandId,
      affiliateId,
      status,
      ...(status === 'APPROVED' ? { approvedAt: new Date() } : {}),
    },
  });
}

export async function makeTrackingLink(
  affiliateId: string,
  campaignId: string,
  overrides: Partial<{ shortCode: string; isActive: boolean }> = {}
) {
  return prisma.trackingLink.create({
    data: {
      affiliateId,
      campaignId,
      shortCode: overrides.shortCode ?? `sc${uniq().replace(/-/g, '')}`.slice(0, 12),
      destinationUrl: 'https://acme.example.com/pricing',
      isActive: overrides.isActive ?? true,
    },
  });
}

export async function makeClickEvent(
  trackingLinkId: string,
  overrides: Partial<{ cookieId: string; timestamp: Date }> = {}
) {
  return prisma.clickEvent.create({
    data: {
      trackingLinkId,
      timestamp: overrides.timestamp ?? new Date(),
      ipHash: 'test-ip-hash',
      userAgent: 'Mozilla/5.0 (test)',
      attributionCookieId: overrides.cookieId ?? crypto.randomUUID(),
    },
  });
}

/** A campaign API key plus the plaintext secret, for signing postbacks. */
export async function makeApiKey(campaignId: string) {
  const keyId = `ak_${crypto.randomBytes(12).toString('hex')}`;
  const secret = `sk_${crypto.randomBytes(32).toString('hex')}`;
  const record = await prisma.campaignApiKey.create({
    data: {
      campaignId,
      keyId,
      secretEncrypted: sealSecret(secret, env.POSTBACK_ENCRYPTION_KEY),
      label: 'test',
    },
  });
  return { record, keyId, secret };
}

/** Builds the three headers a signed postback needs. */
export function postbackHeaders(keyId: string, secret: string, rawBody: string) {
  const timestamp = String(Date.now());
  return {
    'content-type': 'application/json',
    'x-affiliate-key': keyId,
    'x-affiliate-timestamp': timestamp,
    'x-affiliate-signature': signPostback(secret, timestamp, rawBody),
  };
}

/**
 * Logs in through the real auth route rather than minting a token directly.
 *
 * Slower, but a token produced by hand can drift from what the app actually
 * issues -- and if login breaks, every test that depends on it should fail
 * rather than carrying on with a fabricated credential.
 */
export async function login(app: FastifyInstance, email: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: TEST_PASSWORD },
  });
  if (res.statusCode !== 200) {
    throw new Error(`Login failed for ${email}: ${res.statusCode} ${res.body}`);
  }
  const { accessToken } = res.json() as { accessToken: string };
  return { accessToken, authHeader: { authorization: `Bearer ${accessToken}` } };
}
