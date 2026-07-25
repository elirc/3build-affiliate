'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { allowedTransitions } from '@affiliate/analytics';
import type { CampaignStatus } from '@affiliate/shared';
import { api } from '@/lib/api';

export const STATUS_STYLES: Record<CampaignStatus, string> = {
  DRAFT: 'bg-gray-100 text-gray-700',
  ACTIVE: 'bg-green-50 text-green-700',
  PAUSED: 'bg-yellow-50 text-yellow-800',
  ENDED: 'bg-gray-200 text-gray-600',
};

export function StatusBadge({ status }: { status: CampaignStatus }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[status]}`}
    >
      {status}
    </span>
  );
}

/**
 * What each transition actually does, in the brand's terms rather than the
 * state machine's. A button labelled "PAUSED" tells the reader nothing about
 * whether their existing affiliate links keep working.
 */
const TRANSITION_COPY: Record<
  CampaignStatus,
  { label: string; detail: string; destructive?: boolean }
> = {
  ACTIVE: {
    label: 'Activate',
    detail:
      'Affiliates will be able to find this campaign, apply, and create tracking links.',
  },
  PAUSED: {
    label: 'Pause',
    detail:
      'No new affiliates or links. Existing links keep redirecting and existing ' +
      'sales still convert, so nobody loses traffic they already earned.',
  },
  ENDED: {
    label: 'End campaign',
    detail:
      'Permanent. Tracking links stop counting and send visitors to your landing ' +
      'page instead, and no further conversions will be accepted.',
    destructive: true,
  },
  DRAFT: {
    label: 'Return to draft',
    detail: 'Not reachable once a campaign has been activated.',
  },
};

export function CampaignStatusControls({
  campaignId,
  status,
}: {
  campaignId: string;
  status: CampaignStatus;
}) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const transition = useMutation({
    mutationFn: (to: CampaignStatus) =>
      api(`/api/brand/campaigns/${campaignId}/transition`, {
        method: 'POST',
        body: JSON.stringify({ to }),
      }),
    onSuccess: async () => {
      setError(null);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['campaign', campaignId] }),
        qc.invalidateQueries({ queryKey: ['brand-campaigns'] }),
      ]);
    },
    onError: (err: Error) => setError(err.message),
  });

  // Offer only what the server would accept. Rendering every status and
  // letting the API reject four of them teaches the user nothing and turns a
  // rule into a guessing game.
  const next = allowedTransitions(status);

  return (
    <div className="rounded-lg border bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs uppercase text-gray-500">Status</div>
          <div className="mt-2">
            <StatusBadge status={status} />
          </div>
        </div>
      </div>

      {next.length === 0 ? (
        <p className="mt-4 text-sm text-gray-600">
          This campaign has ended. Its history stays available for reporting and
          payouts, but it cannot be reopened.
        </p>
      ) : (
        <div className="mt-4 space-y-3">
          {next.map((to) => {
            const copy = TRANSITION_COPY[to];
            return (
              <div key={to} className="flex items-start justify-between gap-4">
                <p className="text-sm text-gray-600">{copy.detail}</p>
                <button
                  type="button"
                  disabled={transition.isPending}
                  onClick={() => {
                    if (copy.destructive && !confirm(`${copy.detail}\n\nContinue?`)) {
                      return;
                    }
                    transition.mutate(to);
                  }}
                  className={`shrink-0 rounded-md px-3 py-1.5 text-sm disabled:opacity-50 ${
                    copy.destructive
                      ? 'border border-red-300 text-red-700 hover:bg-red-50'
                      : 'bg-brand-600 text-white hover:bg-brand-700'
                  }`}
                >
                  {copy.label}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
    </div>
  );
}
