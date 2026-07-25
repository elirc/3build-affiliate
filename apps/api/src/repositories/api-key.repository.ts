import type { DB } from '../config/prisma';

export function apiKeyRepository(db: DB) {
  return {
    create: (data: {
      campaignId: string;
      keyId: string;
      secretEncrypted: string;
      label: string;
    }) => db.campaignApiKey.create({ data }),

    /**
     * Looks a key up for authentication. Includes the campaign's brand so the
     * caller can check the key belongs to the campaign being posted to
     * without a second query.
     */
    findByKeyId: (keyId: string) =>
      db.campaignApiKey.findUnique({
        where: { keyId },
        include: { campaign: { select: { id: true, brandId: true, status: true } } },
      }),

    /**
     * Never selects `secretEncrypted`. A list endpoint has no use for it, and
     * a field that is not selected cannot be accidentally serialised.
     */
    listForCampaign: (campaignId: string) =>
      db.campaignApiKey.findMany({
        where: { campaignId },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          keyId: true,
          label: true,
          lastUsedAt: true,
          revokedAt: true,
          createdAt: true,
        },
      }),

    findById: (id: string) => db.campaignApiKey.findUnique({ where: { id } }),

    revoke: (id: string) =>
      db.campaignApiKey.update({ where: { id }, data: { revokedAt: new Date() } }),

    /**
     * Fire-and-forget: a failed touch must never fail the postback it was
     * recording. Worst case the "last used" column is slightly stale.
     */
    touchLastUsed: (id: string) =>
      db.campaignApiKey.update({ where: { id }, data: { lastUsedAt: new Date() } }),
  };
}
