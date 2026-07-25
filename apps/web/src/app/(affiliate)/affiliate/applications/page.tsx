'use client';

import { useQuery } from '@tanstack/react-query';
import { DashboardShell } from '@/components/DashboardShell';
import { AFFILIATE_NAV } from '@/components/nav';
import { api } from '@/lib/api';

interface Application {
  id: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'DEACTIVATED';
  appliedAt: string;
  brand: { id: string; companyName: string | null; companyUrl: string | null };
}

const STATUS_STYLES: Record<string, string> = {
  PENDING: 'bg-yellow-50 text-yellow-700',
  APPROVED: 'bg-green-50 text-green-700',
  REJECTED: 'bg-red-50 text-red-700',
  DEACTIVATED: 'bg-gray-100 text-gray-600',
};

export default function ApplicationsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['affiliate-applications'],
    queryFn: () => api<Application[]>('/api/affiliate/applications'),
  });

  return (
    <DashboardShell title="Affiliate" nav={AFFILIATE_NAV}>
      <h1 className="text-2xl font-semibold">My Applications</h1>
      <div className="mt-6 overflow-hidden rounded-lg border bg-white">
        <table className="min-w-full divide-y">
          <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
            <tr>
              <th className="px-4 py-2">Brand</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Applied</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading && (
              <tr>
                <td className="px-4 py-3 text-gray-500" colSpan={3}>
                  Loading…
                </td>
              </tr>
            )}
            {(data ?? []).map((a) => (
              <tr key={a.id}>
                <td className="px-4 py-3">{a.brand.companyName ?? 'Unnamed brand'}</td>
                <td className="px-4 py-3">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[a.status]}`}
                  >
                    {a.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-sm text-gray-600">
                  {new Date(a.appliedAt).toLocaleDateString()}
                </td>
              </tr>
            ))}
            {data?.length === 0 && (
              <tr>
                <td className="px-4 py-3 text-gray-500" colSpan={3}>
                  No applications yet. Browse <a className="text-brand-700 underline" href="/programs">programs</a>.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </DashboardShell>
  );
}
