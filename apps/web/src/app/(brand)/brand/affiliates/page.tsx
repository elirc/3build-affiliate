'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DashboardShell } from '@/components/DashboardShell';
import { BRAND_NAV } from '@/components/nav';
import { useState } from 'react';
import { formatCommission } from '@affiliate/analytics';
import type { CommissionStructure } from '@affiliate/shared';
import { api } from '@/lib/api';

interface Relationship {
  id: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'DEACTIVATED';
  applicationMessage: string | null;
  appliedAt: string;
  customCommission: CommissionStructure | null;
  affiliate: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    bio: string | null;
    socialLinks: Record<string, string> | null;
  };
}

export default function BrandAffiliatesPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['brand-affiliates'],
    queryFn: () => api<Relationship[]>('/api/brand/affiliates'),
  });

  const [rateFor, setRateFor] = useState<Relationship | null>(null);
  const [percentage, setPercentage] = useState('');
  const [error, setError] = useState<string | null>(null);

  const setRate = useMutation({
    mutationFn: (vars: { id: string; structure: CommissionStructure | null }) =>
      api(`/api/brand/affiliates/${vars.id}/commission`, {
        method: 'PUT',
        body: JSON.stringify({ commissionStructure: vars.structure }),
      }),
    onSuccess: () => {
      setRateFor(null);
      setError(null);
      qc.invalidateQueries({ queryKey: ['brand-affiliates'] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const review = useMutation({
    mutationFn: (vars: { id: string; action: 'approve' | 'reject' | 'deactivate' }) =>
      api(`/api/brand/affiliates/${vars.id}/review`, {
        method: 'POST',
        body: JSON.stringify({ action: vars.action }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['brand-affiliates'] }),
  });

  return (
    <DashboardShell title="Brand" nav={BRAND_NAV}>
      <h1 className="text-2xl font-semibold">Affiliates</h1>
      <p className="mt-2 text-gray-600">Review applicants and manage approved partners.</p>
      <div className="mt-6 overflow-hidden rounded-lg border bg-white">
        <table className="min-w-full divide-y">
          <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
            <tr>
              <th className="px-4 py-2">Affiliate</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Applied</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading && (
              <tr>
                <td className="px-4 py-3 text-gray-500" colSpan={4}>
                  Loading…
                </td>
              </tr>
            )}
            {(data ?? []).map((r) => (
              <tr key={r.id}>
                <td className="px-4 py-3">
                  <div className="font-medium">
                    {r.affiliate.firstName} {r.affiliate.lastName}
                  </div>
                  <div className="text-xs text-gray-500">{r.affiliate.email}</div>
                  {r.applicationMessage && (
                    <div className="mt-1 text-xs text-gray-600">
                      “{r.applicationMessage}”
                    </div>
                  )}
                  {r.affiliate.bio && (
                    <div className="mt-1 text-xs text-gray-600">{r.affiliate.bio}</div>
                  )}
                  {r.affiliate.socialLinks && (
                    <div className="mt-1 flex gap-2 text-xs">
                      {Object.entries(r.affiliate.socialLinks).map(([k, v]) => (
                        <a
                          key={k}
                          href={v}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="text-brand-700 underline"
                        >
                          {k}
                        </a>
                      ))}
                    </div>
                  )}
                  {r.status === 'APPROVED' && (
                    <div className="mt-2 text-xs">
                      {r.customCommission ? (
                        <span className="rounded-full bg-brand-50 px-2 py-0.5 font-medium text-brand-700">
                          Custom rate: {formatCommission(r.customCommission)}
                        </span>
                      ) : (
                        <span className="text-gray-500">Campaign default rate</span>
                      )}
                      <button
                        onClick={() => {
                          setError(null);
                          setPercentage(
                            r.customCommission?.type === 'percentage'
                              ? String(r.customCommission.percentage)
                              : ''
                          );
                          setRateFor(r);
                        }}
                        className="ml-2 text-brand-700 underline"
                      >
                        {r.customCommission ? 'Change' : 'Set custom rate'}
                      </button>
                    </div>
                  )}
                </td>
                <td className="px-4 py-3 text-sm">{r.status}</td>
                <td className="px-4 py-3 text-sm text-gray-600">
                  {new Date(r.appliedAt).toLocaleDateString()}
                </td>
                <td className="px-4 py-3 text-right">
                  {r.status === 'PENDING' && (
                    <div className="flex justify-end gap-2">
                      <button
                        onClick={() => review.mutate({ id: r.id, action: 'approve' })}
                        className="rounded-md bg-brand-600 px-3 py-1 text-xs text-white hover:bg-brand-700"
                      >
                        Approve
                      </button>
                      <button
                        onClick={() => review.mutate({ id: r.id, action: 'reject' })}
                        className="rounded-md border border-gray-300 px-3 py-1 text-xs hover:bg-gray-50"
                      >
                        Reject
                      </button>
                    </div>
                  )}
                  {r.status === 'APPROVED' && (
                    <button
                      onClick={() => review.mutate({ id: r.id, action: 'deactivate' })}
                      className="rounded-md border border-gray-300 px-3 py-1 text-xs hover:bg-gray-50"
                    >
                      Deactivate
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {rateFor && (
        <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/30 p-4">
          <div className="w-full max-w-md rounded-lg bg-white p-5 shadow-lg">
            <h2 className="text-lg font-semibold">
              Custom rate for {rateFor.affiliate.firstName} {rateFor.affiliate.lastName}
            </h2>
            <p className="mt-2 text-sm text-gray-600">
              This applies to <strong>every campaign you run</strong>, because rates
              are set per partner rather than per campaign. It affects future sales
              only — commissions already earned are not recalculated.
            </p>

            <label className="mt-4 block text-sm font-medium text-gray-700">
              Percentage of sale
            </label>
            <input
              type="number"
              step="0.1"
              min="0.1"
              max="100"
              value={percentage}
              onChange={(e) => setPercentage(e.target.value)}
              autoFocus
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm"
              placeholder="e.g. 30"
            />

            {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

            <div className="mt-5 flex justify-between">
              <button
                disabled={!rateFor.customCommission || setRate.isPending}
                onClick={() => setRate.mutate({ id: rateFor.id, structure: null })}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-40"
              >
                Remove custom rate
              </button>
              <div className="flex gap-2">
                <button
                  onClick={() => setRateFor(null)}
                  className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  disabled={percentage === '' || setRate.isPending}
                  onClick={() =>
                    setRate.mutate({
                      id: rateFor.id,
                      structure: { type: 'percentage', percentage: Number(percentage) },
                    })
                  }
                  className="rounded-md bg-brand-600 px-3 py-1.5 text-sm text-white hover:bg-brand-700 disabled:opacity-50"
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </DashboardShell>
  );
}
