import { Errors } from '../lib/errors';
import { readDimensions, sniffImage } from '../lib/image-sniff';
import { LocalDiskStorage, type ObjectStorage } from '../lib/storage';
import { campaignRepository } from '../repositories/campaign.repository';
import { brandAffiliateRepository } from '../repositories/brand-affiliate.repository';
import { prisma } from '../config/prisma';
import { env } from '../config/env';

/** 5 MB. Big enough for a leaderboard banner, small enough not to be a weapon. */
export const MAX_ASSET_BYTES = 5 * 1024 * 1024;

const storage: ObjectStorage = new LocalDiskStorage(env.ASSET_STORAGE_PATH);

export function creativeService(objectStorage: ObjectStorage = storage) {
  const campaigns = campaignRepository(prisma);
  const relationships = brandAffiliateRepository(prisma);

  async function assertBrandOwns(brandId: string, campaignId: string) {
    const campaign = await campaigns.findById(campaignId);
    if (!campaign) throw Errors.notFound('Campaign');
    if (campaign.brandId !== brandId) throw Errors.forbidden();
    return campaign;
  }

  /**
   * An affiliate may see a campaign's creatives only if the brand has approved
   * them. Creatives are unreleased marketing material -- a competitor should
   * not be able to enumerate a brand's next campaign by signing up.
   */
  async function assertAffiliateApproved(affiliateId: string, campaignId: string) {
    const campaign = await campaigns.findById(campaignId);
    if (!campaign) throw Errors.notFound('Campaign');
    const rel = await relationships.findByPair(campaign.brandId, affiliateId);
    if (!rel || rel.status !== 'APPROVED') throw Errors.forbidden();
    return campaign;
  }

  return {
    async upload(
      brandId: string,
      campaignId: string,
      input: { name: string; bytes: Buffer; declaredType?: string }
    ) {
      await assertBrandOwns(brandId, campaignId);

      if (input.bytes.byteLength === 0) {
        throw Errors.badRequest('File is empty');
      }
      if (input.bytes.byteLength > MAX_ASSET_BYTES) {
        throw Errors.badRequest(
          `File is larger than ${MAX_ASSET_BYTES / 1024 / 1024}MB`
        );
      }

      // Identified by content. The filename and Content-Type are the
      // uploader's claims, and a claim is not evidence.
      const sniffed = sniffImage(input.bytes);
      if (!sniffed) {
        throw Errors.badRequest(
          'Unsupported file. PNG, JPEG, GIF and WebP are accepted; SVG is not, ' +
            'because it can carry script.'
        );
      }

      const dimensions = readDimensions(input.bytes, sniffed.type);
      const stored = await objectStorage.put(input.bytes, sniffed.type);

      return prisma.creativeAsset.create({
        data: {
          campaignId,
          name: input.name,
          type: 'BANNER',
          url: stored.key,
          width: dimensions?.width ?? null,
          height: dimensions?.height ?? null,
          sizeBytes: stored.sizeBytes,
        },
      });
    },

    async listForBrand(brandId: string, campaignId: string) {
      await assertBrandOwns(brandId, campaignId);
      return prisma.creativeAsset.findMany({
        where: { campaignId },
        orderBy: { createdAt: 'desc' },
      });
    },

    async listForAffiliate(affiliateId: string, campaignId: string) {
      await assertAffiliateApproved(affiliateId, campaignId);
      return prisma.creativeAsset.findMany({
        where: { campaignId },
        orderBy: { createdAt: 'desc' },
      });
    },

    /**
     * Streams the bytes, after checking the caller may have them.
     *
     * Assets are served through the API rather than from a public directory
     * precisely so this check exists. A public folder has no idea who is
     * asking.
     */
    async download(
      caller: { id: string; role: 'BRAND' | 'AFFILIATE' | 'ADMIN' },
      assetId: string
    ) {
      const asset = await prisma.creativeAsset.findUnique({ where: { id: assetId } });
      if (!asset) throw Errors.notFound('Asset');

      if (caller.role === 'BRAND') {
        await assertBrandOwns(caller.id, asset.campaignId);
      } else if (caller.role === 'AFFILIATE') {
        await assertAffiliateApproved(caller.id, asset.campaignId);
      }

      const bytes = await objectStorage.get(asset.url);
      return { asset, bytes };
    },

    async remove(brandId: string, assetId: string) {
      const asset = await prisma.creativeAsset.findUnique({ where: { id: assetId } });
      if (!asset) throw Errors.notFound('Asset');
      await assertBrandOwns(brandId, asset.campaignId);

      // Row first, then bytes. If the delete fails halfway, an orphaned file
      // wastes disk; an orphaned row would render as a broken image on every
      // affiliate's site, which is worse.
      await prisma.creativeAsset.delete({ where: { id: assetId } });
      await objectStorage.delete(asset.url).catch(() => {
        // Already gone, or storage is unavailable. The row is what the app
        // reads, and it is gone.
      });

      return { id: assetId };
    },
  };
}
