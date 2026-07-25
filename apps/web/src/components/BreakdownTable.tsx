'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { api } from '@/lib/api';

interface Row {
  totalClicks: number;
  totalConversions: number;
  totalRevenue: string;
  totalCommission: string;
  conversionRate: number;
  epc?: string;
  campaignId?: string;
  campaignName?: string;
  affiliateId?: string;
  affiliateName?: string;
  shortCode?: string;
  linkId?: string;
}

type SortKey = 'clicks' | 'conversions' | 'revenue' | 'commission' | 'name';

const COLUMNS: Array<{ key: SortKey | null; label: string; numeric?: boolean }> = [
  { key: 'name', label: 'Name' },
  { key: 'clicks', label: 'Clicks', numeric: true },
  { key: 'conversions', label: 'Conversions', numeric: true },
  { key: null, label: 'Conv. rate', numeric: true },
  { key: 'revenue', label: 'Revenue', numeric: true },
  { key: 'commission', label: 'Commission', numeric: true },
  { key: null, label: 'EPC', numeric: true },
];

export function BreakdownTable({
  title,
  endpoint,
  queryKey,
  days = 30,
  linkTo,
}: {
  title: string;
  endpoint: string;
  queryKey: string;
  days?: number;
  linkTo?: (row: Row) => string | null;
}) {
  const [sort, setSort] = useState<SortKey>('revenue');
  const [direction, setDirection] = useState<'asc' | 'desc'>('desc');
  const [includePending, setIncludePending] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: [queryKey, days, sort, direction, includePending],
    queryFn: () =>
      api<Row[]>(
        `${endpoint}?days=${days}&sort=${sort}&direction=${direction}` +
          `&includePending=${includePending}`
      ),
  });

  function toggle(key: SortKey) {
    if (key === sort) setDirection(direction === 'desc' ? 'asc' : 'desc');
    else {
      setSort(key);
      setDirection('desc');
    }
  }

  return (
    <section className="mt-8">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">{title}</h2>
        <label className="flex items-center gap-2 text-sm text-gray-600">
          <input
            type="checkbox"
            checked={includePending}
            onChange={(e) => setIncludePending(e.target.checked)}
          />
          {/* Named rather than "include pending": the distinction between
              money booked and money confirmed is the most common support
              question in an affiliate programme. */}
          Include unreviewed sales (booked, not yet confirmed)
        </label>
      </div>

      <div className="mt-3 overflow-x-auto rounded-lg border bg-white">
        <table className="min-w-full divide-y">
          <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
            <tr>
              {COLUMNS.map((c) => (
                <th
                  key={c.label}
                  className={`px-4 py-2 ${c.numeric ? 'text-right' : ''}`}
                >
                  {c.key ? (
                    <button
                      onClick={() => toggle(c.key!)}
                      className="hover:text-gray-900"
                    >
                      {c.label}
                      {sort === c.key ? (direction === 'desc' ? ' ↓' : ' ↑') : ''}
                    </button>
                  ) : (
                    // Derived columns are not sortable, because sorting has to
                    // happen in SQL and these are computed after the query.
                    c.label
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading && (
              <tr>
                <td className="px-4 py-3 text-gray-500" colSpan={COLUMNS.length}>
                  Loading…
                </td>
              </tr>
            )}
            {(data ?? []).map((r, i) => {
              const name =
                r.campaignName ?? r.affiliateName ?? r.shortCode ?? 'Unknown';
              const href = linkTo?.(r) ?? null;
              return (
                <tr key={r.campaignId ?? r.affiliateId ?? r.linkId ?? i}>
                  <td className="px-4 py-3">
                    {href ? (
                      <Link className="text-brand-700 hover:underline" href={href}>
                        {name}
                      </Link>
                    ) : (
                      name
                    )}
                    {r.shortCode && r.campaignName && (
                      <div className="text-xs text-gray-500">{r.campaignName}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">{r.totalClicks}</td>
                  <td className="px-4 py-3 text-right">{r.totalConversions}</td>
                  <td className="px-4 py-3 text-right">{r.conversionRate}%</td>
                  <td className="px-4 py-3 text-right">${r.totalRevenue}</td>
                  <td className="px-4 py-3 text-right">${r.totalCommission}</td>
                  <td className="px-4 py-3 text-right">
                    {/* An em dash, not $0.00, with no clicks: "earns nothing"
                        and "we don't know yet" are different claims. */}
                    {r.totalClicks > 0 ? `$${r.epc ?? '0.00'}` : '—'}
                  </td>
                </tr>
              );
            })}
            {data?.length === 0 && (
              <tr>
                <td className="px-4 py-3 text-gray-500" colSpan={COLUMNS.length}>
                  Nothing in this period.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
