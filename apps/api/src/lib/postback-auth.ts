import type { FastifyReply, FastifyRequest } from 'fastify';
import { Errors } from './errors';
import { logger } from './logger';
import {
  KEY_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verifyPostbackSignature,
} from './postback-signature';
import { apiKeyService } from '../services/api-key.service';

/** Set by the raw-body content type parser registered in conversion.routes.ts. */
export interface RawBodyRequest extends FastifyRequest {
  rawBody?: string;
}

export interface PostbackAuthedRequest extends FastifyRequest {
  apiKey: { id: string; keyId: string };
}

/**
 * Authenticates a signed server-to-server postback.
 *
 * Every failure produces the same 401 with the same code. The specific reason
 * goes to the log, not to the caller: distinguishing "no such campaign" from
 * "bad signature" tells an attacker which campaign ids are real, and tells a
 * legitimate integrator less than the documentation already does.
 */
export function requirePostbackSignature() {
  const apiKeys = apiKeyService();

  return async function (req: FastifyRequest, _reply: FastifyReply) {
    const { campaignId } = req.params as { campaignId: string };

    const keyId = req.headers[KEY_HEADER];
    const timestamp = req.headers[TIMESTAMP_HEADER];
    const signature = req.headers[SIGNATURE_HEADER];

    const reject = (reason: string) => {
      logger.warn({ reason, campaignId, keyId }, 'Rejected conversion postback');
      return Errors.unauthorized('Invalid postback signature');
    };

    if (typeof keyId !== 'string') throw reject('missing_key');
    if (typeof timestamp !== 'string') throw reject('missing_timestamp');
    if (typeof signature !== 'string') throw reject('missing_signature');

    // The signature covers the bytes as sent. Re-serialising the parsed body
    // would reorder keys and change whitespace, and the signature would never
    // match.
    const rawBody = (req as RawBodyRequest).rawBody;
    if (typeof rawBody !== 'string') throw reject('missing_raw_body');

    const resolved = await apiKeys.resolveSigningSecret(keyId, campaignId);
    if (!resolved) throw reject('unknown_or_revoked_key');

    const result = verifyPostbackSignature({
      secret: resolved.secret,
      timestamp,
      signature,
      rawBody,
      nowMs: Date.now(),
    });
    if (!result.ok) throw reject(result.reason);

    (req as PostbackAuthedRequest).apiKey = { id: resolved.id, keyId };

    // Deliberately not awaited: this is bookkeeping, and the conversion
    // should not wait on it or fail with it.
    void apiKeys.touch(resolved.id);
  };
}
