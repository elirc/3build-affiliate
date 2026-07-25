'use client';

import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import type { Comparison } from '@affiliate/analytics';

export interface RangeState {
  days?: number;
  from?: string;
  to?: string;
  compare: boolean;
}

const PRESETS: Array<{ label: string; days: number }> = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
];

/**
 * Range selection lives in the URL, not in component state.
 *
 * So a refresh keeps the range, the back button works, and a dashboard view
 * can be pasted into a message and mean the same thing to the person who
 * opens it. Local state loses all three.
 */
export function useRangeState(): RangeState {
  const params = useSearchParams();
  const days = params.get('days');
  return {
    days: days ? Number(days) : params.get('from') ? undefined : 30,
    from: params.get('from') ?? undefined,
    to: params.get('to') ?? undefined,
    compare: params.get('compare') === 'true',
  };
}

export function rangeToQuery(state: RangeState): string {
  const q = new URLSearchParams();
  if (state.days !== undefined) q.set('days', String(state.days));
  if (state.from) q.set('from', state.from);
  if (state.to) q.set('to', state.to);
  if (state.compare) q.set('compare', 'true');
  return q.toString();
}

export function DateRangePicker() {
  const router = useRouter();
  const pathname = usePathname();
  const state = useRangeState();

  function update(next: Partial<RangeState>) {
    const merged = { ...state, ...next };
    router.replace(`${pathname}?${rangeToQuery(merged)}`);
  }

  const monthToDate = () => {
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    update({ days: undefined, from: start.toISOString(), to: undefined });
  };

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      {PRESETS.map((p) => (
        <button
          key={p.label}
          onClick={() => update({ days: p.days, from: undefined, to: undefined })}
          className={`rounded-md px-3 py-1 ${
            state.days === p.days
              ? 'bg-brand-600 text-white'
              : 'border border-gray-300'
          }`}
        >
          {p.label}
        </button>
      ))}

      <button
        onClick={monthToDate}
        className={`rounded-md px-3 py-1 ${
          state.from && !state.days
            ? 'bg-brand-600 text-white'
            : 'border border-gray-300'
        }`}
      >
        Month to date
      </button>

      <label className="ml-2 flex items-center gap-2 text-gray-600">
        <input
          type="checkbox"
          checked={state.compare}
          onChange={(e) => update({ compare: e.target.checked })}
        />
        Compare to previous period
      </label>
    </div>
  );
}

/**
 * A stat with an optional period-over-period delta.
 *
 * Colour is never the only signal -- an arrow and a word carry the same
 * meaning for anyone who cannot distinguish the two greens, and "better" is
 * not the same as "up": a rise in refunds is not good news.
 */
export function StatWithDelta({
  label,
  value,
  comparison,
  higherIsBetter = true,
}: {
  label: string;
  value: string | number;
  comparison?: Comparison;
  higherIsBetter?: boolean;
}) {
  return (
    <div className="rounded-lg border bg-white p-4 shadow-sm">
      <div className="text-xs uppercase text-gray-500">{label}</div>
      <div className="mt-2 text-2xl font-bold">{value}</div>
      {comparison && <DeltaBadge comparison={comparison} higherIsBetter={higherIsBetter} />}
    </div>
  );
}

function DeltaBadge({
  comparison,
  higherIsBetter,
}: {
  comparison: Comparison;
  higherIsBetter: boolean;
}) {
  if (comparison.direction === 'new') {
    // Growth from zero has no percentage. "∞%" and "100%" are both lies.
    return <div className="mt-1 text-xs font-medium text-green-700">New this period</div>;
  }

  if (comparison.direction === 'flat' || comparison.changePercent === null) {
    return <div className="mt-1 text-xs text-gray-500">No change</div>;
  }

  const isGood =
    comparison.direction === 'up' ? higherIsBetter : !higherIsBetter;
  const arrow = comparison.direction === 'up' ? '↑' : '↓';

  return (
    <div
      className={`mt-1 text-xs font-medium ${
        isGood ? 'text-green-700' : 'text-red-700'
      }`}
    >
      {arrow} {Math.abs(comparison.changePercent)}% vs previous period
    </div>
  );
}
