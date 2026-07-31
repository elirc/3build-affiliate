import type { DB } from '../config/prisma';
import type { Prisma } from '@prisma/client';

export interface ImportCounts {
  totalRows: number;
  importedRows: number;
  skippedRows: number;
  failedRows: number;
}

export interface ImportRowError {
  line: number;
  column: string | null;
  message: string;
}

/**
 * Queries for the bulk import.
 *
 * The batch lookups at the bottom belong here rather than with the tracking
 * link or relationship repositories because their shape is the point: they
 * take a *set* of keys and return a map. Called one row at a time they would
 * be the same N+1 the import exists to avoid, and putting them next to the
 * job queries keeps that visible.
 */
export function importJobRepository(db: DB) {
  return {
    create: (data: Prisma.ImportJobUncheckedCreateInput) =>
      db.importJob.create({ data }),

    findById: (id: string) => db.importJob.findUnique({ where: { id } }),

    findForBrand: (id: string, brandId: string) =>
      db.importJob.findFirst({ where: { id, campaign: { brandId } } }),

    /** Oldest waiting job. FIFO, so a big import cannot starve a small one. */
    findNextPending: () =>
      db.importJob.findFirst({
        where: { status: 'PENDING' },
        orderBy: { createdAt: 'asc' },
      }),

    /**
     * Moves a job PENDING -> PROCESSING, and says whether it was this caller
     * who moved it.
     *
     * Conditional on the current status rather than a blind update by id: a
     * job id can reach a worker twice (a retry, a redelivery, an operator
     * replaying the queue) and the second one must not re-import the file.
     */
    claim: async (id: string) => {
      const { count } = await db.importJob.updateMany({
        where: { id, status: 'PENDING' },
        data: { status: 'PROCESSING', startedAt: new Date() },
      });
      return count === 1;
    },

    updateCounts: (id: string, counts: ImportCounts) =>
      db.importJob.update({ where: { id }, data: counts }),

    complete: (id: string, counts: ImportCounts) =>
      db.importJob.update({
        where: { id },
        data: { ...counts, status: 'COMPLETED', finishedAt: new Date() },
      }),

    fail: (id: string, errorMessage: string, counts: ImportCounts) =>
      db.importJob.update({
        where: { id },
        data: { ...counts, status: 'FAILED', errorMessage, finishedAt: new Date() },
      }),

    /** Records that the spooled file is gone, so a leak is visible as a set path. */
    clearSourcePath: (id: string) =>
      db.importJob.update({ where: { id }, data: { sourcePath: null } }),

    addErrors: (jobId: string, errors: ImportRowError[]) =>
      db.importJobError.createMany({
        data: errors.map((e) => ({ jobId, ...e })),
      }),

    countErrors: (jobId: string) => db.importJobError.count({ where: { jobId } }),

    listErrors: (jobId: string, opts: { skip: number; take: number }) =>
      db.importJobError.findMany({
        where: { jobId },
        // By line, so the report reads in the order of the file it describes.
        orderBy: { line: 'asc' },
        skip: opts.skip,
        take: opts.take,
        select: { line: true, column: true, message: true },
      }),

    /**
     * The one write that matters.
     *
     * `skipDuplicates` is what makes re-uploading a file free: the unique
     * constraint on (campaignId, externalOrderId) already refuses a second
     * copy of a row, and without this the whole statement would fail on the
     * first one instead of importing whatever is genuinely new.
     */
    insertConversions: (rows: Prisma.ConversionCreateManyInput[]) =>
      db.conversion.createMany({ data: rows, skipDuplicates: true }),

    /** Resolves a batch's tracking codes in one query. */
    findTrackingLinksByCode: (campaignId: string, codes: string[]) =>
      db.trackingLink.findMany({
        where: { campaignId, shortCode: { in: codes } },
        select: { id: true, shortCode: true, affiliateId: true },
      }),

    /** Per-affiliate override rates for a batch, in one query. */
    findRelationships: (brandId: string, affiliateIds: string[]) =>
      db.brandAffiliate.findMany({
        where: { brandId, affiliateId: { in: affiliateIds } },
        select: { affiliateId: true, status: true, customCommission: true },
      }),

    /**
     * Approved sales per affiliate, which tiered commission rates depend on.
     *
     * Stable for the whole job: imported rows land PENDING, so nothing this
     * import writes can change the count it is reading.
     */
    countApprovedByAffiliate: (campaignId: string, affiliateIds: string[]) =>
      db.conversion.groupBy({
        by: ['affiliateId'],
        where: { campaignId, affiliateId: { in: affiliateIds }, status: 'APPROVED' },
        _count: { _all: true },
      }),
  };
}
