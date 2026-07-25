'use client';

import { useQuery } from '@tanstack/react-query';
import { DashboardShell } from '@/components/DashboardShell';
import { AFFILIATE_NAV } from '@/components/nav';
import { api } from '@/lib/api';
import { ExportButton } from '@/components/ExportButton';

interface Summary {
  pending: string;
  locked: string;
  approved: string;
  paid: string;
}

export default function EarningsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['affiliate-summary'],
    queryFn: () => api<Summary>('/api/affiliate/earnings/summary'),
  });

  const rows = [
    ['Pending review', data?.pending ?? '0.00'],
    ['Locked', data?.locked ?? '0.00'],
    ['Available for payout', data?.approved ?? '0.00'],
    ['Paid lifetime', data?.paid ?? '0.00'],
  ];

  return (
    <DashboardShell title="Affiliate" nav={AFFILIATE_NAV}>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Earnings</h1>
        <ExportButton endpoint="/api/affiliate/commissions/export" label="Export commissions" />
      </div>
      <div className="mt-6 overflow-hidden rounded-lg border bg-white">
        <table className="min-w-full divide-y">
          <tbody className="divide-y">
            {rows.map(([label, value]) => (
              <tr key={label}>
                <td className="px-4 py-4 text-sm text-gray-600">{label}</td>
                <td className="px-4 py-4 text-right text-lg font-semibold">
                  {isLoading ? '-' : `$${value}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </DashboardShell>
  );
}
