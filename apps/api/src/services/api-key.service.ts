import { Errors } from '../lib/errors';
import { generateApiKeyPair } from '../lib/postback-signature';
import { openSecret, sealSecret } from '../lib/secret-box';
import { apiKeyRepository } from '../repositories/api-key.repository';
import { campaignRepository } from '../repositories/campaign.repository';
import { prisma } from '../config/prisma';
import { env } from '../config/env';
import { logger } from '../lib/logger';

export function apiKeyService() {
  const keys = apiKeyRepository(prisma);
  const campaigns = campaignRepository(prisma);

  async function assertOwnsCampaign(brandId: string, campaignId: string) {
    const campaign = await campaigns.findById(campaignId);
    if (!campaign) throw Errors.notFound('Campaign');
    if (campaign.brandId !== brandId) throw Errors.forbidden();
    return campaign;
  }

  return {
    /**
     * Issues a key. The plaintext secret is returned here and never again --
     * the brand must store it themselves. We *can* technically decrypt it,
     * but not exposing a "show me the secret" endpoint means a stolen session
     * cannot exfiltrate existing integrations' credentials.
     */
    async create(brandId: string, campaignId: string, label: string) {
      await assertOwnsCampaign(brandId, campaignId);

      const { keyId, secret } = generateApiKeyPair();
      const record = await keys.create({
        campaignId,
        keyId,
        secretEncrypted: sealSecret(secret, env.POSTBACK_ENCRYPTION_KEY),
        label,
      });

      return {
        id: record.id,
        keyId: record.keyId,
        label: record.label,
        createdAt: record.createdAt,
        secret,
      };
    },

    async list(brandId: string, campaignId: string) {
      await assertOwnsCampaign(brandId, campaignId);
      return keys.listForCampaign(campaignId);
    },

    async revoke(brandId: string, campaignId: string, keyRecordId: string) {
      await assertOwnsCampaign(brandId, campaignId);

      const key = await keys.findById(keyRecordId);
      if (!key) throw Errors.notFound('API key');
      // Belt and braces: the key must belong to the campaign named in the
      // path, not merely to some campaign this brand owns.
      if (key.campaignId !== campaignId) throw Errors.forbidden();
      if (key.revokedAt) throw Errors.conflict('Key is already revoked');

      return keys.revoke(keyRecordId);
    },

    /**
     * Loads the signing secret for a postback.
     *
     * Returns null for every failure rather than something descriptive: the
     * caller turns all of them into one indistinguishable 401. An
     * unauthenticated caller must not learn whether a campaign exists,
     * whether a key id is real, or which of the two was wrong.
     */
    async resolveSigningSecret(keyId: string, campaignId: string) {
      const key = await keys.findByKeyId(keyId);
      if (!key) return null;
      if (key.revokedAt) return null;
      if (key.campaignId !== campaignId) return null;

      try {
        return {
          id: key.id,
          secret: openSecret(key.secretEncrypted, env.POSTBACK_ENCRYPTION_KEY),
        };
      } catch (err) {
        // Wrong encryption key, or a tampered row. Either way we cannot
        // authenticate anyone, and this is an operator problem rather than a
        // caller problem -- log loudly, reject quietly.
        logger.error({ err, keyId }, 'Failed to decrypt campaign API key secret');
        return null;
      }
    },

    async touch(id: string) {
      try {
        await keys.touchLastUsed(id);
      } catch (err) {
        // Recording that a key was used must never fail the conversion that
        // used it.
        logger.warn({ err, id }, 'Failed to update API key lastUsedAt');
      }
    },
  };
}
