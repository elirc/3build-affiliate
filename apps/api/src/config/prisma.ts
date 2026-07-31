import { PrismaClient } from '@prisma/client';
import { env } from './env';
import { recordDbTime } from '../lib/db-timing';
import { dbQueryDuration } from '../lib/metrics';

export const prisma = new PrismaClient({
  log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});

/**
 * Times every operation, twice over, from one measurement.
 *
 * Two consumers want the same number for different questions. `recordDbTime`
 * attributes it to the request that caused it, which answers "why was *this*
 * request slow". `dbQueryDuration` aggregates it across every caller, which
 * answers "which model is slow, and since when". Measuring separately would be
 * two middlewares in the chain for one `performance.now()` pair.
 *
 * Middleware rather than the `query` log event: that event is emitted from
 * Prisma's own async context, so by the time it fires the request's
 * `AsyncLocalStorage` store is gone and the duration cannot be attributed to
 * anything. Middleware runs *inside* the caller's await chain, which is where
 * the store still is.
 *
 * On the client rather than in a Fastify hook, because the workers do not go
 * through Fastify and are where the slow queries usually are. There is exactly
 * one client, so exactly one middleware, and no double counting when `build()`
 * is called once per test file in the same process.
 *
 * Raw queries pass through here too (`params.action` is `queryRaw`), which
 * matters because the analytics aggregates -- the slowest thing this API does
 * -- are all `$queryRaw`.
 *
 * `$use` is deprecated in favour of `$extends`, but `$extends` returns a *new*
 * client with a different type, and `DB` -- which every repository accepts so
 * it can run inside a transaction -- is that type. Changing it would ripple
 * through the whole repository layer for no behavioural gain, so the deprecated
 * hook stays until the repositories need touching anyway.
 */
prisma.$use(async (params, next) => {
  const started = performance.now();
  try {
    return await next(params);
  } finally {
    const ms = performance.now() - started;
    recordDbTime(`${params.model ?? 'raw'}.${params.action}`, ms);
    // Both labels are bounded by the schema: a model name and a Prisma action.
    // Nothing user-supplied reaches a label here.
    dbQueryDuration.observe({ model: params.model ?? 'raw', operation: params.action }, ms / 1000);
  }
});

export type DB = typeof prisma;
