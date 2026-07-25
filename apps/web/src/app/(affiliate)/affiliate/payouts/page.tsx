'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { DashboardShell } from '@/components/DashboardShell';
import { AFFILIATE_NAV } from '@/components/nav';
import { api } from '@/lib/api';

interface Summary {
  approved: string;
  inPayout: string;
  paid: string;
}

type Status = 'PENDING' | 'PROCESSING' | 'PAID' | 'FAILED' | 'CANCELLED';

interface Payout {
  id: string;
  amount: string;
  feeAmount: string;
  netAmount: string;
  method: string;
  status: Status;
  failureReason: string | null;
  paidAt: string | null;
  createdAt: string;
  commissions: Array<{ id: string; amount: string; campaign: { name: string } }>;
}

const STATUS_STYLES: Record<Status, string> = {
  PENDING: 'bg-yellow-50 text-yellow-800',
  PROCESSING: 'bg-blue-50 text-blue-700',
  PAID: 'bg-green-50 text-green-700',
  FAILED: 'bg-red-50 text-red-700',
  CANCELLED: 'bg-gray-100 text-gray-600',
};

/** What each status means for the affiliate, not for our database. */
const STATUS_COPY: Record<Status, string> = {
  PENDING: 'Waiting to be processed.',
  PROCESSING: 'The transfer has been started.',
  PAID: 'Sent.',
  FAILED: 'Something went wrong. The money is back in your balance.',
  CANCELLED: 'Cancelled. The money is back in your balance.',
};

export default function PayoutsPage() {
  const queryClient = useQueryClient();
  const [method, setMethod] = useState<'stripe_connect' | 'paypal' | 'manual'>(
    'stripe_connect'
  );
  const [message, setMessage] = useState<string | null>(null);

  const { data: summary } = useQuery({
    queryKey: ['affiliate-summary'],
    queryFn: () => api<Summary>('/api/affiliate/earnings/summary'),
  });

  const { data: history } = useQuery({
    queryKey: ['affiliate-payouts'],
    queryFn: () => api<{ items: Payout[]; total: number }>('/api/affiliate/payouts'),
  });

  const requestPayout = useMutation({
    mutationFn: () =>
      api('/api/affiliate/payouts', {
        method: 'POST',
        body: JSON.stringify({ method }),
      }),
    onSuccess: async () => {
      setMessage('Payout requested.');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['affiliate-summary'] }),
        queryClient.invalidateQueries({ queryKey: ['affiliate-payouts'] }),
      ]);
    },
    onError: (err: Error) => setMessage(err.message),
  });

  return (
    <DashboardShell title="Affiliate" nav={AFFILIATE_NAV}>
      <h1 className="text-2xl font-semibold">Payouts</h1>

      <div className="mt-6 max-w-xl rounded-lg border bg-white p-5 shadow-sm">
        <div className="text-sm text-gray-600">Available balance</div>
        <div className="mt-1 text-3xl font-bold">${summary?.approved ?? '0.00'}</div>
        {summary && Number(summary.inPayout) > 0 && (
          // Without this line the balance appears to drop to zero the moment a
          // payout is requested, which reads as money going missing.
          <div className="mt-1 text-sm text-gray-600">
            ${summary.inPayout} is committed to a payout in progress.
          </div>
        )}

        <label className="mt-6 block text-sm font-medium text-gray-700">
          Payout method
        </label>
        <select
          value={method}
          onChange={(event) =>
            setMethod(event.target.value as 'stripe_connect' | 'paypal' | 'manual')
          }
          className="mt-1 block w-full rounded-md border-gray-300 shadow-sm"
        >
          <option value="stripe_connect">Stripe Connect</option>
          <option value="paypal">PayPal</option>
          <option value="manual">Manual</option>
        </select>

        {message && <p className="mt-4 text-sm text-gray-700">{message}</p>}

        <button
          type="button"
          onClick={() => requestPayout.mutate()}
          disabled={requestPayout.isPending}
          className="mt-5 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {requestPayout.isPending ? 'Requesting...' : 'Request payout'}
        </button>
      </div>

      <h2 className="mt-10 text-lg font-semibold">History</h2>
      <div className="mt-3 space-y-3">
        {(history?.items ?? []).map((p) => (
          <div key={p.id} className="rounded-lg border bg-white p-4 shadow-sm">
            <div className="flex items-start justify-between">
              <div>
                <div className="text-2xl font-bold">${p.netAmount}</div>
                <div className="text-xs text-gray-500">
                  ${p.amount} gross · ${p.feeAmount} platform fee
                </div>
                <div className="mt-2 text-sm text-gray-600">
                  {p.commissions.length} commission
                  {p.commissions.length === 1 ? '' : 's'} ·{' '}
                  {[...new Set(p.commissions.map((c) => c.campaign.name))].join(', ')}
                </div>
              </div>
              <div className="text-right">
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                    STATUS_STYLES[p.status]
                  }`}
                >
                  {p.status}
                </span>
                <div className="mt-2 text-xs text-gray-500">
                  {new Date(p.paidAt ?? p.createdAt).toLocaleDateString()}
                </div>
              </div>
            </div>
            <p className="mt-2 text-sm text-gray-600">
              {STATUS_COPY[p.status]}
              {p.failureReason ? ` (${p.failureReason})` : ''}
            </p>
          </div>
        ))}
        {history?.items.length === 0 && (
          <p className="text-gray-500">No payouts yet.</p>
        )}
      </div>
    </DashboardShell>
  );
}
