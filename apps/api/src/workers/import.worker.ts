import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import { Prisma } from '@prisma/client';
import {
  CsvStreamParser,
  bisectCommit,
  calculateCommission,
  csvHeader,
  missingColumns,
  normaliseSubIds,
  resolveCommissionStructure,
  selectColumns,
  type CsvHeader,
  type CsvRecord,
} from '@affiliate/analytics';
import {
  IMPORT_COLUMNS,
  IMPORT_REQUIRED_COLUMNS,
  commissionStructureSchema,
  csvRowToImportInput,
  importRowSchema,
  type CommissionStructure,
  type ImportRowInput,
} from '@affiliate/shared';
import { prisma } from '../config/prisma';
import { logger } from '../lib/logger';
import { beat } from '../lib/heartbeat';
import { AppError, Errors } from '../lib/errors';
import { hashEmail } from '../lib/hash';
import { MAX_ROW_ERRORS } from '../services/import.service';
import {
  importJobRepository,
  type ImportCounts,
  type ImportRowError,
} from '../repositories/import-job.repository';
import { campaignRepository } from '../repositories/campaign.repository';

/**
 * Imports an uploaded CSV of historical conversions.
 *
 * Three properties drive every decision in this file.
 *
 * **Bounded memory.** The file is read a chunk at a time, parsed
 * incrementally, and held only as far as the current batch of 500 rows. Peak
 * memory is the same for a 2KB file and a 100MB one. Backpressure falls out of
 * `for await ... of` over the read stream: awaiting a database write inside
 * the loop pauses the stream, so a slow database throttles the reader rather
 * than filling the heap with rows waiting for it.
 *
 * **Partial failure.** 50,000 rows with 12 bad ones must import 49,988. A row
 * that fails validation is recorded and skipped; a *batch* that fails in the
 * database is bisected (`bisectCommit`) so one poison row costs one row rather
 * than 500.
 *
 * **Idempotency, at row granularity.** Re-uploading a file imports nothing:
 * `createMany({ skipDuplicates: true })` leans on the unique constraint that
 * already exists on (campaignId, externalOrderId). The brand fixes twelve rows
 * and re-uploads all fifty thousand, which is what they will actually do.
 *
 * Deliberately not under a scheduler lease: a job is claimed with a
 * conditional PENDING -> PROCESSING update, so two instances polling the same
 * table cannot both get it, and N workers simply drain the queue N times
 * faster. A lease would make the extra instances idle.
 *
 * One real constraint: the API spools the upload to local disk, so a worker on
 * a different host cannot read it. That is the same limitation
 * `LocalDiskStorage` already has for creatives, and the same fix -- object
 * storage behind the existing interface -- resolves both.
 */

export const WORKER_NAME = 'conversion-import';
const TICK_MS = 1_000;

/** Rows per `createMany`. Large enough to amortise the round trip. */
export const BATCH_SIZE = 500;

/** How often the job row is updated while a long file is being read. */
const PROGRESS_EVERY_ROWS = 5_000;

export interface ImportOutcome extends ImportCounts {
  jobId: string;
  status: 'COMPLETED' | 'FAILED';
  errorMessage?: string;
}

/**
 * customCommission is a JSON column, so its contents are not guaranteed by the
 * database. Same guard the conversion service uses, for the same reason: a bad
 * row degrades to the campaign default rather than throwing mid-import.
 */
function isCommissionStructure(value: unknown): value is CommissionStructure {
  return commissionStructureSchema.safeParse(value).success;
}

/**
 * Claims and runs the oldest waiting job, if there is one.
 *
 * Exported so a test can run exactly one job and assert the result, rather
 * than starting an interval and sleeping long enough to hope one fired.
 */
export async function runNextImportJob(): Promise<ImportOutcome | null> {
  const jobs = importJobRepository(prisma);

  const next = await jobs.findNextPending();
  if (!next) return null;

  // Conditional claim, not an update by id: the check and the action that
  // depends on it have to be one statement, or two workers both read PENDING
  // and both import the file.
  if (!(await jobs.claim(next.id))) return null;

  return processClaimedJob(next);
}

async function processClaimedJob(job: {
  id: string;
  campaignId: string;
  sourcePath: string | null;
}): Promise<ImportOutcome> {
  const jobs = importJobRepository(prisma);
  const counts: ImportCounts = {
    totalRows: 0,
    importedRows: 0,
    skippedRows: 0,
    failedRows: 0,
  };

  try {
    await importFile(job, counts);
    await jobs.complete(job.id, counts);
    logger.info({ jobId: job.id, campaignId: job.campaignId, ...counts }, 'Conversion import finished');
    return { jobId: job.id, status: 'COMPLETED', ...counts };
  } catch (err) {
    // An AppError here is a message written for the brand -- a missing column,
    // an unreadable file. Anything else is ours, and is not shown verbatim.
    const errorMessage =
      err instanceof AppError ? err.message : 'The file could not be imported';

    logger.error(
      { err, jobId: job.id, campaignId: job.campaignId, ...counts },
      'Conversion import failed'
    );
    await jobs.fail(job.id, errorMessage, counts);
    return { jobId: job.id, status: 'FAILED', errorMessage, ...counts };
  } finally {
    // Success or failure, the upload goes. A 100MB file left behind by every
    // failed import fills a disk quietly, and the first symptom is unrelated
    // writes failing somewhere else entirely.
    if (job.sourcePath) {
      await fs.rm(job.sourcePath, { force: true }).catch((err) => {
        logger.error(
          { err, jobId: job.id, sourcePath: job.sourcePath },
          'Could not delete a spooled import file; it will need removing by hand'
        );
      });
      await jobs.clearSourcePath(job.id).catch(() => {
        // The file is gone; the column saying where it was is now only a
        // record. Not worth failing a finished job over.
      });
    }
  }
}

async function importFile(
  job: { id: string; campaignId: string; sourcePath: string | null },
  counts: ImportCounts
): Promise<void> {
  if (!job.sourcePath) {
    throw Errors.unprocessable('The uploaded file is no longer available');
  }

  const jobs = importJobRepository(prisma);
  const campaign = await campaignRepository(prisma).findById(job.campaignId);
  if (!campaign) throw Errors.notFound('Campaign');

  const { brandId } = campaign;
  const campaignStructure = campaign.commissionStructure as unknown as CommissionStructure;

  const parser = new CsvStreamParser();
  let header: CsvHeader | null = null;
  let batch: { line: number; input: ImportRowInput }[] = [];
  /** Errors waiting to be written, never more than one batch plus the cap. */
  let pendingErrors: ImportRowError[] = [];
  let storedErrors = 0;
  let progressAt = 0;

  function recordError(line: number, column: string | null, message: string) {
    counts.failedRows += 1;
    // Counted always, stored up to a limit. A 50,000-row file where every row
    // is invalid is one problem, not fifty thousand, and writing a row per
    // failure would turn a bad upload into a second bad upload.
    if (storedErrors + pendingErrors.length >= MAX_ROW_ERRORS) return;
    pendingErrors.push({ line, column, message: message.slice(0, 500) });
  }

  async function persistErrors() {
    if (pendingErrors.length === 0) return;
    const writing = pendingErrors;
    pendingErrors = [];
    await jobs.addErrors(job.id, writing);
    storedErrors += writing.length;
  }

  async function flush() {
    if (batch.length === 0) {
      await persistErrors();
      return;
    }

    const rows = batch;
    batch = [];

    // Everything the batch needs, resolved a batch at a time. One query per
    // 500 rows instead of one per row -- the difference between 400 queries
    // and 200,000 on a 100k-row file.
    const codes = [...new Set(rows.map((r) => r.input.trackingCode))];
    const links = await jobs.findTrackingLinksByCode(job.campaignId, codes);
    const linkByCode = new Map(links.map((l) => [l.shortCode, l]));

    const affiliateIds = [...new Set(links.map((l) => l.affiliateId))];
    const [relationships, priorSales] = await Promise.all([
      jobs.findRelationships(brandId, affiliateIds),
      jobs.countApprovedByAffiliate(job.campaignId, affiliateIds),
    ]);
    const relationshipByAffiliate = new Map(relationships.map((r) => [r.affiliateId, r]));
    const priorByAffiliate = new Map(
      priorSales.map((p) => [p.affiliateId, p._count._all])
    );

    const prepared: { line: number; row: Prisma.ConversionCreateManyInput }[] = [];
    for (const { line, input } of rows) {
      const link = linkByCode.get(input.trackingCode);
      if (!link) {
        recordError(
          line,
          'trackingCode',
          `No tracking link with code "${input.trackingCode}" on this campaign`
        );
        continue;
      }

      const { structure } = resolveCommissionStructure(
        campaignStructure,
        relationshipByAffiliate.get(link.affiliateId),
        isCommissionStructure
      );
      const commission = calculateCommission(
        structure,
        input.conversionValue,
        priorByAffiliate.get(link.affiliateId) ?? 0
      );

      const subIds = input.subIds ? normaliseSubIds(input.subIds).subIds : {};

      prepared.push({
        line,
        row: {
          trackingLinkId: link.id,
          campaignId: job.campaignId,
          affiliateId: link.affiliateId,
          // Historical data has no click event to point at. That is not a
          // missing value to be filled in later -- it is the defining fact
          // about an imported row, and `source` records it.
          clickEventId: null,
          source: 'IMPORT',
          externalOrderId: input.externalOrderId,
          conversionValue: input.conversionValue.toFixed(2),
          commissionAmount: commission.toFixed(2),
          status: 'PENDING',
          customerEmailHash: input.customerEmail ? hashEmail(input.customerEmail) : null,
          isFirstTimeCustomer: input.isFirstTimeCustomer,
          occurredAt: new Date(input.occurredAt),
          subIds:
            Object.keys(subIds).length > 0
              ? (subIds as Prisma.InputJsonValue)
              : Prisma.DbNull,
        },
      });
    }

    let inserted = 0;
    // `createMany` is one statement, so it is all-or-nothing for the slice it
    // is given -- which is exactly what bisection requires. A slice that
    // partially applied would double-write when its halves were retried.
    const outcome = await bisectCommit(prepared, async (slice) => {
      const result = await jobs.insertConversions(slice.map((p) => p.row));
      inserted += result.count;
    });

    for (const failure of outcome.failed) {
      recordError(failure.item.line, null, String(failure.error));
    }

    if (outcome.attempts > 1) {
      logger.warn(
        {
          jobId: job.id,
          attempts: outcome.attempts,
          committed: outcome.succeeded.length,
          failed: outcome.failed.length,
        },
        'Import batch bisected to isolate failing rows'
      );
    }

    counts.importedRows += inserted;
    // Everything the database accepted but did not write is a row that was
    // already here. That is the whole re-upload story: nothing new, nothing
    // lost, and a count the brand can check.
    counts.skippedRows += outcome.succeeded.length - inserted;

    await jobs.updateCounts(job.id, counts);
    await persistErrors();
  }

  async function handle(record: CsvRecord) {
    if (header === null) {
      header = csvHeader(record.values);
      const missing = missingColumns(header, IMPORT_REQUIRED_COLUMNS);
      if (missing.length > 0) {
        // A missing *column* is a malformed file, not a bad row. Reporting it
        // 50,000 times as a per-row error would bury the one sentence that
        // tells the brand what to do.
        throw Errors.unprocessable(
          `Missing required column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. ` +
            `Required: ${IMPORT_REQUIRED_COLUMNS.join(', ')}.`
        );
      }
      return;
    }

    counts.totalRows += 1;

    const cells = selectColumns(header, record, IMPORT_COLUMNS);
    if (!cells) {
      recordError(
        record.line,
        null,
        `Expected ${header.width} columns, found ${record.values.length}. ` +
          'A value containing a comma must be quoted.'
      );
    } else {
      // The postback endpoint's schema, applied to a row of a file. One schema,
      // two entry points: a second copy would drift the first time either
      // side's rules changed.
      const parsed = importRowSchema.safeParse(csvRowToImportInput(cells));
      if (parsed.success) {
        batch.push({ line: record.line, input: parsed.data });
      } else {
        const issue = parsed.error.issues[0]!;
        recordError(record.line, issue.path[0] ? String(issue.path[0]) : null, issue.message);
      }
    }

    if (batch.length >= BATCH_SIZE) await flush();

    // Progress for a file that is failing every row, which would otherwise
    // show nothing at all until it finished.
    if (counts.totalRows - progressAt >= PROGRESS_EVERY_ROWS) {
      progressAt = counts.totalRows;
      await jobs.updateCounts(job.id, counts);
      await persistErrors();
    }
  }

  const stream = createReadStream(job.sourcePath, {
    encoding: 'utf8',
    highWaterMark: 64 * 1024,
  });

  try {
    // Awaiting inside this loop is what applies backpressure: the stream is
    // paused while a batch is written, so a database slower than the disk
    // slows the read down instead of queueing rows in memory.
    for await (const chunk of stream) {
      for (const record of parser.push(chunk as string)) {
        await handle(record);
      }
    }
    const last = parser.end();
    if (last) await handle(last);
  } finally {
    stream.destroy();
  }

  if (header === null) throw Errors.unprocessable('The file has no header row');

  await flush();
  await persistErrors();

  // Note what is deliberately *not* here: fraud scoring.
  //
  // `fraudService.evaluate` reasons about the gap between a click and a sale,
  // repeated cookies, and click bursts. An imported row has no click events at
  // all, so every signal it looks for is absent or degenerate and every
  // historical conversion would come back flagged. A brand migrating two years
  // of data would arrive to 50,000 fraud reviews, learn that the queue means
  // nothing, and stop reading it -- which costs more than the scoring is
  // worth. Imports are trusted because the brand is the source; live
  // postbacks are scored because the internet is not.
  //
  // For the same reason no Commission rows are written. An imported sale was
  // settled on the platform the brand is leaving; minting LOCKED commissions
  // for it would make us liable to pay money that has already been paid.
  // Imported conversions are reporting data, not payable events.
}

export async function startImportWorker() {
  logger.info('Conversion import worker started');

  const tick = async () => {
    try {
      const outcome = await runNextImportJob();
      await beat(WORKER_NAME, TICK_MS, outcome ? { lastJob: outcome.jobId } : {});
    } catch (err) {
      // Reaching here means the claim or the bookkeeping failed, not the
      // import: a job that throws mid-file is caught and marked FAILED with a
      // message the brand can read.
      logger.error({ err }, 'Import worker tick failed');
      await beat(WORKER_NAME, TICK_MS, { lastError: String(err) });
    }
  };

  setInterval(() => {
    tick().catch((err) => logger.error({ err }, 'Import worker tick threw'));
  }, TICK_MS);
}
