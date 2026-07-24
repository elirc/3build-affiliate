export type PayoutStatus =
  | 'pending'
  | 'processing'
  | 'paid'
  | 'failed'
  | 'cancelled';

export type PayoutMethod = 'stripe_connect' | 'paypal' | 'manual';

export interface Payout {
  id: string;
  affiliateId: string;
  amount: string;
  feeAmount: string;
  netAmount: string;
  currency: string;
  method: PayoutMethod;
  status: PayoutStatus;
  stripeTransferId: string | null;
  failureReason: string | null;
  periodStart: string;
  periodEnd: string;
  paidAt: string | null;
  createdAt: string;
}
