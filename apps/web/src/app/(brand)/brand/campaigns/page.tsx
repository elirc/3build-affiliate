'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { DashboardShell } from '@/components/DashboardShell';
import { api } from '@/lib/api';

const NAV = [
  { href: '/brand/dashboard', label: 'Overview' },
  { href: '/brand/campaigns', label: 'Campaigns' },
  { href: '/brand/affiliates', label: 'Affiliates' },
  { href: '/brand/conversions', label: 'Conversions' },
];

interface Campaign {
  id: string;
  name: string;
  status: string;
  startDate: string;
}

export default function CampaignsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['brand-campaigns'],
    queryFn: () =>
      api<{ items: Campaign[]; total: number }>('/api/brand/campaigns'),
  });

  return (
    <DashboardShell title="Brand" nav={NAV}>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Campaigns</h1>
        <Link
          href="/brand/campaigns/new"
          className="rounded-md bg-brand-600 px-3 py-2 text-sm text-white hover:bg-brand-700"
        >
          New campaign
        </Link>
      </div>
      <div className="mt-6 overflow-hidden rounded-lg border bg-white">
        <table className="min-w-full divide-y">
          <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
            <tr>
              <th className="px-4 py-2">Name</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Starts</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading && (
              <tr>
                <td className="px-4 py-3 text-gray-500" colSpan={3}>
                  Loading…
                </td>
              </tr>
            )}
            {(data?.items ?? []).map((c) => (
              <tr key={c.id}>
                <td className="px-4 py-3">
                  <Link className="text-brand-700 hover:underline" href={`/brand/campaigns/${c.id}`}>
                    {c.name}
                  </Link>
                </td>
                <td className="px-4 py-3 text-sm">{c.status}</td>
                <td className="px-4 py-3 text-sm text-gray-600">
                  {new Date(c.startDate).toLocaleDateString()}
                </td>
              </tr>
            ))}
            {data?.items?.length === 0 && (
              <tr>
                <td className="px-4 py-3 text-gray-500" colSpan={3}>
                  No campaigns yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </DashboardShell>
  );
}
