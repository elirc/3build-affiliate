export interface DailyMetric {
  date: string;
  clicks: number;
  conversions: number;
  revenue: string;
  commission: string;
}

export interface CampaignSummary {
  campaignId: string;
  campaignName: string;
  totalClicks: number;
  totalConversions: number;
  totalRevenue: string;
  totalCommission: string;
  conversionRate: number;
  epc: string;
}

export interface AffiliateSummary {
  affiliateId: string;
  affiliateName: string;
  totalClicks: number;
  totalConversions: number;
  totalRevenue: string;
  totalCommission: string;
  conversionRate: number;
}
