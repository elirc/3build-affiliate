'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import {
  buildTaggedUrl,
  isReservedSubIdKey,
  MAX_SUB_ID_KEYS,
} from '@affiliate/analytics';
import { DashboardShell } from '@/components/DashboardShell';
import { AFFILIATE_NAV } from '@/components/nav';
import { api } from '@/lib/api';

interface Row {
  value: string;
  totalClicks: number;
  totalConversions: number;
  totalRevenue: string;
  totalCommission: string;
  conversionRate: number;
  epc: string;
}

interface TrackingLink {
  id: string;
  shortCode: string;
  campaign: { name: string };
}

const REDIRECT_URL = process.env.NEXT_PUBLIC_REDIRECT_URL ?? 'http://localhost:3002';

export default function SubIdsPage() {
  const [key, setKey] = useState('');

  const { data: keys } = useQuery({
    queryKey: ['subid-keys'],
    queryFn: () => api<string[]>('/api/affiliate/analytics/subids/keys'),
  });

  useEffect(() => {
    if (!key && keys && keys.length > 0) setKey(keys[0]!);
  }, [keys, key]);

  const { data: rows, isLoading } = useQuery({
    queryKey: ['subid-report', key],
    queryFn: () =>
      api<Row[]>(`/api/affiliate/analytics/subids?key=${encodeURIComponent(key)}`),
    enabled: key !== '',
  });

  return (
    <DashboardShell title="Affiliate" nav={AFFILIATE_NAV}>
      <h1 className="text-2xl font-semibold">Sub-ID performance</h1>
      <p className="mt-2 text-gray-600">
        Tags you add to your own links, so you can tell one placement from
        another.
      </p>

      <LinkBuilder />

      {keys && keys.length === 0 ? (
        <div className="mt-8 rounded-lg border bg-white p-5 text-sm text-gray-600">
          <p className="font-medium text-gray-900">No sub-IDs recorded yet.</p>
          <p className="mt-2">
            Add any <code className="rounded bg-gray-100 px-1">key=value</code> pair
            to a tracking link and it will show up here. Affiliates typically tag
            by placement (<code className="rounded bg-gray-100 px-1">subid=newsletter</code>),
            by campaign creative, or by the individual post a link appears in.
          </p>
          <p className="mt-2">
            Use the builder above, then check back once the link has traffic.
          </p>
        </div>
      ) : (
        <>
          <label className="mt-8 block max-w-xs text-sm font-medium text-gray-700">
            Group by
            <select
              value={key}
              onChange={(e) => setKey(e.target.value)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm"
            >
              {(keys ?? []).map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>

          <div className="mt-4 overflow-x-auto rounded-lg border bg-white">
            <table className="min-w-full divide-y">
              <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
                <tr>
                  <th className="px-4 py-2">{key || 'Value'}</th>
                  <th className="px-4 py-2 text-right">Clicks</th>
                  <th className="px-4 py-2 text-right">Conversions</th>
                  <th className="px-4 py-2 text-right">Conv. rate</th>
                  <th className="px-4 py-2 text-right">Revenue</th>
                  <th className="px-4 py-2 text-right">Commission</th>
                  <th className="px-4 py-2 text-right">EPC</th>
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
                {(rows ?? []).map((r) => (
                  <tr key={r.value}>
                    <td className="px-4 py-3 font-mono text-xs">{r.value}</td>
                    <td className="px-4 py-3 text-right">{r.totalClicks}</td>
                    <td className="px-4 py-3 text-right">{r.totalConversions}</td>
                    <td className="px-4 py-3 text-right">{r.conversionRate}%</td>
                    <td className="px-4 py-3 text-right">${r.totalRevenue}</td>
                    <td className="px-4 py-3 text-right">${r.totalCommission}</td>
                    <td className="px-4 py-3 text-right">
                      {r.totalClicks > 0 ? `$${r.epc}` : '—'}
                    </td>
                  </tr>
                ))}
                {rows?.length === 0 && (
                  <tr>
                    <td className="px-4 py-3 text-gray-500" colSpan={7}>
                      No traffic tagged with this key yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </DashboardShell>
  );
}

function LinkBuilder() {
  const [linkId, setLinkId] = useState('');
  const [pairs, setPairs] = useState<Array<[string, string]>>([['subid', '']]);
  const [copied, setCopied] = useState(false);

  const { data: links } = useQuery({
    queryKey: ['affiliate-links'],
    queryFn: () => api<TrackingLink[]>('/api/affiliate/links'),
  });

  const link = links?.find((l) => l.id === linkId);
  const tagged = link
    ? buildTaggedUrl(
        `${REDIRECT_URL}/r/${link.shortCode}`,
        Object.fromEntries(pairs.filter(([k, v]) => k && v))
      )
    : '';

  const reserved = pairs.filter(([k]) => k && isReservedSubIdKey(k)).map(([k]) => k);

  return (
    <section className="mt-6 max-w-2xl rounded-lg border bg-white p-5">
      <h2 className="font-semibold">Build a tagged link</h2>

      <label className="mt-3 block text-sm font-medium text-gray-700">
        Tracking link
        <select
          value={linkId}
          onChange={(e) => setLinkId(e.target.value)}
          className="mt-1 block w-full rounded-md border-gray-300 shadow-sm"
        >
          <option value="">Choose a link…</option>
          {(links ?? []).map((l) => (
            <option key={l.id} value={l.id}>
              {l.campaign.name} — /r/{l.shortCode}
            </option>
          ))}
        </select>
      </label>

      {links?.length === 0 && (
        <p className="mt-2 text-sm text-gray-600">
          You have no tracking links yet.{' '}
          <Link className="text-brand-700 underline" href="/affiliate/links">
            Create one first
          </Link>
          .
        </p>
      )}

      <div className="mt-3 space-y-2">
        {pairs.map(([k, v], i) => (
          <div key={i} className="flex gap-2">
            <input
              value={k}
              onChange={(e) =>
                setPairs(pairs.map((p, j) => (j === i ? [e.target.value, p[1]] : p)))
              }
              placeholder="key"
              className="w-40 rounded-md border-gray-300 shadow-sm"
            />
            <input
              value={v}
              onChange={(e) =>
                setPairs(pairs.map((p, j) => (j === i ? [p[0], e.target.value] : p)))
              }
              placeholder="value"
              className="flex-1 rounded-md border-gray-300 shadow-sm"
            />
            <button
              type="button"
              onClick={() => setPairs(pairs.filter((_, j) => j !== i))}
              className="text-xs text-red-600 hover:underline"
            >
              Remove
            </button>
          </div>
        ))}
      </div>

      {pairs.length < MAX_SUB_ID_KEYS && (
        <button
          type="button"
          onClick={() => setPairs([...pairs, ['', '']])}
          className="mt-2 text-xs text-brand-700 hover:underline"
        >
          Add tag
        </button>
      )}

      {reserved.length > 0 && (
        <p className="mt-2 text-xs text-amber-700">
          {reserved.join(', ')} {reserved.length === 1 ? 'starts' : 'start'} with an
          underscore, which is reserved for our own parameters and will be dropped.
          {' '}
          <code className="rounded bg-gray-100 px-1">_ref</code> in particular carries
          your attribution, so overwriting it would break your own tracking.
        </p>
      )}

      {tagged && (
        <div className="mt-3">
          <pre className="overflow-x-auto rounded bg-gray-900 p-2 text-xs text-gray-100">
            {tagged}
          </pre>
          <button
            type="button"
            onClick={async () => {
              await navigator.clipboard.writeText(tagged);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}
            className="mt-2 rounded-md bg-brand-600 px-3 py-1.5 text-xs text-white hover:bg-brand-700"
          >
            {copied ? 'Copied' : 'Copy link'}
          </button>
        </div>
      )}
    </section>
  );
}
