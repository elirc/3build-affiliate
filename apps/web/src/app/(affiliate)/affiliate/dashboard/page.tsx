'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { DashboardShell } from '@/components/DashboardShell';
import { AnalyticsChart } from '@/components/AnalyticsChart';
import { api } from '@/lib/api';

const NAV = [
  { href: '/affiliate/dashboard', label: 'Overview' },
  { href: '/affiliate/applications', label: 'My Applications' },
  { href: '/affiliate/links', label: 'Tracking Links' },
  { href: '/affiliate/earnings', label: 'Earnings' },
  { href: '/affiliate/payouts', label: 'Payouts' },
];

interface Summary {
  pending: string;
  locked: string;
  approved: string;
  paid: string;
}

interface AnalyticsResponse {
  series: Array<{
    date: string;
    clicks: number;
    conversions: number;
    revenue: string;
    commission: string;
  }>;
  totals: { clicks: number; conversions: number; revenue: string; commission: string };
}

export default function AffiliateDashboard() {
  const [metric, setMetric] = useState<'clicks' | 'conversions' | 'commission'>('commission');
  const { data: summary } = useQuery({
    queryKey: ['affiliate-summary'],
    queryFn: () => api<Summary>('/api/affiliate/earnings/summary'),
  });
  const { data: analytics } = useQuery({
    queryKey: ['affiliate-analytics'],
    queryFn: () => api<AnalyticsResponse>('/api/affiliate/analytics?days=30'),
  });

  const cards = [
    { label: 'Pending', value: summary?.pending ?? '—' },
    { label: 'Locked', value: summary?.locked ?? '—' },
    { label: 'Approved', value: summary?.approved ?? '—' },
    { label: 'Paid', value: summary?.paid ?? '—' },
  ];

  return (
    <DashboardShell title="Affiliate" nav={NAV}>
      <h1 className="text-2xl font-semibold">Overview</h1>
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-4">
        {cards.map((c) => (
          <div key={c.label} className="rounded-lg border bg-white p-4 shadow-sm">
            <div className="text-xs uppercase text-gray-500">{c.label}</div>
            <div className="mt-2 text-2xl font-bold">${c.value}</div>
          </div>
        ))}
      </div>
      <div className="mt-6 flex gap-2 text-sm">
        {(['clicks', 'conversions', 'commission'] as const).map((m) => (
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
        {analytics && <AnalyticsChart series={analytics.series} metric={metric} />}
      </div>
    </DashboardShell>
  );
}
