'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { DashboardShell } from '@/components/DashboardShell';
import { api } from '@/lib/api';

const NAV = [
  { href: '/affiliate/dashboard', label: 'Overview' },
  { href: '/affiliate/applications', label: 'My Applications' },
  { href: '/affiliate/links', label: 'Tracking Links' },
  { href: '/affiliate/earnings', label: 'Earnings' },
  { href: '/affiliate/payouts', label: 'Payouts' },
];

interface Summary {
  approved: string;
}

export default function PayoutsPage() {
  const queryClient = useQueryClient();
  const [method, setMethod] = useState<'stripe_connect' | 'paypal' | 'manual'>(
    'stripe_connect'
  );
  const [message, setMessage] = useState<string | null>(null);
  const { data } = useQuery({
    queryKey: ['affiliate-summary'],
    queryFn: () => api<Summary>('/api/affiliate/earnings/summary'),
  });

  const requestPayout = useMutation({
    mutationFn: () =>
      api('/api/affiliate/payouts', {
        method: 'POST',
        body: JSON.stringify({ method }),
      }),
    onSuccess: async () => {
      setMessage('Payout request created.');
      await queryClient.invalidateQueries({ queryKey: ['affiliate-summary'] });
    },
    onError: (err: Error) => setMessage(err.message),
  });

  return (
    <DashboardShell title="Affiliate" nav={NAV}>
      <h1 className="text-2xl font-semibold">Payouts</h1>
      <div className="mt-6 max-w-xl rounded-lg border bg-white p-5 shadow-sm">
        <div className="text-sm text-gray-600">Available balance</div>
        <div className="mt-1 text-3xl font-bold">${data?.approved ?? '0.00'}</div>

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
    </DashboardShell>
  );
}
