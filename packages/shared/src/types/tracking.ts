import type { CampaignStatus } from './campaign';

export interface TrackingLink {
  id: string;
  affiliateId: string;
  campaignId: string;
  shortCode: string;
  destinationUrl: string;
  customAlias: string | null;
  isActive: boolean;
  clickCount: number;
  conversionCount: number;
  revenue: string;
  createdAt: string;
}

export interface CachedTrackingLink {
  id: string;
  affiliateId: string;
  campaignId: string;
  destinationUrl: string;
  cookieLifetimeDays: number;
  isActive: boolean;

  /**
   * Campaign state, denormalised so the redirect service can decide what to
   * do without a second lookup.
   *
   * Optional because entries cached before this field existed are still live
   * -- the positive TTL is 24 hours. Readers must treat `undefined` as "no
   * reason to stop serving", which is what the old behaviour was.
   */
  campaignStatus?: CampaignStatus;

  /**
   * Where to send traffic when the campaign has ended. Better than the global
   * fallback: the shopper still lands on the brand rather than on a generic
   * placeholder, so the click is not wasted for anybody.
   */
  campaignLandingPageUrl?: string;
}

export interface ClickEventPayload {
  /** Set by the redirect service; see packages/analytics/src/bot-detection.ts. */
  trafficKind?: string;
  /** False for bots and for repeat clicks inside the dedup window. */
  isCounted?: boolean;
  trackingLinkId: string;
  affiliateId: string;
  campaignId: string;
  cookieId: string;
  timestamp: number;
  ip: string;
  userAgent: string;
  referrer: string;
  subIds: Record<string, string>;
  /**
   * The correlation id of the redirect request that produced the click.
   *
   * Optional because a message written by an older redirect deploy will not
   * have one, and because the worker drops it when it cannot be trusted.
   */
  requestId?: string;
}
