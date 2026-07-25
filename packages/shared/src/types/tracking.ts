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
  trackingLinkId: string;
  affiliateId: string;
  campaignId: string;
  cookieId: string;
  timestamp: number;
  ip: string;
  userAgent: string;
  referrer: string;
  subIds: Record<string, string>;
}
