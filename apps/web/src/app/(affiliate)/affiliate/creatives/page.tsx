'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { DashboardShell } from '@/components/DashboardShell';
import { AFFILIATE_NAV } from '@/components/nav';
import { api } from '@/lib/api';

interface EligibleCampaign {
  id: string;
  name: string;
  brandName: string | null;
}

interface Creative {
  id: string;
  name: string;
  width: number | null;
  height: number | null;
  sizeBytes: number | null;
}

interface TrackingLink {
  id: string;
  shortCode: string;
  campaign: { id: string };
}

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const REDIRECT_URL = process.env.NEXT_PUBLIC_REDIRECT_URL ?? 'http://localhost:3002';

export default function CreativesPage() {
  const [campaignId, setCampaignId] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const { data: campaigns } = useQuery({
    queryKey: ['affiliate-eligible-campaigns'],
    queryFn: () => api<EligibleCampaign[]>('/api/affiliate/eligible-campaigns'),
  });

  const { data: links } = useQuery({
    queryKey: ['affiliate-links'],
    queryFn: () => api<TrackingLink[]>('/api/affiliate/links'),
  });

  const { data: creatives, isLoading } = useQuery({
    queryKey: ['affiliate-creatives', campaignId],
    queryFn: () => api<Creative[]>(`/api/affiliate/campaigns/${campaignId}/creatives`),
    enabled: campaignId !== '',
  });

  // The banner is only useful wrapped in *this* affiliate's link. Without one,
  // the snippet would send traffic that earns them nothing.
  const linkForCampaign = links?.find((l) => l.campaign.id === campaignId);

  function snippetFor(creative: Creative): string {
    const href = `${REDIRECT_URL}/r/${linkForCampaign?.shortCode ?? 'YOUR-CODE'}`;
    const src = `${API_URL}/api/creatives/${creative.id}/file`;
    const size =
      creative.width && creative.height
        ? ` width="${creative.width}" height="${creative.height}"`
        : '';
    return `<a href="${href}"><img src="${src}"${size} alt="${creative.name}"></a>`;
  }

  async function copySnippet(creative: Creative) {
    await navigator.clipboard.writeText(snippetFor(creative));
    setCopiedId(creative.id);
    setTimeout(() => setCopiedId(null), 2000);
  }

  return (
    <DashboardShell title="Affiliate" nav={AFFILIATE_NAV}>
      <h1 className="text-2xl font-semibold">Creatives</h1>
      <p className="mt-2 text-gray-600">
        Banners supplied by the brand, with your tracking link already embedded.
      </p>

      <select
        value={campaignId}
        onChange={(e) => setCampaignId(e.target.value)}
        className="mt-4 block w-full max-w-md rounded-md border-gray-300 shadow-sm"
      >
        <option value="">Choose a campaign…</option>
        {(campaigns ?? []).map((c) => (
          <option key={c.id} value={c.id}>
            {c.brandName ? `${c.brandName} — ` : ''}
            {c.name}
          </option>
        ))}
      </select>

      {campaignId !== '' && !linkForCampaign && (
        <p className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          You have no tracking link for this campaign yet, so the snippets below
          contain a placeholder.{' '}
          <Link className="underline" href="/affiliate/links">
            Create one first
          </Link>{' '}
          — a banner without your link earns you nothing.
        </p>
      )}

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        {isLoading && <p className="text-gray-500">Loading…</p>}
        {(creatives ?? []).map((c) => (
          <div key={c.id} className="rounded-lg border bg-white p-4 shadow-sm">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="font-medium">{c.name}</div>
                <div className="text-xs text-gray-500">
                  {c.width && c.height ? `${c.width}×${c.height}` : 'Unknown size'}
                  {c.sizeBytes ? ` · ${Math.round(c.sizeBytes / 1024)}KB` : ''}
                </div>
              </div>
              <button
                onClick={() => copySnippet(c)}
                className="shrink-0 rounded-md bg-brand-600 px-3 py-1.5 text-xs text-white hover:bg-brand-700"
              >
                {copiedId === c.id ? 'Copied' : 'Copy embed code'}
              </button>
            </div>

            <div className="mt-3 overflow-hidden rounded border bg-gray-50 p-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`${API_URL}/api/creatives/${c.id}/file`}
                alt={c.name}
                className="max-h-32 max-w-full object-contain"
              />
            </div>

            <pre className="mt-3 overflow-x-auto rounded bg-gray-900 p-2 text-xs text-gray-100">
              {snippetFor(c)}
            </pre>
          </div>
        ))}
        {campaignId !== '' && creatives?.length === 0 && (
          <p className="text-gray-500">
            This brand hasn’t uploaded any creatives yet.
          </p>
        )}
      </div>
    </DashboardShell>
  );
}
