import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { build } from '../src/server';
import { prisma } from '../src/config/prisma';
import { env } from '../src/config/env';
import { runNextImportJob } from '../src/workers/import.worker';
import { MAX_IMPORT_ROWS, MAX_ROW_ERRORS } from '../src/services/import.service';
import {
  login,
  makeAffiliate,
  makeBrand,
  makeCampaign,
  makeRelationship,
  makeTrackingLink,
} from './factories';

/**
 * Bulk import: row 40,000 of 50,000 is invalid. Now what?
 *
 * The interesting assertions here are not "it imported the rows". They are the
 * ones about what happens when it does not: which line the brand is told to
 * look at, what a second upload of the same file does, and what is left on
 * disk afterwards.
 */
describe('bulk conversion import', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await build({ rateLimit: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const HEADER = 'externalOrderId,trackingCode,conversionValue,occurredAt';

  async function scenario() {
    const brand = await makeBrand();
    const campaign = await makeCampaign(brand.id, {
      commissionStructure: { type: 'percentage', percentage: 10 },
    });
    const affiliate = await makeAffiliate();
    await makeRelationship(brand.id, affiliate.id);
    const link = await makeTrackingLink(affiliate.id, campaign.id);
    const auth = await login(app, brand.email);
    return { brand, campaign, affiliate, link, auth };
  }

  /** Builds a multipart body by hand: `inject` has no file helper. */
  function multipart(csv: string, filename = 'conversions.csv') {
    const boundary = `----import${crypto.randomBytes(8).toString('hex')}`;
    const payload = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        'Content-Type: text/csv\r\n\r\n' +
        csv +
        `\r\n--${boundary}--\r\n`
    );
    return {
      payload,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    };
  }

  async function upload(
    campaignId: string,
    authHeader: Record<string, string>,
    csv: string
  ) {
    const { payload, headers } = multipart(csv);
    return app.inject({
      method: 'POST',
      url: `/api/brand/campaigns/${campaignId}/conversions/import`,
      headers: { ...authHeader, ...headers },
      payload,
    });
  }

  function rows(count: number, code: string, from = 1) {
    const lines: string[] = [];
    for (let i = from; i < from + count; i++) {
      lines.push(`ord-${i},${code},10.00,2024-03-0${(i % 9) + 1}T09:30:00Z`);
    }
    return lines;
  }

  async function jobStatus(jobId: string, authHeader: Record<string, string>) {
    const res = await app.inject({
      method: 'GET',
      url: `/api/brand/import-jobs/${jobId}`,
      headers: authHeader,
    });
    expect(res.statusCode).toBe(200);
    return res.json() as {
      status: string;
      totalRows: number;
      importedRows: number;
      skippedRows: number;
      failedRows: number;
      errorMessage: string | null;
      errorsStored: number;
      errorsTruncated: boolean;
      errors: { line: number; column: string | null; message: string }[];
    };
  }

  it('imports 1,000 valid rows and reports the job completed', async () => {
    const { campaign, link, auth } = await scenario();
    const csv = [HEADER, ...rows(1000, link.shortCode)].join('\n');

    const res = await upload(campaign.id, auth.authHeader, csv);

    // 202, not 201: nothing has been imported yet.
    expect(res.statusCode).toBe(202);
    const { jobId } = res.json() as { jobId: string };

    // Still nothing, until a worker runs. The request did not do the work.
    expect(await prisma.conversion.count()).toBe(0);

    await runNextImportJob();

    const status = await jobStatus(jobId, auth.authHeader);
    expect(status.status).toBe('COMPLETED');
    expect(status.totalRows).toBe(1000);
    expect(status.importedRows).toBe(1000);
    expect(status.failedRows).toBe(0);
    expect(await prisma.conversion.count()).toBe(1000);
  });

  it('imports 97 of 100 rows and names the exact lines that failed', async () => {
    // The headline case. Line numbers are what make the report usable: a
    // report that says "row 40" when the file's line 41 is the broken one
    // sends the brand to the wrong place.
    const { campaign, link, auth } = await scenario();
    const lines = [HEADER, ...rows(100, link.shortCode)];
    lines[4] = `ord-bad-a,${link.shortCode},not-a-number,2024-03-01T09:30:00Z`;
    lines[41] = `ord-bad-b,${link.shortCode},10.00,last tuesday`;
    lines[100] = `ord-bad-c,nosuchcode,10.00,2024-03-01T09:30:00Z`;

    const res = await upload(campaign.id, auth.authHeader, lines.join('\n'));
    const { jobId } = res.json() as { jobId: string };
    await runNextImportJob();

    const status = await jobStatus(jobId, auth.authHeader);
    expect(status.status).toBe('COMPLETED');
    expect(status.totalRows).toBe(100);
    expect(status.importedRows).toBe(97);
    expect(status.failedRows).toBe(3);
    expect(await prisma.conversion.count()).toBe(97);

    // Array index 4 is file line 5, and so on. Asserted exactly.
    expect(status.errors.map((e) => e.line)).toEqual([5, 42, 101]);
    expect(status.errors.map((e) => e.column)).toEqual([
      'conversionValue',
      'occurredAt',
      'trackingCode',
    ]);
  });

  it('offers the failed rows as a CSV with the original line numbers', async () => {
    const { campaign, link, auth } = await scenario();
    const lines = [HEADER, ...rows(10, link.shortCode)];
    lines[3] = `ord-bad,${link.shortCode},-5,2024-03-01T09:30:00Z`;

    const res = await upload(campaign.id, auth.authHeader, lines.join('\n'));
    const { jobId } = res.json() as { jobId: string };
    await runNextImportJob();

    const report = await app.inject({
      method: 'GET',
      url: `/api/brand/import-jobs/${jobId}/errors.csv`,
      headers: auth.authHeader,
    });

    expect(report.statusCode).toBe(200);
    expect(report.headers['content-type']).toContain('text/csv');
    const body = report.body.trim().split('\r\n');
    expect(body[0]).toBe('Line,Column,Error');
    expect(body).toHaveLength(2);
    expect(body[1]).toMatch(/^4,conversionValue,/);
  });

  it('imports nothing new when the same file is uploaded again', async () => {
    // What a brand actually does: fix twelve rows, re-upload all fifty
    // thousand. The unique constraint on (campaignId, externalOrderId) is what
    // makes that free, and `skipDuplicates` is what stops it being an error.
    const { campaign, link, auth } = await scenario();
    const csv = [HEADER, ...rows(50, link.shortCode)].join('\n');

    const first = await upload(campaign.id, auth.authHeader, csv);
    await runNextImportJob();
    expect((await jobStatus((first.json() as { jobId: string }).jobId, auth.authHeader)).importedRows).toBe(50);

    const second = await upload(campaign.id, auth.authHeader, csv);
    await runNextImportJob();
    const status = await jobStatus((second.json() as { jobId: string }).jobId, auth.authHeader);

    expect(status.status).toBe('COMPLETED');
    expect(status.totalRows).toBe(50);
    expect(status.importedRows).toBe(0);
    expect(status.skippedRows).toBe(50);
    expect(status.failedRows).toBe(0);
    expect(await prisma.conversion.count()).toBe(50);
  });

  it('fails the whole job when a required column is missing', async () => {
    // A malformed file, not a bad row: reporting it 50,000 times would bury
    // the one sentence that says what to fix.
    const { campaign, link, auth } = await scenario();
    const csv = ['externalOrderId,conversionValue,occurredAt', ...rows(20, link.shortCode)].join('\n');

    const res = await upload(campaign.id, auth.authHeader, csv);
    const { jobId } = res.json() as { jobId: string };
    await runNextImportJob();

    const status = await jobStatus(jobId, auth.authHeader);
    expect(status.status).toBe('FAILED');
    expect(status.errorMessage).toContain('trackingCode');
    expect(status.totalRows).toBe(0);
    expect(status.errorsStored).toBe(0);
    expect(await prisma.conversion.count()).toBe(0);
  });

  it('isolates a row the database rejects instead of losing the batch', async () => {
    // Nothing in the schema can catch this: 99,999,999,999.99 is a positive
    // number, and only Postgres knows the column is Decimal(12,2). Before
    // bisection an overflow like this rolled back all 500 rows around it.
    const { campaign, link, auth } = await scenario();
    const lines = [HEADER, ...rows(20, link.shortCode)];
    lines[7] = `ord-huge,${link.shortCode},99999999999.99,2024-03-01T09:30:00Z`;

    const res = await upload(campaign.id, auth.authHeader, lines.join('\n'));
    const { jobId } = res.json() as { jobId: string };
    await runNextImportJob();

    const status = await jobStatus(jobId, auth.authHeader);
    expect(status.importedRows).toBe(19);
    expect(status.failedRows).toBe(1);
    expect(status.errors[0]?.line).toBe(8);
    expect(await prisma.conversion.count()).toBe(19);
  });

  it('caps the stored errors so a wholly invalid file is not copied into the database', async () => {
    const { campaign, link, auth } = await scenario();
    const bad: string[] = [HEADER];
    for (let i = 0; i < MAX_ROW_ERRORS + 200; i++) {
      bad.push(`ord-${i},${link.shortCode},not-a-number,2024-03-01T09:30:00Z`);
    }

    const res = await upload(campaign.id, auth.authHeader, bad.join('\n'));
    const { jobId } = res.json() as { jobId: string };
    await runNextImportJob();

    const status = await jobStatus(jobId, auth.authHeader);
    expect(status.failedRows).toBe(MAX_ROW_ERRORS + 200);
    expect(status.errorsStored).toBe(MAX_ROW_ERRORS);
    expect(status.errorsTruncated).toBe(true);
  });

  it('rejects a file over the row cap while it is still arriving', async () => {
    const { campaign, auth } = await scenario();
    // Only the header is well formed; the point is that the request is
    // refused on the strength of the line count alone, before anything tries
    // to parse or import it.
    const huge = [HEADER, ...Array.from({ length: MAX_IMPORT_ROWS + 10 }, (_, i) => `ord-${i},x,1,2024-03-01T09:30:00Z`)].join('\n');

    const res = await upload(campaign.id, auth.authHeader, huge);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { message: expect.stringContaining('rows') } });
    // No job, and nothing left behind for a worker to find.
    expect(await prisma.importJob.count()).toBe(0);
  });

  it('marks imported conversions as IMPORT and does not fraud-score them', async () => {
    // The domain judgement this story is really about. An imported row has no
    // click events, so every signal the fraud service looks for is absent --
    // scoring it would flag the entire history of a brand that has done
    // nothing wrong, and a review queue nobody believes is worse than none.
    const { campaign, link, auth } = await scenario();
    const csv = [HEADER, ...rows(5, link.shortCode)].join('\n');

    await upload(campaign.id, auth.authHeader, csv);
    await runNextImportJob();

    const conversions = await prisma.conversion.findMany();
    expect(conversions).toHaveLength(5);
    expect(conversions.every((c) => c.source === 'IMPORT')).toBe(true);
    expect(conversions.every((c) => c.clickEventId === null)).toBe(true);
    expect(await prisma.fraudReview.count()).toBe(0);
    // Reporting data, not payable events: the sale was settled on the platform
    // the brand is migrating from.
    expect(await prisma.commission.count()).toBe(0);
    // The campaign's 10% rate, applied from the same calculator the postback
    // path uses.
    expect(Number(conversions[0]!.commissionAmount)).toBe(1);
  });

  it('deletes the spooled file after a successful run', async () => {
    const { campaign, link, auth } = await scenario();
    const res = await upload(
      campaign.id,
      auth.authHeader,
      [HEADER, ...rows(5, link.shortCode)].join('\n')
    );
    const { jobId } = res.json() as { jobId: string };

    const queued = await prisma.importJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(queued.sourcePath).toBeTruthy();
    await expect(fs.access(queued.sourcePath!)).resolves.toBeUndefined();

    await runNextImportJob();

    await expect(fs.access(queued.sourcePath!)).rejects.toThrow();
    const done = await prisma.importJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(done.sourcePath).toBeNull();
  });

  it('deletes the spooled file after a failed run too', async () => {
    const { campaign, auth } = await scenario();
    const res = await upload(campaign.id, auth.authHeader, 'nothing,useful\n1,2\n');
    const { jobId } = res.json() as { jobId: string };

    const queued = await prisma.importJob.findUniqueOrThrow({ where: { id: jobId } });
    await runNextImportJob();

    const done = await prisma.importJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(done.status).toBe('FAILED');
    await expect(fs.access(queued.sourcePath!)).rejects.toThrow();
    expect(done.sourcePath).toBeNull();
  });

  it('refuses an import into a campaign the caller does not own', async () => {
    const { campaign, link } = await scenario();
    const intruder = await makeBrand();
    const auth = await login(app, intruder.email);

    const res = await upload(
      campaign.id,
      auth.authHeader,
      [HEADER, ...rows(5, link.shortCode)].join('\n')
    );

    expect(res.statusCode).toBe(403);
    expect(await prisma.importJob.count()).toBe(0);
  });

  it('hides another brand\'s job behind a 404', async () => {
    const { campaign, link, auth } = await scenario();
    const res = await upload(
      campaign.id,
      auth.authHeader,
      [HEADER, ...rows(5, link.shortCode)].join('\n')
    );
    const { jobId } = res.json() as { jobId: string };

    const intruder = await makeBrand();
    const intruderAuth = await login(app, intruder.email);
    const peek = await app.inject({
      method: 'GET',
      url: `/api/brand/import-jobs/${jobId}`,
      headers: intruderAuth.authHeader,
    });

    expect(peek.statusCode).toBe(404);
  });

  it('claims a job once, however many workers are polling', async () => {
    // Two instances poll the same table. Without the conditional claim they
    // both read PENDING and both import the file, which the row-level unique
    // constraint would hide -- as "0 imported, 50 skipped" on a first upload.
    const { campaign, link, auth } = await scenario();
    await upload(
      campaign.id,
      auth.authHeader,
      [HEADER, ...rows(50, link.shortCode)].join('\n')
    );

    const [a, b] = await Promise.all([runNextImportJob(), runNextImportJob()]);

    const outcomes = [a, b].filter((o) => o !== null);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.importedRows).toBe(50);
    expect(await prisma.conversion.count()).toBe(50);
  });

  /**
   * The memory claim.
   *
   * Driven through the worker rather than the HTTP route on purpose: building
   * a 50,000-row multipart body inside the test would allocate several
   * megabytes in the *test process*, which is the same heap being measured.
   *
   * The ceiling is deliberately generous. What it catches is the thing this
   * story is about -- an implementation that reads the file into memory, or
   * accumulates every parsed row before writing -- not a few megabytes of
   * ordinary churn.
   */
  it('keeps peak memory flat over a 50,000-row file', async () => {
    const { campaign, link } = await scenario();

    const sourcePath = path.join(
      env.IMPORT_STORAGE_PATH,
      `${crypto.randomBytes(8).toString('hex')}.csv`
    );
    await fs.mkdir(env.IMPORT_STORAGE_PATH, { recursive: true });

    const out = createWriteStream(sourcePath);
    const write = (chunk: string) =>
      out.write(chunk) ? Promise.resolve() : new Promise((r) => out.once('drain', r));
    await write(`${HEADER}\n`);
    for (let i = 0; i < 50_000; i++) {
      await write(`ord-${i},${link.shortCode},10.00,2024-03-01T09:30:00Z\n`);
    }
    await new Promise((resolve) => out.end(resolve));

    const { size } = await fs.stat(sourcePath);
    const job = await prisma.importJob.create({
      data: { campaignId: campaign.id, filename: 'big.csv', sizeBytes: size, sourcePath },
    });

    global.gc?.();
    const before = process.memoryUsage().rss;
    let peak = before;
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 100);

    let outcome;
    try {
      outcome = await runNextImportJob();
    } finally {
      clearInterval(sampler);
    }

    expect(outcome?.jobId).toBe(job.id);
    expect(outcome?.importedRows).toBe(50_000);

    const growthMb = (peak - before) / 1024 / 1024;
    // Printed, not just asserted: a memory bound whose actual value nobody can
    // see is a bound nobody will notice creeping upwards.
    console.log(
      `50,000-row import: peak RSS +${growthMb.toFixed(1)}MB over ${(size / 1024 / 1024).toFixed(1)}MB of CSV`
    );
    expect(growthMb).toBeLessThan(200);
  }, 300_000);
});
