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
