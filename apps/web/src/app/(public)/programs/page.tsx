'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, tokenStore } from '@/lib/api';

interface Program {
  id: string;
  name: string;
  description: string | null;
  slug: string;
  brand: { id: string; companyName: string | null; companyLogo: string | null };
}

export default function ProgramsPage() {
  const [applied, setApplied] = useState<Record<string, 'PENDING' | 'APPROVED'>>({});
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ['programs'],
    queryFn: () => api<Program[]>('/api/public/programs'),
  });

  const apply = useMutation({
    mutationFn: async (campaignId: string) => {
      if (!tokenStore.get()) {
        window.location.href = '/login';
        throw new Error('login required');
      }
      return api<{ id: string; status: 'PENDING' | 'APPROVED' }>(
        '/api/affiliate/applications',
        { method: 'POST', body: JSON.stringify({ campaignId }) }
      );
    },
    onSuccess: (rel, campaignId) =>
      setApplied((s) => ({ ...s, [campaignId]: rel.status })),
    onError: (err: any) => setErrorMsg(err?.message ?? 'Could not apply'),
  });

  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <h1 className="text-3xl font-bold">Open Affiliate Programs</h1>
      <p className="mt-2 text-gray-600">Browse brands accepting affiliates.</p>
      {errorMsg && <p className="mt-4 text-sm text-red-600">{errorMsg}</p>}
      {isLoading && <p className="mt-8 text-gray-500">Loading…</p>}
      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {(data ?? []).map((p) => {
          const state = applied[p.id];
          return (
            <div key={p.id} className="flex flex-col rounded-lg border bg-white p-5 shadow-sm">
              <p className="text-xs uppercase text-gray-500">{p.brand.companyName}</p>
              <h2 className="mt-1 text-lg font-semibold">{p.name}</h2>
              <p className="mt-2 line-clamp-3 text-sm text-gray-600">{p.description}</p>
              <div className="mt-4">
                {state ? (
                  <span className="rounded-full bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700">
                    {state}
                  </span>
                ) : (
                  <button
                    onClick={() => apply.mutate(p.id)}
                    disabled={apply.isPending}
                    className="rounded-md bg-brand-600 px-3 py-1.5 text-sm text-white hover:bg-brand-700 disabled:opacity-50"
                  >
                    Apply
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </main>
  );
}
