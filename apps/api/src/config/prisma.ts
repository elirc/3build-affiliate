import { PrismaClient } from '@prisma/client';
import { env } from './env';
import { recordDbTime } from '../lib/db-timing';

export const prisma = new PrismaClient({
  log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});

/**
 * Times every operation and attributes it to the request that caused it.
 *
 * Middleware rather than the `query` log event: that event is emitted from
 * Prisma's own async context, so by the time it fires the request's
 * `AsyncLocalStorage` store is gone and the duration cannot be attributed to
 * anything. Middleware runs *inside* the caller's await chain, which is where
 * the store still is.
 *
 * Raw queries pass through here too (`params.action` is `queryRaw`), which
 * matters because the analytics aggregates -- the slowest thing this API does
 * -- are all `$queryRaw`.
 */
prisma.$use(async (params, next) => {
  const started = performance.now();
  try {
    return await next(params);
  } finally {
    recordDbTime(`${params.model ?? 'raw'}.${params.action}`, performance.now() - started);
  }
});

export type DB = typeof prisma;
