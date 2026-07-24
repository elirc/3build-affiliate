import type { AttributionModel } from '@affiliate/shared';

export interface AttributionClick {
  trackingLinkId: string;
  affiliateId: string;
  timestamp: number;
}

export interface AttributionShare {
  trackingLinkId: string;
  affiliateId: string;
  share: number;
}

/**
 * Decide which click(s) to attribute a conversion to, given a model and the
 * ordered list of clicks within the attribution window.
 *
 * - first_click: 100% to the earliest click
 * - last_click: 100% to the most recent click
 * - linear: equal share across all unique tracking links
 */
export function attribute(
  model: AttributionModel,
  clicks: AttributionClick[]
): AttributionShare[] {
  if (clicks.length === 0) return [];
  const sorted = [...clicks].sort((a, b) => a.timestamp - b.timestamp);

  if (model === 'FIRST_CLICK') {
    const c = sorted[0]!;
    return [{ trackingLinkId: c.trackingLinkId, affiliateId: c.affiliateId, share: 1 }];
  }
  if (model === 'LAST_CLICK') {
    const c = sorted[sorted.length - 1]!;
    return [{ trackingLinkId: c.trackingLinkId, affiliateId: c.affiliateId, share: 1 }];
  }
  const dedup = new Map<string, AttributionClick>();
  for (const c of sorted) dedup.set(c.trackingLinkId, c);
  const unique = [...dedup.values()];
  const share = 1 / unique.length;
  return unique.map((c) => ({
    trackingLinkId: c.trackingLinkId,
    affiliateId: c.affiliateId,
    share,
  }));
}
