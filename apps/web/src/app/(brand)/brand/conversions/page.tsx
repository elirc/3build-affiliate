'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DashboardShell } from '@/components/DashboardShell';
import { api } from '@/lib/api';

const NAV = [
  { href: '/brand/dashboard', label: 'Overview' },
  { href: '/brand/campaigns', label: 'Campaigns' },
  { href: '/brand/affiliates', label: 'Affiliates' },
  { href: '/brand/conversions', label: 'Conversions' },
];

interface Conversion {
  id: string;
  externalOrderId: string;
  conversionValue: string;
  commissionAmount: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  occurredAt: string;
  campaign: { id: string; name: string };
  affiliate: { id: string; firstName: string; lastName: string; email: string };
}

export default function BrandConversionsPage() {
  const [status, setStatus] = useState<'PENDING' | 'APPROVED' | 'REJECTED' | 'ALL'>('PENDING');
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['brand-conversions', status],
    queryFn: () =>
      api<Conversion[]>(
        `/api/brand/conversions${status === 'ALL' ? '' : `?status=${status}`}`
      ),
  });

  const review = useMutation({
    mutationFn: (vars: { id: string; status: 'approved' | 'rejected'; reason?: string }) =>
      api(`/api/brand/conversions/${vars.id}/review`, {
        method: 'POST',
        body: JSON.stringify({ status: vars.status, reason: vars.reason }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['brand-conversions'] }),
  });

  return (
    <DashboardShell title="Brand" nav={NAV}>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Conversions</h1>
        <div className="flex gap-2 text-sm">
          {(['PENDING', 'APPROVED', 'REJECTED', 'ALL'] as const).map((s) => (
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
      </div>

      <div className="mt-6 overflow-hidden rounded-lg border bg-white">
        <table className="min-w-full divide-y">
          <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
            <tr>
              <th className="px-4 py-2">Order</th>
              <th className="px-4 py-2">Affiliate</th>
              <th className="px-4 py-2">Campaign</th>
              <th className="px-4 py-2">Value</th>
              <th className="px-4 py-2">Commission</th>
              <th className="px-4 py-2">When</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading && (
              <tr>
                <td className="px-4 py-3 text-gray-500" colSpan={8}>
                  Loading…
                </td>
              </tr>
            )}
            {(data ?? []).map((c) => (
              <tr key={c.id}>
                <td className="px-4 py-3 font-mono text-xs">{c.externalOrderId}</td>
                <td className="px-4 py-3 text-sm">
                  {c.affiliate.firstName} {c.affiliate.lastName}
                </td>
                <td className="px-4 py-3 text-sm">{c.campaign.name}</td>
                <td className="px-4 py-3 text-sm">${c.conversionValue}</td>
                <td className="px-4 py-3 text-sm">${c.commissionAmount}</td>
                <td className="px-4 py-3 text-sm text-gray-600">
                  {new Date(c.occurredAt).toLocaleString()}
                </td>
                <td className="px-4 py-3 text-sm">{c.status}</td>
                <td className="px-4 py-3 text-right">
                  {c.status === 'PENDING' && (
                    <div className="flex justify-end gap-2">
                      <button
                        onClick={() => review.mutate({ id: c.id, status: 'approved' })}
                        className="rounded-md bg-brand-600 px-3 py-1 text-xs text-white hover:bg-brand-700"
                      >
                        Approve
                      </button>
                      <button
                        onClick={() => {
                          const reason = prompt('Reason for rejecting?');
                          if (reason !== null)
                            review.mutate({ id: c.id, status: 'rejected', reason });
                        }}
                        className="rounded-md border border-gray-300 px-3 py-1 text-xs hover:bg-gray-50"
                      >
                        Reject
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </DashboardShell>
  );
}
