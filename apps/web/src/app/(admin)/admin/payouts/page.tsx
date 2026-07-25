'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DashboardShell } from '@/components/DashboardShell';
import { ADMIN_NAV } from '@/components/nav';
import { api } from '@/lib/api';

type Status = 'PENDING' | 'PROCESSING' | 'PAID' | 'FAILED' | 'CANCELLED';

interface AdminPayout {
  id: string;
  amount: string;
  feeAmount: string;
  netAmount: string;
  currency: string;
  method: string;
  status: Status;
  failureReason: string | null;
  createdAt: string;
  affiliate: { id: string; email: string; firstName: string; lastName: string };
  _count: { commissions: number };
}

const STATUS_STYLES: Record<Status, string> = {
  PENDING: 'bg-yellow-50 text-yellow-800',
  PROCESSING: 'bg-blue-50 text-blue-700',
  PAID: 'bg-green-50 text-green-700',
  FAILED: 'bg-red-50 text-red-700',
  CANCELLED: 'bg-gray-100 text-gray-600',
};

const FILTERS: Array<Status | 'ALL'> = [
  'PENDING',
  'PROCESSING',
  'PAID',
  'FAILED',
  'CANCELLED',
  'ALL',
];

export default function AdminPayoutsPage() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<Status | 'ALL'>('PENDING');
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['admin-payouts', status],
    queryFn: () =>
      api<AdminPayout[]>(
        `/api/admin/payouts${status === 'ALL' ? '' : `?status=${status}`}`
      ),
  });

  const act = useMutation({
    mutationFn: (vars: { id: string; action: string; body?: object }) =>
      api(`/api/admin/payouts/${vars.id}/${vars.action}`, {
        method: 'POST',
        body: JSON.stringify(vars.body ?? {}),
      }),
    onSuccess: async () => {
      setError(null);
      await qc.invalidateQueries({ queryKey: ['admin-payouts'] });
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <DashboardShell title="Admin" nav={ADMIN_NAV}>
      <h1 className="text-2xl font-semibold">Payouts</h1>
      <p className="mt-2 text-gray-600">
        Money leaving the platform. Mark a payout processing when you initiate the
        transfer, and paid once it settles.
      </p>

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

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      <div className="mt-6 space-y-3">
        {isLoading && <p className="text-gray-500">Loading…</p>}
        {(data ?? []).map((p) => (
          <div key={p.id} className="rounded-lg border bg-white p-4 shadow-sm">
            <div className="flex items-start justify-between">
              <div>
                <div className="font-medium">
                  {p.affiliate.firstName} {p.affiliate.lastName}
                </div>
                <div className="text-xs text-gray-500">{p.affiliate.email}</div>
                <div className="mt-2 text-sm text-gray-700">
                  {p._count.commissions} commission
                  {p._count.commissions === 1 ? '' : 's'} · {p.method}
                </div>
                {p.failureReason && (
                  <div className="mt-2 text-sm text-red-700">
                    Failed: {p.failureReason}
                  </div>
                )}
              </div>
              <div className="text-right">
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                    STATUS_STYLES[p.status]
                  }`}
                >
                  {p.status}
                </span>
                {/* Net is what the affiliate receives; gross and fee are shown
                    so the difference is never a surprise. */}
                <div className="mt-2 text-2xl font-bold">${p.netAmount}</div>
                <div className="text-xs text-gray-500">
                  ${p.amount} gross · ${p.feeAmount} fee
                </div>
              </div>
            </div>

            <div className="mt-3 flex gap-2">
              {(p.status === 'PENDING' || p.status === 'FAILED') && (
                <button
                  onClick={() => act.mutate({ id: p.id, action: 'process' })}
                  className="rounded-md bg-brand-600 px-3 py-1 text-xs text-white hover:bg-brand-700"
                >
                  {p.status === 'FAILED' ? 'Retry transfer' : 'Start transfer'}
                </button>
              )}
              {p.status === 'PROCESSING' && (
                <button
                  onClick={() => {
                    const reference = prompt('Payment reference (optional)') ?? undefined;
                    act.mutate({
                      id: p.id,
                      action: 'complete',
                      body: reference ? { reference } : {},
                    });
                  }}
                  className="rounded-md bg-green-600 px-3 py-1 text-xs text-white hover:bg-green-700"
                >
                  Mark paid
                </button>
              )}
              {(p.status === 'PENDING' || p.status === 'PROCESSING') && (
                <button
                  onClick={() => {
                    const reason = prompt('Why did this payout fail?');
                    if (reason) act.mutate({ id: p.id, action: 'fail', body: { reason } });
                  }}
                  className="rounded-md border border-gray-300 px-3 py-1 text-xs hover:bg-gray-50"
                >
                  Mark failed
                </button>
              )}
              {p.status === 'PENDING' && (
                <button
                  onClick={() => {
                    if (confirm('Cancel this payout? The commissions go back to the affiliate’s balance.')) {
                      act.mutate({ id: p.id, action: 'cancel' });
                    }
                  }}
                  className="rounded-md border border-gray-300 px-3 py-1 text-xs hover:bg-gray-50"
                >
                  Cancel
                </button>
              )}
            </div>
          </div>
        ))}
        {data?.length === 0 && (
          <p className="text-gray-500">
            {status === 'PENDING' ? 'Nothing waiting to be paid.' : 'Nothing here.'}
          </p>
        )}
      </div>
    </DashboardShell>
  );
}
