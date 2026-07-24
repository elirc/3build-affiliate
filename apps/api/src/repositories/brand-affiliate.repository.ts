import type { DB } from '../config/prisma';

export function brandAffiliateRepository(db: DB) {
  return {
    findByPair: (brandId: string, affiliateId: string) =>
      db.brandAffiliate.findUnique({
        where: { brandId_affiliateId: { brandId, affiliateId } },
      }),

    apply: (brandId: string, affiliateId: string, message?: string) =>
      db.brandAffiliate.create({
        data: { brandId, affiliateId, applicationMessage: message ?? null },
      }),

    listForBrand: (brandId: string, status?: string) =>
      db.brandAffiliate.findMany({
        where: { brandId, ...(status ? { status: status as any } : {}) },
        orderBy: { appliedAt: 'desc' },
        include: {
          affiliate: {
            select: {
              id: true,
              email: true,
              firstName: true,
              lastName: true,
              bio: true,
              socialLinks: true,
            },
          },
        },
      }),

    listForAffiliate: (affiliateId: string) =>
      db.brandAffiliate.findMany({
        where: { affiliateId },
        orderBy: { appliedAt: 'desc' },
        include: {
          brand: {
            select: { id: true, companyName: true, companyUrl: true, companyLogo: true },
          },
        },
      }),

    setStatus: (
      id: string,
      status: 'APPROVED' | 'REJECTED' | 'DEACTIVATED'
    ) =>
      db.brandAffiliate.update({
        where: { id },
        data: {
          status,
          ...(status === 'APPROVED' ? { approvedAt: new Date() } : {}),
          ...(status === 'REJECTED' ? { rejectedAt: new Date() } : {}),
          ...(status === 'DEACTIVATED' ? { deactivatedAt: new Date() } : {}),
        },
      }),

    findById: (id: string) => db.brandAffiliate.findUnique({ where: { id } }),
  };
}
