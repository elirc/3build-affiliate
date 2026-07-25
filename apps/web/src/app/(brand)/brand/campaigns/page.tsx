'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { DashboardShell } from '@/components/DashboardShell';
import { StatusBadge } from '@/components/CampaignStatusControls';
import { api } from '@/lib/api';
import type { CampaignStatus } from '@affiliate/shared';

const NAV = [
  { href: '/brand/dashboard', label: 'Overview' },
  { href: '/brand/campaigns', label: 'Campaigns' },
  { href: '/brand/affiliates', label: 'Affiliates' },
  { href: '/brand/conversions', label: 'Conversions' },
];

interface Campaign {
  id: string;
  name: string;
  status: CampaignStatus;
  startDate: string;
}

const FILTERS: Array<CampaignStatus | 'ALL'> = [
  'ALL',
  'DRAFT',
  'ACTIVE',
  'PAUSED',
  'ENDED',
];

export default function CampaignsPage() {
  const [status, setStatus] = useState<CampaignStatus | 'ALL'>('ALL');

  const { data, isLoading } = useQuery({
    queryKey: ['brand-campaigns', status],
    queryFn: () =>
      api<{ items: Campaign[]; total: number }>(
        `/api/brand/campaigns${status === 'ALL' ? '' : `?status=${status}`}`
      ),
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

      <div className="mt-4 flex gap-2 text-sm">
        {FILTERS.map((s) => (
          <button
            key={s}
            onClick={() => setStatus(s)}
            className={`rounded-md px-3 py-1 ${
              s === status ? 'bg-brand-600 text-white' : 'border border-gray-300'
            }`}
          >
            {s}
          </button>
        ))}
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
                  <Link
                    className="text-brand-700 hover:underline"
                    href={`/brand/campaigns/${c.id}`}
                  >
                    {c.name}
                  </Link>
                </td>
                <td className="px-4 py-3">
                  <StatusBadge status={c.status} />
                </td>
                <td className="px-4 py-3 text-sm text-gray-600">
                  {new Date(c.startDate).toLocaleDateString()}
                </td>
              </tr>
            ))}
            {data?.items?.length === 0 && (
              <tr>
                <td className="px-4 py-3 text-gray-500" colSpan={3}>
                  {status === 'ALL'
                    ? 'No campaigns yet.'
                    : `No ${status.toLowerCase()} campaigns.`}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {(data?.items ?? []).some((c) => c.status === 'DRAFT') && (
        <p className="mt-4 text-sm text-gray-600">
          Draft campaigns are invisible to affiliates. Open one and activate it to
          start recruiting.
        </p>
      )}
    </DashboardShell>
  );
}
