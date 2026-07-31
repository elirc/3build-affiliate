import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { fingerprint } from '../lib/fingerprint';
import { AppError } from '../lib/errors';
import { logger } from '../lib/logger';
import type { AuthedRequest } from '../lib/auth';

/** How long a key is honoured. Long enough for any sane retry schedule. */
const TTL_MS = 24 * 60 * 60 * 1000;

const MAX_KEY_LENGTH = 200;

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Opt a route in. Absent means the plugin ignores the route entirely. */
    idempotent?: boolean;
  }
}

interface ClaimState {
  key: string;
  endpoint: string;
  id: string;
}

/**
 * Makes a mutating endpoint safe to retry.
 *
 * A client that times out cannot tell whether the request was applied. Its
 * only options are to retry -- and risk a second payout -- or not to, and risk
 * none. An idempotency key removes the dilemma: the retry is recognised and
 * the original outcome replayed.
 *
 * ```text
 *               ┌──────────────┐
 *  first call   │ IN_PROGRESS  │ ← concurrent retry ⇒ 409, Retry-After
 *  ────────────►│              │
 *               └──────┬───────┘
 *                      │ handler returns
 *                      ▼
 *               ┌──────────────┐
 *               │  COMPLETED   │ ← later retry ⇒ replay stored status + body
 *               └──────────────┘
 * ```
 *
 * Opt in per route, never globally:
 *
 * ```ts
 * app.post('/thing', { config: { idempotent: true } }, handler)
 * ```
 */
export function registerIdempotency(app: FastifyInstance) {
  // Hooks on the root instance, registered before the routes.
  //
  // Not `fastify-plugin`: hooks added inside a plugin are encapsulated to that
  // scope, and our routes live in child scopes created by `app.register(...,
  // { prefix })`. Adding them to the parent first means every child inherits
  // them, with no extra dependency. `registerErrorHandler` already works this
  // way.
  const claims = new WeakMap<FastifyRequest, ClaimState>();

  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.routeOptions.config?.idempotent) return;

    // GET and DELETE are already idempotent by definition; a key on them means
    // a confused client, and honouring it would cache reads.
    if (req.method !== 'POST' && req.method !== 'PATCH' && req.method !== 'PUT') return;

    const raw = req.headers['idempotency-key'];
    if (typeof raw !== 'string' || raw.length === 0) return;

    const key = raw.slice(0, MAX_KEY_LENGTH);
    // The route *pattern*, not the resolved url. Two payout requests differing
    // only by a path parameter should still be distinct keys, and they are --
    // via the fingerprint -- but the endpoint must be stable or every request
    // gets its own namespace and the constraint never fires.
    const endpoint = `${req.method} ${req.routeOptions.url}`;
    const fp = fingerprint(req.body);
    const userId = (req as AuthedRequest).user?.id ?? null;

    try {
      // The claim. Insert-and-catch rather than find-then-insert: the unique
      // constraint is the thing that decides, and it decides atomically. A
      // read followed by a write lets two concurrent retries both miss and
      // both proceed, which is the exact failure this plugin exists to stop.
      const created = await prisma.idempotencyKey.create({
        data: {
          key,
          endpoint,
          userId,
          fingerprint: fp,
          expiresAt: new Date(Date.now() + TTL_MS),
        },
      });
      claims.set(req, { key, endpoint, id: created.id });
      return;
    } catch (err) {
      if (
        !(err instanceof Prisma.PrismaClientKnownRequestError) ||
        err.code !== 'P2002'
      ) {
        throw err;
      }
    }

    // Someone already holds this key.
    const existing = await prisma.idempotencyKey.findUnique({
      where: { key_endpoint: { key, endpoint } },
    });
    if (!existing) {
      // Vanished between the insert failing and this read -- expired and swept
      // in the gap. Treat as a fresh request rather than inventing an error
      // for a state that resolves itself.
      return;
    }

    if (existing.fingerprint !== fp) {
      throw new AppError(
        422,
        'IDEMPOTENCY_KEY_REUSED',
        'This Idempotency-Key was already used with a different request body'
      );
    }

    if (existing.status === 'IN_PROGRESS') {
      // The first request has not finished. We cannot serve a result we do not
      // have, and running the handler anyway would defeat the whole point.
      reply.header('Retry-After', '1');
      throw new AppError(
        409,
        'IDEMPOTENT_REQUEST_IN_FLIGHT',
        'A request with this Idempotency-Key is still being processed'
      );
    }

    logger.info({ key, endpoint }, 'Replaying stored idempotent response');
    reply.header('Idempotent-Replay', 'true');
    reply.code(existing.responseCode ?? 200);
    return reply.send(existing.responseBody ?? null);
  });

  app.addHook('onSend', async (req, reply, payload) => {
    const claim = claims.get(req);
    if (!claim) return payload;
    claims.delete(req);

    const status = reply.statusCode;

    // A 5xx is not stored, and the key is released.
    //
    // The client retrying after a 500 wants a *different* outcome -- that is
    // the whole reason it is retrying. Replaying the failure back at it
    // forever would turn a transient fault into a permanent one. A 4xx is
    // deterministic (the same bad request will fail the same way), so it is
    // worth caching and saves re-running validation.
    if (status >= 500) {
      await prisma.idempotencyKey
        .delete({ where: { id: claim.id } })
        .catch((err) => logger.warn({ err, ...claim }, 'Could not release idempotency key'));
      return payload;
    }

    let body: unknown = null;
    if (typeof payload === 'string') {
      try {
        body = JSON.parse(payload);
      } catch {
        // Not JSON (a CSV export, an empty 204). Nothing worth replaying, and
        // storing a string that is not JSON would come back double-encoded.
        body = null;
      }
    }

    await prisma.idempotencyKey
      .update({
        where: { id: claim.id },
        data: {
          status: 'COMPLETED',
          responseCode: status,
          responseBody: body === null ? Prisma.DbNull : (body as Prisma.InputJsonValue),
        },
      })
      .catch((err) => {
        // The work has been done and the client is about to be told so.
        // Failing the response now would be strictly worse than losing the
        // ability to replay it.
        logger.error({ err, ...claim }, 'Could not record idempotent response');
      });

    return payload;
  });
}

/**
 * Deletes keys past their TTL.
 *
 * Called from a worker tick under a lease rather than on its own timer -- see
 * BE-07 for why another `setInterval` was not the answer.
 */
export async function cleanupIdempotencyKeys(now: Date = new Date()) {
  const { count } = await prisma.idempotencyKey.deleteMany({
    where: { expiresAt: { lt: now } },
  });
  return { deleted: count };
}
