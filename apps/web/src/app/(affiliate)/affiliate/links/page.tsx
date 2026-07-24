'use client';

import { useQuery } from '@tanstack/react-query';
import { DashboardShell } from '@/components/DashboardShell';
import { api } from '@/lib/api';

const NAV = [
  { href: '/affiliate/dashboard', label: 'Overview' },
  { href: '/affiliate/links', label: 'Tracking Links' },
  { href: '/affiliate/earnings', label: 'Earnings' },
  { href: '/affiliate/payouts', label: 'Payouts' },
];

interface TrackingLink {
  id: string;
  shortCode: string;
  destinationUrl: string;
  clickCount: number;
  conversionCount: number;
  isActive: boolean;
  campaign: { id: string; name: string };
}

export default function LinksPage() {
  const redirectBase =
    process.env.NEXT_PUBLIC_REDIRECT_URL ?? 'http://localhost:3002';
  const { data, isLoading } = useQuery({
    queryKey: ['affiliate-links'],
    queryFn: () => api<TrackingLink[]>('/api/affiliate/links'),
  });

  return (
    <DashboardShell title="Affiliate" nav={NAV}>
      <h1 className="text-2xl font-semibold">Tracking Links</h1>
      <div className="mt-6 overflow-hidden rounded-lg border bg-white">
        <table className="min-w-full divide-y">
          <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
            <tr>
              <th className="px-4 py-2">Campaign</th>
              <th className="px-4 py-2">Short URL</th>
              <th className="px-4 py-2">Clicks</th>
              <th className="px-4 py-2">Conversions</th>
              <th className="px-4 py-2">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading && (
              <tr>
                <td className="px-4 py-3 text-gray-500" colSpan={5}>
                  Loading…
                </td>
              </tr>
            )}
            {(data ?? []).map((l) => (
              <tr key={l.id}>
                <td className="px-4 py-3">{l.campaign.name}</td>
                <td className="px-4 py-3 font-mono text-xs">
                  {redirectBase}/r/{l.shortCode}
                </td>
                <td className="px-4 py-3">{l.clickCount}</td>
                <td className="px-4 py-3">{l.conversionCount}</td>
                <td className="px-4 py-3 text-sm">
                  {l.isActive ? 'Active' : 'Paused'}
                </td>
              </tr>
            ))}
            {data?.length === 0 && (
              <tr>
                <td className="px-4 py-3 text-gray-500" colSpan={5}>
                  No tracking links yet. Apply to a program first.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </DashboardShell>
  );
}
