'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { DashboardShell } from '@/components/DashboardShell';
import { ApiKeyPanel } from '@/components/ApiKeyPanel';
import { api } from '@/lib/api';

const NAV = [
  { href: '/brand/dashboard', label: 'Overview' },
  { href: '/brand/campaigns', label: 'Campaigns' },
  { href: '/brand/affiliates', label: 'Affiliates' },
  { href: '/brand/conversions', label: 'Conversions' },
];

export default function CampaignDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading } = useQuery({
    queryKey: ['campaign', id],
    queryFn: () => api<any>(`/api/brand/campaigns/${id}`),
  });

  if (isLoading) return <DashboardShell title="Brand" nav={NAV}>Loading…</DashboardShell>;
  if (!data) return <DashboardShell title="Brand" nav={NAV}>Not found</DashboardShell>;

  const cs = data.commissionStructure as any;

  return (
    <DashboardShell title="Brand" nav={NAV}>
      <div>
        <p className="text-xs uppercase text-gray-500">Campaign</p>
        <h1 className="text-2xl font-semibold">{data.name}</h1>
        <p className="mt-2 text-sm text-gray-600">{data.description}</p>
      </div>
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <DetailCard label="Status" value={data.status} />
        <DetailCard label="Slug" value={data.slug} />
        <DetailCard label="Attribution" value={`${data.attributionModel} / ${data.attributionWindowDays}d window`} />
        <DetailCard label="Lock period" value={`${data.lockPeriodDays} days`} />
        <DetailCard
          label="Commission"
          value={
            cs.type === 'flat_per_sale'
              ? `$${cs.flatAmount} flat`
              : cs.type === 'percentage'
              ? `${cs.percentage}%`
              : cs.type === 'recurring'
              ? `${cs.percentage}% × ${cs.recurringMonths} mo`
              : `Tiered (${cs.tiers.length})`
          }
        />
        <DetailCard label="Open enrollment" value={data.isOpen ? 'Yes' : 'No'} />
      </div>

      <ApiKeyPanel campaignId={id} />
    </DashboardShell>
  );
}

function DetailCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-white p-4 shadow-sm">
      <div className="text-xs uppercase text-gray-500">{label}</div>
      <div className="mt-2 font-medium">{value}</div>
    </div>
  );
}
