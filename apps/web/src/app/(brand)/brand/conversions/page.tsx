'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DashboardShell } from '@/components/DashboardShell';
import { BRAND_NAV } from '@/components/nav';
import { api } from '@/lib/api';

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

  const [dialog, setDialog] = useState<
    { conversion: Conversion; kind: 'reject' | 'reverse' } | null
  >(null);
  const [reason, setReason] = useState('');
  const [refundAmount, setRefundAmount] = useState('');
  const [error, setError] = useState<string | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['brand-conversions'] });

  const review = useMutation({
    mutationFn: (vars: { id: string; status: 'approved' | 'rejected'; reason?: string }) =>
      api(`/api/brand/conversions/${vars.id}/review`, {
        method: 'POST',
        body: JSON.stringify({ status: vars.status, reason: vars.reason }),
      }),
    onSuccess: () => { setDialog(null); invalidate(); },
    onError: (err: Error) => setError(err.message),
  });

  // Reversing an approved sale is a different operation from rejecting a
  // pending one: the commission may already have been paid.
  const reverse = useMutation({
    mutationFn: (vars: { id: string; reason: string; refundAmount?: number }) =>
      api(`/api/brand/conversions/${vars.id}/reverse`, {
        method: 'POST',
        body: JSON.stringify({
          reason: vars.reason,
          ...(vars.refundAmount ? { refundAmount: vars.refundAmount } : {}),
        }),
      }),
    onSuccess: () => { setDialog(null); invalidate(); },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <DashboardShell title="Brand" nav={BRAND_NAV}>
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
                  {c.status === 'APPROVED' && (
                    <button
                      onClick={() => {
                        setReason('');
                        setRefundAmount('');
                        setError(null);
                        setDialog({ conversion: c, kind: 'reverse' });
                      }}
                      className="rounded-md border border-gray-300 px-3 py-1 text-xs hover:bg-gray-50"
                    >
                      Reverse
                    </button>
                  )}
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
                          setReason('');
                          setError(null);
                          setDialog({ conversion: c, kind: 'reject' });
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

      {dialog && (
        <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/30 p-4">
          <div className="w-full max-w-md rounded-lg bg-white p-5 shadow-lg">
            <h2 className="text-lg font-semibold">
              {dialog.kind === 'reject' ? 'Reject this conversion' : 'Reverse this sale'}
            </h2>
            <p className="mt-2 text-sm text-gray-600">
              {dialog.kind === 'reject'
                ? 'The affiliate keeps no commission for this order.'
                : 'The affiliate sees this reason in their earnings. If the commission has already been paid, the amount is recovered from their next payout.'}
            </p>

            <label className="mt-4 block text-sm font-medium text-gray-700">
              Reason
            </label>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              autoFocus
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm"
              placeholder="Customer returned the item"
            />

            {dialog.kind === 'reverse' && (
              <>
                <label className="mt-3 block text-sm font-medium text-gray-700">
                  Refund amount (leave blank for a full refund)
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  max={dialog.conversion.conversionValue}
                  value={refundAmount}
                  onChange={(e) => setRefundAmount(e.target.value)}
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm"
                  placeholder={dialog.conversion.conversionValue}
                />
                <span className="mt-1 block text-xs text-gray-500">
                  A partial refund reduces the commission in proportion.
                </span>
              </>
            )}

            {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setDialog(null)}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                disabled={reason.trim() === '' || review.isPending || reverse.isPending}
                onClick={() => {
                  if (dialog.kind === 'reject') {
                    review.mutate({ id: dialog.conversion.id, status: 'rejected', reason });
                  } else {
                    reverse.mutate({
                      id: dialog.conversion.id,
                      reason,
                      refundAmount: refundAmount ? Number(refundAmount) : undefined,
                    });
                  }
                }}
                className="rounded-md bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-700 disabled:opacity-50"
              >
                {dialog.kind === 'reject' ? 'Reject' : 'Reverse'}
              </button>
            </div>
          </div>
        </div>
      )}
    </DashboardShell>
  );
}
