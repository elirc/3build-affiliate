'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DashboardShell } from '@/components/DashboardShell';
import { ADMIN_NAV } from '@/components/nav';
import { api } from '@/lib/api';

type Health = 'healthy' | 'degraded' | 'down';

interface Check {
  name: string;
  status: Health;
  detail: string;
  value?: number | string | null;
}

interface HealthResponse {
  status: Health;
  checks: Check[];
}

const STATUS_STYLES: Record<Health, string> = {
  healthy: 'bg-green-50 text-green-700 border-green-200',
  degraded: 'bg-yellow-50 text-yellow-800 border-yellow-200',
  down: 'bg-red-50 text-red-700 border-red-200',
};

/** A word as well as a colour: colour must never be the only signal. */
const STATUS_LABEL: Record<Health, string> = {
  healthy: 'OK',
  degraded: 'Degraded',
  down: 'Down',
};

export default function SystemPage() {
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['system-health'],
    queryFn: () => api<HealthResponse>('/api/admin/system'),
    // The endpoint caches for 10s, so polling faster than this buys nothing.
    refetchInterval: 15_000,
  });

  const replay = useMutation({
    mutationFn: () => api<{ replayed: number }>('/api/admin/system/replay-dlq', {
      method: 'POST',
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['system-health'] }),
  });

  const dlq = data?.checks.find((c) => c.name === 'Dead-letter queue');
  const dlqDepth = typeof dlq?.value === 'number' ? dlq.value : 0;

  return (
    <DashboardShell title="Admin" nav={ADMIN_NAV}>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">System health</h1>
        {data && (
          <span
            className={`rounded-full border px-3 py-1 text-sm font-medium ${
              STATUS_STYLES[data.status]
            }`}
          >
            {STATUS_LABEL[data.status]}
          </span>
        )}
      </div>
      <p className="mt-2 text-gray-600">
        Refreshes every 15 seconds. The click pipeline can be entirely broken
        while every user-facing page looks normal — this is where that shows up.
      </p>

      {isLoading && <p className="mt-6 text-gray-500">Loading…</p>}

      <div className="mt-6 space-y-3">
        {(data?.checks ?? []).map((c) => (
          <div
            key={c.name}
            className={`rounded-lg border p-4 ${STATUS_STYLES[c.status]}`}
          >
            <div className="flex items-center justify-between">
              <span className="font-medium">{c.name}</span>
              <span className="text-xs font-semibold uppercase">
                {STATUS_LABEL[c.status]}
              </span>
            </div>
            <p className="mt-1 text-sm">{c.detail}</p>
          </div>
        ))}
      </div>

      {dlqDepth > 0 && (
        <div className="mt-6 rounded-lg border bg-white p-4">
          <h2 className="font-semibold">Replay failed clicks</h2>
          <p className="mt-1 text-sm text-gray-600">
            {dlqDepth} click event{dlqDepth === 1 ? '' : 's'} failed to write and
            are held for replay. Fix the cause first — a batch usually fails for
            a reason that is still true a second later, and replaying into a
            broken database just fills the queue again.
          </p>
          <button
            onClick={() => replay.mutate()}
            disabled={replay.isPending}
            className="mt-3 rounded-md bg-brand-600 px-4 py-2 text-sm text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {replay.isPending ? 'Replaying…' : `Replay ${dlqDepth} event(s)`}
          </button>
          {replay.data && (
            <p className="mt-2 text-sm text-green-700">
              Replayed {replay.data.replayed} event(s) back onto the queue.
            </p>
          )}
        </div>
      )}
    </DashboardShell>
  );
}
