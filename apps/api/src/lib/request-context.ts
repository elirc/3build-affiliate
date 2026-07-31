import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * What every log line written during a request should be able to say about
 * itself without being told.
 */
export interface RequestContext {
  requestId: string;
  /** Filled in by `requireAuth` once the token has actually been verified. */
  userId?: string;
  /**
   * The route *pattern*, never the resolved path. See `lib/metrics.ts` for
   * why the distinction is not cosmetic.
   */
  route?: string;
}

/**
 * Request-scoped state, without threading it through every signature.
 *
 * The alternative -- passing a `requestId` as a parameter -- reaches the
 * repositories only if every service in between remembers to forward it, and
 * the one that forgets is the one you need during an incident. `AsyncLocalStorage`
 * binds the value at the request boundary and every `await` downstream inherits
 * it, including inside a Prisma hook and inside a worker replaying a message.
 *
 * The store object is mutated in place rather than replaced, because code
 * already running inside `run()` holds a reference to it: `updateContext` after
 * authentication has to be visible to the handler that is mid-flight, not only
 * to whatever starts afterwards.
 */
const storage = new AsyncLocalStorage<RequestContext>();

export function newRequestId(): string {
  return randomUUID();
}

/**
 * Binds `context` for `fn` and everything it awaits.
 *
 * Used from a Fastify `onRequest` hook as `runWithContext(ctx, done)`: `done`
 * continues the hook chain synchronously from inside the `run()` frame, so the
 * handler's first `await` captures this store. `enterWith` would look simpler
 * and is the wrong tool -- it mutates the *current* async context, which on a
 * keep-alive connection is shared with the next request on the same socket.
 */
export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getContext(): RequestContext | undefined {
  return storage.getStore();
}

export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/**
 * Adds to the live context. A no-op outside a request, so a service called
 * from a script or a test does not have to care.
 */
export function updateContext(patch: Partial<RequestContext>): void {
  const store = storage.getStore();
  if (!store) return;
  Object.assign(store, patch);
}

/**
 * The fields merged into every log record; see `lib/logger.ts`.
 *
 * Here rather than next to the logger so it can be unit tested without pulling
 * in pino and the validated environment. Outside a request the store is empty
 * and nothing is added, which is what keeps a worker tick or a startup line
 * from claiming a request id it does not have.
 */
export function contextLogFields(): Record<string, string> {
  const ctx = storage.getStore();
  if (!ctx) return {};

  const fields: Record<string, string> = { requestId: ctx.requestId };
  if (ctx.userId) fields.userId = ctx.userId;
  if (ctx.route) fields.route = ctx.route;
  return fields;
}
