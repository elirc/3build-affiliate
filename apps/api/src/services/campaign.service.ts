import { Errors } from '../lib/errors';
import type { CreateCampaignInput, UpdateCampaignInput, ListCampaignsQuery } from '@affiliate/shared';
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

  return {
    async create(brandId: string, input: CreateCampaignInput) {
      return repo.create({
        brandId,
        name: input.name,
        description: input.description ?? null,
        slug: toSlug(input.name),
        landingPageUrl: input.landingPageUrl,
        allowedDomains: input.allowedDomains,
        commissionStructure: input.commissionStructure as any,
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
      const existing = await repo.findById(id);
      if (!existing) throw Errors.notFound('Campaign');
      if (existing.brandId !== brandId) throw Errors.forbidden();
      return repo.update(id, {
        ...input,
        commissionStructure: input.commissionStructure as any,
        startDate: input.startDate ? new Date(input.startDate) : undefined,
        endDate: input.endDate ? new Date(input.endDate) : undefined,
      });
    },

    async getById(brandId: string, id: string) {
      const c = await repo.findById(id);
      if (!c) throw Errors.notFound('Campaign');
      if (c.brandId !== brandId) throw Errors.forbidden();
      return c;
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
