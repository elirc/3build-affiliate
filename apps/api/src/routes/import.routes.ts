import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { Readable } from 'node:stream';
import {
  MAX_IMPORT_BYTES,
  MAX_IMPORT_ROWS,
  importService,
} from '../services/import.service';
import { requireAuth, requireRole, type AuthedRequest } from '../lib/auth';
import { Errors } from '../lib/errors';
import { csvFilename, paginate, streamCsv, type CsvColumn } from '../lib/csv';

export async function importRoutes(app: FastifyInstance) {
  const svc = importService();

  // Registered in this scope only. The rest of the API speaks JSON and has no
  // reason to accept multipart bodies.
  await app.register(multipart, {
    limits: {
      // A second line of defence behind the check in the service: busboy stops
      // feeding the stream here, so an oversized upload cannot be buffered
      // even if the pipeline below were changed to buffer it.
      fileSize: MAX_IMPORT_BYTES,
      files: 1,
    },
    // We consume the stream ourselves rather than calling `toBuffer`, and the
    // plugin's own throw-on-limit fires on a promise nobody is awaiting. The
    // `truncated` flag is checked explicitly instead, which turns the same
    // condition into a 400 with a message that says what the limit is.
    throwFileSizeLimit: false,
  });

  /**
   * Accepts a CSV and returns immediately with a job id.
   *
   * 202, not 201: nothing has been imported yet, and saying otherwise would
   * make every client that trusts the status code wrong about what happened.
   */
  app.post(
    '/brand/campaigns/:id/conversions/import',
    {
      preHandler: [requireAuth, requireRole('BRAND')],
      config: {
        // Tight, and with no burst headroom: each accepted upload costs disk
        // and minutes of worker time, and a migration is something a person
        // does a handful of times, never in a loop.
        //
        // `failOpen: false` -- if Redis cannot answer, refuse the upload. The
        // usual argument for failing open is that a read should not break
        // because the limiter is unavailable. This is not a read; it is 100MB
        // of disk and a queued job, and the safe answer to "I cannot count
        // this" is no.
        rateLimit: { perMinute: 10, burst: 10, scope: 'user', failOpen: false },
        // Deliberately *not* idempotent-keyed. The plugin fingerprints
        // `req.body`, which for a multipart upload is not the file -- so two
        // different files would share a fingerprint and the second would
        // replay the first's job id. Row-level idempotency is what actually
        // protects this endpoint: re-uploading the same file imports nothing.
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const user = (req as AuthedRequest).user;

      const file = await req.file();
      if (!file) throw Errors.badRequest('No file uploaded');

      const job = await svc.enqueue(user.id, id, {
        filename: file.filename ?? 'conversions.csv',
        stream: file.file,
        wasTruncated: () => file.file.truncated,
      });

      reply.code(202);
      return {
        jobId: job.id,
        status: job.status,
        sizeBytes: job.sizeBytes,
        maxRows: MAX_IMPORT_ROWS,
        statusUrl: `/api/brand/import-jobs/${job.id}`,
      };
    }
  );

  app.get(
    '/brand/import-jobs/:jobId',
    { preHandler: [requireAuth, requireRole('BRAND')] },
    async (req) => {
      const { jobId } = req.params as { jobId: string };
      const user = (req as AuthedRequest).user;
      return svc.status(user.id, jobId);
    }
  );

  /**
   * The failed rows, and only those, with the line numbers from the file the
   * brand uploaded -- so they can fix twelve rows rather than re-deriving
   * which twelve from a list of fifty thousand.
   */
  app.get(
    '/brand/import-jobs/:jobId/errors.csv',
    { preHandler: [requireAuth, requireRole('BRAND')] },
    async (req, reply) => {
      const { jobId } = req.params as { jobId: string };
      const user = (req as AuthedRequest).user;

      const { fetchPage } = await svc.errorReport(user.id, jobId);

      type Row = { line: number; column: string | null; message: string };
      const columns: CsvColumn<Row>[] = [
        { header: 'Line', value: (r) => r.line },
        { header: 'Column', value: (r) => r.column },
        { header: 'Error', value: (r) => r.message },
      ];

      reply.header('Content-Type', 'text/csv; charset=utf-8');
      reply.header(
        'Content-Disposition',
        `attachment; filename="${csvFilename('import-errors')}"`
      );
      return reply.send(Readable.from(streamCsv(columns, paginate(fetchPage))));
    }
  );
}
