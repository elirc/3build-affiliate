'use client';

import { useQuery } from '@tanstack/react-query';
import { DashboardShell } from '@/components/DashboardShell';
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
    <DashboardShell title="Affiliate" nav={NAV}>
      <h1 className="text-2xl font-semibold">Earnings</h1>
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
