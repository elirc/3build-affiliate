import type { FastifyInstance, FastifyRequest } from 'fastify';
import crypto from 'node:crypto';
import { trackingService } from '../services/tracking.service';
import { Errors } from '../lib/errors';
import { env } from '../config/env';

/**
 * Service-to-service endpoints. Not for browsers, not for brands, not for
 * affiliates -- these are called by our own deployables.
 *
 * They are mounted without the /api prefix so that a reverse proxy can refuse
 * to route /internal/* from the public internet. Defence in depth: the shared
 * token is the actual control, the path is a second layer.
 */

function requireInternalToken(req: FastifyRequest) {
  const provided = req.headers['x-internal-token'];
  if (typeof provided !== 'string') throw Errors.unauthorized();

  // Constant-time comparison. Length is compared first because
  // timingSafeEqual throws on a length mismatch, and Buffer.byteLength of the
  // supplied value is already public information.
  const a = Buffer.from(provided);
  const b = Buffer.from(env.INTERNAL_API_TOKEN);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw Errors.unauthorized();
  }
}

export async function internalRoutes(app: FastifyInstance) {
  const tracking = trackingService();

  /**
   * Resolve a short code for the redirect service's cache-miss path.
   *
   * Returns only the fields a redirect needs. There is no reason for this
   * response to carry click counts or revenue, and a smaller payload is a
   * smaller thing to get wrong.
   */
  app.get<{ Params: { shortCode: string } }>(
    '/internal/links/:shortCode',
    async (req, reply) => {
      requireInternalToken(req);

      const link = await tracking.resolveForRedirect(req.params.shortCode);
      if (!link) return reply.code(404).send({
        error: { code: 'NOT_FOUND', message: 'Tracking link not found' },
      });

      return link;
    }
  );
}
