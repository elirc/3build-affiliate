import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { acceptsConversions } from '@affiliate/analytics';
import { Errors } from '../lib/errors';
import { logger } from '../lib/logger';
import { campaignRepository } from '../repositories/campaign.repository';
import { importJobRepository } from '../repositories/import-job.repository';
import { prisma } from '../config/prisma';
import { env } from '../config/env';

/** 100MB. Roughly a million rows of this shape; far more than anyone migrates. */
export const MAX_IMPORT_BYTES = 100 * 1024 * 1024;

/**
 * Hard row cap.
 *
 * Enforced by counting newlines as the bytes go past, which *over*-counts when
 * a quoted value contains one. That is the safe direction: the cap exists to
 * bound the work a single upload can create, and a file close enough to the
 * limit for the difference to matter should be split anyway.
 */
export const MAX_IMPORT_ROWS = 100_000;

const NEWLINE = 0x0a;

/** How many per-row errors the report shows before it stops being a report. */
export const MAX_ROW_ERRORS = 1_000;

export interface UploadedFile {
  filename: string;
  stream: Readable;
  /** Whether the multipart layer cut the stream off at its own size limit. */
  wasTruncated: () => boolean;
}

export function importService() {
  const campaigns = campaignRepository(prisma);
  const jobs = importJobRepository(prisma);

  async function assertBrandOwns(brandId: string, campaignId: string) {
    const campaign = await campaigns.findById(campaignId);
    if (!campaign) throw Errors.notFound('Campaign');
    if (campaign.brandId !== brandId) throw Errors.forbidden();
    return campaign;
  }

  return {
    /**
     * Spools an upload to disk and queues it.
     *
     * Returns as soon as the bytes have landed, because the parsing is not a
     * request's work: 100,000 rows takes minutes, and an HTTP request that
     * takes minutes gets killed by a proxy, a load balancer or a phone
     * changing network -- and nothing tells the server, which carries on
     * importing into a socket nobody is listening to.
     */
    async enqueue(brandId: string, campaignId: string, upload: UploadedFile) {
      // Before a single byte is written. A brand that does not own this
      // campaign should not be able to make us spool 100MB to find out.
      const campaign = await assertBrandOwns(brandId, campaignId);

      // The same rule the postback endpoint applies, from the same function.
      // An import is still a conversion arriving, and two entry points that
      // disagree about which campaigns accept one is how a closed campaign
      // acquires sales through the back door.
      if (!acceptsConversions(campaign.status)) {
        throw Errors.unprocessable(
          `Campaign is ${campaign.status.toLowerCase()} and no longer accepts conversions`
        );
      }

      await fs.mkdir(env.IMPORT_STORAGE_PATH, { recursive: true });
      // Our name, never the uploader's: a client-supplied filename is a path
      // traversal waiting to happen.
      const sourcePath = path.join(
        env.IMPORT_STORAGE_PATH,
        `${crypto.randomBytes(16).toString('hex')}.csv`
      );

      let handedOff = false;
      try {
        const sizeBytes = await spool(upload.stream, sourcePath);

        if (upload.wasTruncated()) {
          throw Errors.badRequest(
            `File is larger than ${MAX_IMPORT_BYTES / 1024 / 1024}MB`
          );
        }
        if (sizeBytes === 0) throw Errors.badRequest('File is empty');

        const job = await jobs.create({
          campaignId,
          filename: upload.filename.slice(0, 255),
          sizeBytes,
          sourcePath,
          status: 'PENDING',
        });

        handedOff = true;
        logger.info(
          { jobId: job.id, campaignId, sizeBytes },
          'Conversion import queued'
        );
        return job;
      } finally {
        // The spooled file belongs to the job from the moment the row exists.
        // Until then it belongs to nobody, and leaving it behind on every
        // rejected upload is how a disk fills up with files no code will ever
        // look at again.
        if (!handedOff) {
          await fs.rm(sourcePath, { force: true }).catch((err) => {
            logger.error({ err, sourcePath }, 'Could not remove a spooled import file');
          });
        }
      }
    },

    /**
     * Progress for a job, including the first page of row errors.
     *
     * Scoped through the campaign's brand: a job id is a cuid, but "you cannot
     * guess it" is not an authorization model.
     */
    async status(brandId: string, jobId: string) {
      const job = await jobs.findForBrand(jobId, brandId);
      if (!job) throw Errors.notFound('Import job');

      const [errors, errorCount] = await Promise.all([
        jobs.listErrors(jobId, { skip: 0, take: 50 }),
        jobs.countErrors(jobId),
      ]);

      return {
        id: job.id,
        campaignId: job.campaignId,
        status: job.status,
        filename: job.filename,
        sizeBytes: job.sizeBytes,
        totalRows: job.totalRows,
        importedRows: job.importedRows,
        skippedRows: job.skippedRows,
        failedRows: job.failedRows,
        errorMessage: job.errorMessage,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        createdAt: job.createdAt,
        errors,
        /**
         * `failedRows` counts every bad row; `errorCount` counts the ones we
         * kept. They differ exactly when a file was so broken that storing
         * every error would have been a second copy of it.
         */
        errorsStored: errorCount,
        errorsTruncated: job.failedRows > errorCount,
      };
    },

    /**
     * The stored errors, oldest line first, for the downloadable report.
     *
     * Authorization is checked here and the rows are handed back a page at a
     * time, so the route can stream them without ever holding the report.
     */
    async errorReport(brandId: string, jobId: string) {
      const job = await jobs.findForBrand(jobId, brandId);
      if (!job) throw Errors.notFound('Import job');
      if (job.status === 'PENDING' || job.status === 'PROCESSING') {
        throw Errors.unprocessable(
          'This import has not finished yet, so its error report is not final'
        );
      }

      return {
        job,
        fetchPage: (skip: number, take: number) => jobs.listErrors(jobId, { skip, take }),
      };
    },
  };
}

/**
 * Writes the upload to disk, refusing it mid-stream if it is too big.
 *
 * Nothing is buffered: bytes go from the socket to the file through a counter,
 * so peak memory is one chunk regardless of whether the file is 2KB or 100MB.
 * The checks are inside the transform rather than after the write for the same
 * reason -- "reject it once we have it all" is exactly the behaviour a 100MB
 * limit is supposed to prevent.
 */
async function spool(source: Readable, target: string): Promise<number> {
  let bytes = 0;
  let lines = 0;

  const meter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      if (bytes > MAX_IMPORT_BYTES) {
        done(
          Errors.badRequest(`File is larger than ${MAX_IMPORT_BYTES / 1024 / 1024}MB`)
        );
        return;
      }

      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] === NEWLINE) lines += 1;
      }
      // Header plus data rows. Counted here rather than during parsing so a
      // 500,000-row file is refused after a few megabytes instead of after we
      // have written all of it and read it back.
      if (lines > MAX_IMPORT_ROWS + 1) {
        done(
          Errors.badRequest(
            `File has more than ${MAX_IMPORT_ROWS.toLocaleString('en-US')} rows. ` +
              'Split it and upload the parts separately.'
          )
        );
        return;
      }

      done(null, chunk);
    },
  });

  await pipeline(source, meter, createWriteStream(target));
  return bytes;
}
