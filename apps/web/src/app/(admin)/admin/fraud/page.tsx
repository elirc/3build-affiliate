'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DashboardShell } from '@/components/DashboardShell';
import { ADMIN_NAV } from '@/components/nav';
import { api } from '@/lib/api';

interface FraudReview {
  id: string;
  riskScore: number;
  signals: Array<{ rule: string; score: number; detail: string }>;
  decision: 'PENDING' | 'CLEARED' | 'FLAGGED' | 'BLOCKED';
  createdAt: string;
  conversion: {
    id: string;
    externalOrderId: string;
    conversionValue: string;
    commissionAmount: string;
    affiliateId: string;
    campaignId: string;
    status: string;
  };
}

const SCORE_COLOR = (s: number) =>
  s >= 60 ? 'text-red-600' : s >= 30 ? 'text-yellow-700' : 'text-gray-600';

export default function FraudPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['fraud-reviews'],
    queryFn: () => api<FraudReview[]>('/api/admin/fraud-reviews'),
  });

  const decide = useMutation({
    mutationFn: (vars: { id: string; decision: 'CLEARED' | 'FLAGGED' | 'BLOCKED'; notes?: string }) =>
      api(`/api/admin/fraud-reviews/${vars.id}/decide`, {
        method: 'POST',
        body: JSON.stringify(vars),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fraud-reviews'] }),
  });

  return (
    <DashboardShell title="Admin" nav={ADMIN_NAV}>
      <h1 className="text-2xl font-semibold">Fraud Review</h1>
      <p className="mt-2 text-gray-600">
        Conversions flagged by the risk-scoring rules. BLOCKING reverses the conversion.
      </p>
      <div className="mt-6 space-y-3">
        {isLoading && <p className="text-gray-500">Loading…</p>}
        {(data ?? []).map((r) => (
          <div key={r.id} className="rounded-lg border bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs uppercase text-gray-500">Order</div>
                <div className="font-mono text-sm">{r.conversion.externalOrderId}</div>
              </div>
              <div className="text-right">
                <div className="text-xs uppercase text-gray-500">Risk</div>
                <div className={`text-2xl font-bold ${SCORE_COLOR(r.riskScore)}`}>
                  {r.riskScore}
                </div>
              </div>
            </div>
            <div className="mt-3 text-sm text-gray-700">
              Order value <strong>${r.conversion.conversionValue}</strong>, commission{' '}
              <strong>${r.conversion.commissionAmount}</strong>, status {r.conversion.status}.
            </div>
            <ul className="mt-3 space-y-1 text-xs text-gray-600">
              {r.signals.map((s, i) => (
                <li key={i}>
                  <code className="rounded bg-gray-100 px-1">{s.rule}</code> · +{s.score} ·{' '}
                  {s.detail}
                </li>
              ))}
            </ul>
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => decide.mutate({ id: r.id, decision: 'CLEARED' })}
                className="rounded-md border border-gray-300 px-3 py-1 text-xs hover:bg-gray-50"
              >
                Clear
              </button>
              <button
                onClick={() => decide.mutate({ id: r.id, decision: 'FLAGGED' })}
                className="rounded-md bg-yellow-500 px-3 py-1 text-xs text-white hover:bg-yellow-600"
              >
                Flag (watch)
              </button>
              <button
                onClick={() => {
                  if (confirm('Block this conversion and claw back the commission?'))
                    decide.mutate({ id: r.id, decision: 'BLOCKED' });
                }}
                className="rounded-md bg-red-600 px-3 py-1 text-xs text-white hover:bg-red-700"
              >
                Block
              </button>
            </div>
          </div>
        ))}
        {data?.length === 0 && <p className="text-gray-500">Nothing in the queue.</p>}
      </div>
    </DashboardShell>
  );
}
