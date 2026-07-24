export type CampaignStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'ENDED';
export type AttributionModel = 'FIRST_CLICK' | 'LAST_CLICK' | 'LINEAR';

export type CommissionType =
  | 'flat_per_sale'
  | 'percentage'
  | 'tiered_percentage'
  | 'recurring';

export interface FlatCommission {
  type: 'flat_per_sale';
  flatAmount: number;
}

export interface PercentageCommission {
  type: 'percentage';
  percentage: number;
  minCommission?: number;
  maxCommission?: number;
}

export interface TieredCommissionTier {
  minSales: number;
  percentage: number;
}

export interface TieredCommission {
  type: 'tiered_percentage';
  tiers: TieredCommissionTier[];
}

export interface RecurringCommission {
  type: 'recurring';
  percentage: number;
  recurringMonths: number;
}

export type CommissionStructure =
  | FlatCommission
  | PercentageCommission
  | TieredCommission
  | RecurringCommission;

export interface Campaign {
  id: string;
  brandId: string;
  name: string;
  description: string | null;
  slug: string;
  landingPageUrl: string;
  allowedDomains: string[];
  status: CampaignStatus;
  commissionStructure: CommissionStructure;
  attributionModel: AttributionModel;
  attributionWindowDays: number;
  cookieLifetimeDays: number;
  lockPeriodDays: number;
  isOpen: boolean;
  startDate: string;
  endDate: string | null;
  createdAt: string;
  updatedAt: string;
}
