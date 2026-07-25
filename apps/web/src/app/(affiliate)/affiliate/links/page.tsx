'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { DashboardShell } from '@/components/DashboardShell';
import { AFFILIATE_NAV } from '@/components/nav';
import { api } from '@/lib/api';

interface TrackingLink {
  id: string;
  shortCode: string;
  destinationUrl: string;
  clickCount: number;
  conversionCount: number;
  revenue: string;
  isActive: boolean;
  campaign: { id: string; name: string };
}

interface EligibleCampaign {
  id: string;
  name: string;
  brandName: string | null;
  allowedDomains: string[];
  landingPageUrl: string;
  commissionSummary: string;
}

/**
 * Mirrors the server's rule in `trackingService.create`: the destination
 * hostname must equal an allowed domain or be a subdomain of one. Warning
 * before submit is friendlier than a rejected request, but the server stays
 * the authority -- this is a hint, not a check.
 */
function destinationIsAllowed(url: string, allowedDomains: string[]): boolean {
  try {
    const host = new URL(url).hostname;
    return allowedDomains.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

export default function LinksPage() {
  const qc = useQueryClient();
  const redirectBase =
    process.env.NEXT_PUBLIC_REDIRECT_URL ?? 'http://localhost:3002';

  const [showForm, setShowForm] = useState(false);
  const [campaignId, setCampaignId] = useState('');
  const [destinationUrl, setDestinationUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const { data: links, isLoading } = useQuery({
    queryKey: ['affiliate-links'],
    queryFn: () => api<TrackingLink[]>('/api/affiliate/links'),
  });

  const { data: eligible } = useQuery({
    queryKey: ['affiliate-eligible-campaigns'],
    queryFn: () => api<EligibleCampaign[]>('/api/affiliate/eligible-campaigns'),
  });

  const selected = eligible?.find((c) => c.id === campaignId);
  const destinationWarning =
    selected && destinationUrl !== '' &&
    !destinationIsAllowed(destinationUrl, selected.allowedDomains)
      ? `This brand only allows links to: ${selected.allowedDomains.join(', ')}`
      : null;

  const create = useMutation({
    mutationFn: () =>
      api<TrackingLink>('/api/affiliate/links', {
        method: 'POST',
        body: JSON.stringify({ campaignId, destinationUrl }),
      }),
    onSuccess: async () => {
      setShowForm(false);
      setCampaignId('');
      setDestinationUrl('');
      setError(null);
      await qc.invalidateQueries({ queryKey: ['affiliate-links'] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const toggle = useMutation({
    mutationFn: (vars: { id: string; isActive: boolean }) =>
      api(`/api/affiliate/links/${vars.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: vars.isActive }),
      }),
    // Optimistic: flipping a switch should feel instant. Rolled back on error.
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: ['affiliate-links'] });
      const previous = qc.getQueryData<TrackingLink[]>(['affiliate-links']);
      qc.setQueryData<TrackingLink[]>(['affiliate-links'], (old) =>
        (old ?? []).map((l) =>
          l.id === vars.id ? { ...l, isActive: vars.isActive } : l
        )
      );
      return { previous };
    },
    onError: (err: Error, _vars, context) => {
      qc.setQueryData(['affiliate-links'], context?.previous);
      setError(err.message);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['affiliate-links'] }),
  });

  async function copy(link: TrackingLink) {
    await navigator.clipboard.writeText(`${redirectBase}/r/${link.shortCode}`);
    setCopiedId(link.id);
    setTimeout(() => setCopiedId(null), 2000);
  }

  return (
    <DashboardShell title="Affiliate" nav={AFFILIATE_NAV}>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Tracking Links</h1>
        <button
          onClick={() => setShowForm((s) => !s)}
          className="rounded-md bg-brand-600 px-3 py-2 text-sm text-white hover:bg-brand-700"
        >
          {showForm ? 'Cancel' : 'New link'}
        </button>
      </div>

      {showForm && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
          className="mt-4 max-w-2xl space-y-4 rounded-lg border bg-white p-5"
        >
          {eligible?.length === 0 ? (
            <p className="text-sm text-gray-600">
              You are not approved for any active campaigns yet. Browse{' '}
              <Link className="text-brand-700 underline" href="/programs">
                open programs
              </Link>{' '}
              and apply to a brand first.
            </p>
          ) : (
            <>
              <label className="block">
                <span className="block text-sm font-medium text-gray-700">
                  Campaign
                </span>
                <select
                  required
                  value={campaignId}
                  onChange={(e) => setCampaignId(e.target.value)}
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm"
                >
                  <option value="">Choose a campaign…</option>
                  {(eligible ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.brandName ? `${c.brandName} — ` : ''}
                      {c.name} ({c.commissionSummary})
                    </option>
                  ))}
                </select>
              </label>

              <label className="block">
                <span className="block text-sm font-medium text-gray-700">
                  Destination URL
                </span>
                <input
                  type="url"
                  required
                  value={destinationUrl}
                  onChange={(e) => setDestinationUrl(e.target.value)}
                  placeholder={selected?.landingPageUrl ?? 'https://…'}
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm"
                />
                {selected && (
                  <span className="mt-1 block text-xs text-gray-500">
                    Allowed: {selected.allowedDomains.join(', ')}
                  </span>
                )}
                {destinationWarning && (
                  <span className="mt-1 block text-xs text-amber-700">
                    {destinationWarning}
                  </span>
                )}
              </label>

              <button
                type="submit"
                disabled={create.isPending || campaignId === ''}
                className="rounded-md bg-brand-600 px-4 py-2 text-sm text-white hover:bg-brand-700 disabled:opacity-50"
              >
                {create.isPending ? 'Creating…' : 'Create link'}
              </button>
            </>
          )}
        </form>
      )}

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      <div className="mt-6 overflow-x-auto rounded-lg border bg-white">
        <table className="min-w-full divide-y">
          <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
            <tr>
              <th className="px-4 py-2">Campaign</th>
              <th className="px-4 py-2">Short URL</th>
              <th className="px-4 py-2">Clicks</th>
              <th className="px-4 py-2">Conversions</th>
              <th className="px-4 py-2">EPC</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading && (
              <tr>
                <td className="px-4 py-3 text-gray-500" colSpan={7}>
                  Loading…
                </td>
              </tr>
            )}
            {(links ?? []).map((l) => (
              <tr key={l.id}>
                <td className="px-4 py-3">{l.campaign.name}</td>
                <td className="px-4 py-3 font-mono text-xs">
                  {redirectBase}/r/{l.shortCode}
                </td>
                <td className="px-4 py-3">{l.clickCount}</td>
                <td className="px-4 py-3">{l.conversionCount}</td>
                <td className="px-4 py-3">
                  {/* An em dash rather than $0.00 when there are no clicks: a
                      zero EPC reads as "this link earns nothing", which is a
                      different claim from "we don't know yet". */}
                  {l.clickCount > 0
                    ? `$${(Number(l.revenue) / l.clickCount).toFixed(2)}`
                    : '—'}
                </td>
                <td className="px-4 py-3 text-sm">
                  {l.isActive ? 'Active' : 'Paused'}
                </td>
                <td className="px-4 py-3">
                  <div className="flex justify-end gap-2">
                    <button
                      onClick={() => copy(l)}
                      className="rounded-md border border-gray-300 px-3 py-1 text-xs hover:bg-gray-50"
                    >
                      {copiedId === l.id ? 'Copied' : 'Copy'}
                    </button>
                    <button
                      onClick={() => toggle.mutate({ id: l.id, isActive: !l.isActive })}
                      className="rounded-md border border-gray-300 px-3 py-1 text-xs hover:bg-gray-50"
                    >
                      {l.isActive ? 'Pause' : 'Resume'}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {links?.length === 0 && (
              <tr>
                <td className="px-4 py-3 text-gray-500" colSpan={7}>
                  No tracking links yet. Use “New link” to create your first one.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </DashboardShell>
  );
}
