'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { DashboardShell } from '@/components/DashboardShell';
import { AnalyticsChart } from '@/components/AnalyticsChart';
import { api } from '@/lib/api';

const NAV = [
  { href: '/brand/dashboard', label: 'Overview' },
  { href: '/brand/campaigns', label: 'Campaigns' },
  { href: '/brand/affiliates', label: 'Affiliates' },
  { href: '/brand/conversions', label: 'Conversions' },
];

interface AnalyticsResponse {
  series: Array<{
    date: string;
    clicks: number;
    conversions: number;
    revenue: string;
    commission: string;
  }>;
  totals: {
    clicks: number;
    conversions: number;
    revenue: string;
    commission: string;
    conversionRate: number;
    epc: string;
  };
}

export default function BrandDashboard() {
  const [metric, setMetric] = useState<'clicks' | 'conversions' | 'revenue' | 'commission'>(
    'revenue'
  );
  const { data } = useQuery({
    queryKey: ['brand-analytics'],
    queryFn: () => api<AnalyticsResponse>('/api/brand/analytics?days=30'),
  });

  return (
    <DashboardShell title="Brand" nav={NAV}>
      <h1 className="text-2xl font-semibold">Overview</h1>
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-4">
        <Stat label="Clicks (30d)" value={data?.totals.clicks ?? '—'} />
        <Stat label="Conversions" value={data?.totals.conversions ?? '—'} />
        <Stat label="Revenue" value={data ? `$${data.totals.revenue}` : '—'} />
        <Stat label="Conv. rate" value={data ? `${data.totals.conversionRate}%` : '—'} />
      </div>
      <div className="mt-6 flex gap-2 text-sm">
        {(['clicks', 'conversions', 'revenue', 'commission'] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMetric(m)}
            className={`rounded-md px-3 py-1 ${
              m === metric ? 'bg-brand-600 text-white' : 'border border-gray-300'
            }`}
          >
            {m}
          </button>
        ))}
      </div>
      <div className="mt-4">
        {data && <AnalyticsChart series={data.series} metric={metric} />}
      </div>
    </DashboardShell>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border bg-white p-4 shadow-sm">
      <div className="text-xs uppercase text-gray-500">{label}</div>
      <div className="mt-2 text-2xl font-bold">{value}</div>
    </div>
  );
}
