import { z } from 'zod';
import { MAX_REQUEST_ID_LENGTH } from '../utils/request-id';

/**
 * Validation for messages taken off the click queue.
 *
 * The worker used to `JSON.parse(raw)` and cast the result to
 * `ClickEventPayload`. That type was a claim, not a check -- and the claim
 * stops being true the moment anything other than our redirect service writes
 * to the list: an older deploy with a different shape, a replayed message from
 * a previous schema, a test, or a mistake.
 *
 * This is the same argument the worker already made about capping sub-IDs at
 * the consumer as well as the producer ("it does not know who wrote to it"),
 * applied to the rest of the payload rather than to one field.
 */
export const clickEventPayloadSchema = z.object({
  trackingLinkId: z.string().min(1).max(64),
  affiliateId: z.string().min(1).max(64),
  campaignId: z.string().min(1).max(64),
  cookieId: z.string().min(1).max(128),

  /**
   * Epoch milliseconds. Bounded on both sides: a timestamp before 2020 or far
   * in the future is a unit mistake (seconds passed as milliseconds is the
   * classic one) rather than a real click, and it would quietly corrupt every
   * time-bucketed report it landed in.
   */
  timestamp: z
    .number()
    .int()
    .min(1_577_836_800_000)
    .max(4_102_444_800_000),

  ip: z.string().max(128),
  userAgent: z.string().max(1000),
  referrer: z.string().max(2000),

  subIds: z.record(z.string(), z.string()).default({}),
  trafficKind: z.string().max(32).optional(),
  isCounted: z.boolean().optional(),

  /**
   * The correlation id of the redirect request that produced this click.
   *
   * Bounded but deliberately *not* pattern-checked here. A message whose
   * correlation id is unusable is still a real click and someone is owed money
   * for it -- rejecting the whole event over a debugging aid would be a worse
   * bug than the one the id exists to help diagnose. The consumer sanitises it
   * and drops it if it cannot be trusted; see the worker.
   */
  requestId: z.string().max(MAX_REQUEST_ID_LENGTH).optional(),
});

export type ClickEventPayloadInput = z.infer<typeof clickEventPayloadSchema>;
