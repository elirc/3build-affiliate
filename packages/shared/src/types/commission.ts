export type CommissionStatus =
  | 'pending'
  | 'locked'
  | 'approved'
  | 'included_in_payout'
  | 'paid'
  | 'rejected'
  | 'clawed_back';

export interface Commission {
  id: string;
  affiliateId: string;
  campaignId: string;
  conversionId: string;
  amount: string;
  status: CommissionStatus;
  lockExpiresAt: string | null;
  approvedAt: string | null;
  paidAt: string | null;
  payoutId: string | null;
  createdAt: string;
  updatedAt: string;
}
