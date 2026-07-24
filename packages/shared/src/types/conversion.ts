export type ConversionStatus = 'pending' | 'approved' | 'rejected';

export interface Conversion {
  id: string;
  trackingLinkId: string;
  campaignId: string;
  affiliateId: string;
  clickEventId: string | null;
  externalOrderId: string;
  conversionValue: string;
  commissionAmount: string;
  status: ConversionStatus;
  customerEmailHash: string | null;
  isFirstTimeCustomer: boolean;
  notes: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  occurredAt: string;
  createdAt: string;
  updatedAt: string;
}
