/**
 * Retry timing for outbound webhook delivery.
 *
 * The naive schedule -- 1s, 2s, 4s, 8s -- is worse than it looks at scale. A
 * subscriber that goes down for a minute accumulates a thousand failed
 * deliveries, every one of them computes the same delay from the same attempt
 * number, and all thousand fire at the same millisecond the moment the
 * endpoint recovers. The recovery becomes the second outage, and it is our
 * traffic that causes it. That is the thundering herd.
 *
 * Full jitter -- `random(0, base * 2^n)` rather than `base * 2^n` -- spreads
 * the same population uniformly across the whole window. The mean delay halves
 * (which is fine; the growth is still exponential) and the peak instantaneous
 * load drops by roughly the number of retries in flight, which is the part
 * that matters.
 *
 * Pure, and seeded rather than calling `Math.random`, so "two deliveries do
 * not collide" is something a test can assert instead of something we hope is
 * true.
 */

/** Attempts 1..6 give ceilings of 1s, 2s, 4s, 8s, 16s, 32s. */
export const WEBHOOK_MAX_ATTEMPTS = 6;
export const WEBHOOK_BACKOFF_BASE_MS = 1_000;

/**
 * mulberry32: a small, fast, well-distributed 32-bit PRNG.
 *
 * Chosen over `Math.random` because a seed makes the schedule reproducible in
 * tests, and over a hash of the delivery id because the caller should be free
 * to choose the seed -- the delivery id is the obvious one, but so is a
 * counter in a test.
 */
function random01(seed: number): number {
  let t = (seed + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/**
 * The un-jittered ceiling for an attempt. Exported because it is the bound the
 * jittered value is tested against, and stating it once beats restating the
 * doubling in two places.
 */
export function backoffCeilingMs(
  attempt: number,
  baseMs = WEBHOOK_BACKOFF_BASE_MS
): number {
  const clamped = Math.max(1, Math.min(attempt, WEBHOOK_MAX_ATTEMPTS));
  return baseMs * 2 ** (clamped - 1);
}

/**
 * How long to wait before attempt `attempt + 1`, given that `attempt` just
 * failed.
 *
 * Never returns zero: a delay of zero is a retry that happens inside the same
 * worker tick, which is not a retry so much as a second attempt with no
 * opportunity for the far end to have recovered.
 */
export function nextDelayMs(
  attempt: number,
  seed: number,
  baseMs = WEBHOOK_BACKOFF_BASE_MS
): number {
  const ceiling = backoffCeilingMs(attempt, baseMs);
  return Math.max(1, Math.floor(random01(seed) * ceiling));
}

/**
 * Turns a seed the caller already has -- a delivery id -- into the number the
 * PRNG wants.
 *
 * The id and the attempt are mixed together so that one delivery's successive
 * retries are independent draws. Seeding on the id alone would give a delivery
 * that drew a low value the first time a low value every time, which is a
 * subtler version of the collision this module exists to prevent.
 */
export function seedFrom(id: string, attempt: number): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash ^ Math.imul(attempt + 1, 2654435761)) >>> 0;
}
