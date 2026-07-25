/**
 * Sub-IDs: arbitrary key/value tags an affiliate appends to a tracking link so
 * they can tell their own placements apart.
 *
 *   /r/k7m2xq9?subid=newsletter&placement=header
 *
 * They arrive from a query string on the highest-volume endpoint in the
 * system, are stored as JSON, and are echoed back into the destination URL --
 * so they are attacker-controlled input on a hot path, and they need bounds.
 */

/** Enough for real segmentation, few enough that the JSON column stays small. */
export const MAX_SUB_ID_KEYS = 5;
export const MAX_SUB_ID_KEY_LENGTH = 40;
export const MAX_SUB_ID_VALUE_LENGTH = 100;

/**
 * Reserved for our own parameters. `_ref` is the attribution cookie id we add
 * to the destination URL; letting an affiliate define `_ref` as a sub-ID would
 * let them overwrite it and break their own attribution.
 */
export const RESERVED_PREFIX = '_';

export interface NormalisedSubIds {
  subIds: Record<string, string>;
  /** Keys dropped, and why -- surfaced so a builder UI can explain itself. */
  rejected: Array<{ key: string; reason: 'reserved' | 'too_many' | 'empty' }>;
}

/**
 * Cleans a raw query object into something safe to store.
 *
 * Deterministic ordering matters: `Object.entries` follows insertion order, so
 * the same link with the same params always keeps the same five keys rather
 * than a different five depending on how the browser ordered them.
 */
export function normaliseSubIds(
  query: Record<string, unknown>
): NormalisedSubIds {
  const subIds: Record<string, string> = {};
  const rejected: NormalisedSubIds['rejected'] = [];

  for (const [rawKey, rawValue] of Object.entries(query)) {
    const key = rawKey.slice(0, MAX_SUB_ID_KEY_LENGTH);

    if (key.startsWith(RESERVED_PREFIX)) {
      rejected.push({ key, reason: 'reserved' });
      continue;
    }
    if (key.length === 0) {
      rejected.push({ key, reason: 'empty' });
      continue;
    }
    if (Object.keys(subIds).length >= MAX_SUB_ID_KEYS) {
      rejected.push({ key, reason: 'too_many' });
      continue;
    }

    // Arrays arrive when a param repeats (?a=1&a=2). Take the first rather
    // than stringifying the array into "1,2", which reads as a single value
    // nobody sent.
    const value = Array.isArray(rawValue) ? rawValue[0] : rawValue;
    if (value === undefined || value === null) continue;

    subIds[key] = String(value).slice(0, MAX_SUB_ID_VALUE_LENGTH);
  }

  return { subIds, rejected };
}

/** True when a key would be rejected, for a builder UI to check as you type. */
export function isReservedSubIdKey(key: string): boolean {
  return key.startsWith(RESERVED_PREFIX);
}

/** Builds a tagged tracking URL. Used by the link builder in the dashboard. */
export function buildTaggedUrl(
  baseUrl: string,
  subIds: Record<string, string>
): string {
  const url = new URL(baseUrl);
  for (const [k, v] of Object.entries(normaliseSubIds(subIds).subIds)) {
    url.searchParams.set(k, v);
  }
  return url.toString();
}
