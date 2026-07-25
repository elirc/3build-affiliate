'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DashboardShell } from '@/components/DashboardShell';
import { BRAND_NAV } from '@/components/nav';
import { api } from '@/lib/api';

interface Relationship {
  id: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'DEACTIVATED';
  applicationMessage: string | null;
  appliedAt: string;
  affiliate: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    bio: string | null;
  };
}

export default function BrandAffiliatesPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['brand-affiliates'],
    queryFn: () => api<Relationship[]>('/api/brand/affiliates'),
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
    </DashboardShell>
  );
}
