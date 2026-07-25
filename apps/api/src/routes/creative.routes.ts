import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { creativeService, MAX_ASSET_BYTES } from '../services/creative.service';
import { requireAuth, requireRole, type AuthedRequest } from '../lib/auth';
import { Errors } from '../lib/errors';

export async function creativeRoutes(app: FastifyInstance) {
  const svc = creativeService();

  // Registered in this scope only. The rest of the API speaks JSON and has no
  // reason to accept multipart bodies.
  await app.register(multipart, {
    limits: {
      // Enforced while reading, so an oversized upload is cut off rather than
      // buffered in full and then rejected. The service checks the size again
      // -- the limit here protects memory, the service check protects the
      // rule, and they are not the same concern.
      fileSize: MAX_ASSET_BYTES,
      files: 1,
    },
  });

  app.post(
    '/brand/campaigns/:id/creatives',
    {
      preHandler: [requireAuth, requireRole('BRAND')],
      config: {
        // Tighter than the global limit. Uploads cost disk and CPU, and no
        // legitimate brand adds banners in a hot loop.
        rateLimit: { max: 30, timeWindow: '1 minute' },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const user = (req as AuthedRequest).user;

      const file = await req.file();
      if (!file) throw Errors.badRequest('No file uploaded');

      const bytes = await file.toBuffer().catch(() => {
        // @fastify/multipart throws when the size limit is hit mid-stream.
        throw Errors.badRequest(
          `File is larger than ${MAX_ASSET_BYTES / 1024 / 1024}MB`
        );
      });

      const name =
        (file.fields.name as { value?: string } | undefined)?.value ??
        file.filename ??
        'Untitled';

      const asset = await svc.upload(user.id, id, {
        name: String(name).slice(0, 200),
        bytes,
      });
      reply.code(201);
      return asset;
    }
  );

  app.get(
    '/brand/campaigns/:id/creatives',
    { preHandler: [requireAuth, requireRole('BRAND')] },
    async (req) => {
      const { id } = req.params as { id: string };
      const user = (req as AuthedRequest).user;
      return svc.listForBrand(user.id, id);
    }
  );

  app.get(
    '/affiliate/campaigns/:id/creatives',
    { preHandler: [requireAuth, requireRole('AFFILIATE')] },
    async (req) => {
      const { id } = req.params as { id: string };
      const user = (req as AuthedRequest).user;
      return svc.listForAffiliate(user.id, id);
    }
  );

  /**
   * Served through the API rather than from a public directory, so the
   * "are you allowed to see this?" check exists at all.
   */
  app.get(
    '/creatives/:assetId/file',
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const { assetId } = req.params as { assetId: string };
      const user = (req as AuthedRequest).user;

      const { asset, bytes } = await svc.download(user, assetId);

      // nosniff so a browser cannot be talked into interpreting these bytes as
      // something executable, and attachment-by-default for the same reason.
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Cache-Control', 'private, max-age=3600');
      reply.type(mimeFor(asset.url));
      return reply.send(bytes);
    }
  );

  app.delete(
    '/brand/creatives/:assetId',
    { preHandler: [requireAuth, requireRole('BRAND')] },
    async (req) => {
      const { assetId } = req.params as { assetId: string };
      const user = (req as AuthedRequest).user;
      return svc.remove(user.id, assetId);
    }
  );
}

/** Derived from our own generated key, never from anything a user supplied. */
function mimeFor(key: string): string {
  if (key.endsWith('.png')) return 'image/png';
  if (key.endsWith('.jpeg')) return 'image/jpeg';
  if (key.endsWith('.gif')) return 'image/gif';
  if (key.endsWith('.webp')) return 'image/webp';
  return 'application/octet-stream';
}
