import { allowedTransitions, canTransition, lockedFieldsIn } from '@affiliate/analytics';
import { Errors } from '../lib/errors';
import type {
  CampaignStatus,
  CreateCampaignInput,
  ListCampaignsQuery,
  UpdateCampaignInput,
} from '@affiliate/shared';
import { campaignRepository } from '../repositories/campaign.repository';
import { prisma } from '../config/prisma';

function toSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) +
    '-' +
    Math.random().toString(36).slice(2, 8)
  );
}

export function campaignService() {
  const repo = campaignRepository(prisma);

  async function loadOwned(brandId: string, id: string) {
    const campaign = await repo.findById(id);
    if (!campaign) throw Errors.notFound('Campaign');
    if (campaign.brandId !== brandId) throw Errors.forbidden();
    return campaign;
  }

  return {
    async create(brandId: string, input: CreateCampaignInput) {
      return repo.create({
        brandId,
        name: input.name,
        description: input.description ?? null,
        slug: toSlug(input.name),
        landingPageUrl: input.landingPageUrl,
        allowedDomains: input.allowedDomains,
        commissionStructure: input.commissionStructure,
        attributionModel: input.attributionModel,
        attributionWindowDays: input.attributionWindowDays,
        cookieLifetimeDays: input.cookieLifetimeDays,
        lockPeriodDays: input.lockPeriodDays,
        isOpen: input.isOpen,
        startDate: new Date(input.startDate),
        endDate: input.endDate ? new Date(input.endDate) : null,
      });
    },

    async update(brandId: string, id: string, input: UpdateCampaignInput) {
      const existing = await loadOwned(brandId, id);

      // Commercial terms freeze at activation. Affiliates joined on the terms
      // that were published; changing them afterwards rewrites a deal they
      // already accepted. A brand who wants different terms launches a
      // different campaign.
      if (existing.status !== 'DRAFT') {
        const locked = lockedFieldsIn(input);
        if (locked.length > 0) {
          throw Errors.forbidden(
            `Cannot change ${locked.join(', ')} after a campaign has been activated. ` +
              `Create a new campaign instead.`
          );
        }
      }

      return repo.update(id, {
        ...input,
        commissionStructure: input.commissionStructure,
        startDate: input.startDate ? new Date(input.startDate) : undefined,
        endDate: input.endDate ? new Date(input.endDate) : undefined,
      });
    },

    /**
     * The only way a campaign's status changes.
     *
     * Keeping this separate from `update` means the transition rules live in
     * exactly one place. A PATCH that could also set status would be a second
     * door into the state machine, and the second door is always the one that
     * is left unlocked.
     */
    async transition(brandId: string, id: string, to: CampaignStatus) {
      const campaign = await loadOwned(brandId, id);
      const from = campaign.status;

      if (!canTransition(from, to)) {
        throw Errors.invalidRequest(
          'INVALID_TRANSITION',
          `Cannot move a campaign from ${from} to ${to}`,
          { from, to, allowed: allowedTransitions(from) }
        );
      }

      if (to === 'ACTIVE') {
        // Activating something already finished would publish a campaign that
        // is over, and affiliates would build links that can never convert.
        if (campaign.endDate && campaign.endDate.getTime() <= Date.now()) {
          throw Errors.badRequest(
            'Cannot activate a campaign whose end date has already passed'
          );
        }
      }

      return repo.update(id, { status: to });
    },

    async getById(brandId: string, id: string) {
      return loadOwned(brandId, id);
    },

    async listForBrand(brandId: string, query: ListCampaignsQuery) {
      const skip = (query.page - 1) * query.pageSize;
      const [items, total] = await Promise.all([
        repo.listByBrand(brandId, {
          status: query.status,
          search: query.search,
          skip,
          take: query.pageSize,
        }),
        repo.countByBrand(brandId, { status: query.status, search: query.search }),
      ]);
      return { items, total, page: query.page, pageSize: query.pageSize };
    },

    async listOpenPrograms(page: number, pageSize: number) {
      const skip = (page - 1) * pageSize;
      return repo.listOpenForAffiliates({ skip, take: pageSize });
    },
  };
}
