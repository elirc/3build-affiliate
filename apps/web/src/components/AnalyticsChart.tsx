'use client';

import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

interface Point {
  date: string;
  clicks: number;
  conversions: number;
  revenue: string;
  commission: string;
}

export function AnalyticsChart({
  series,
  metric,
}: {
  series: Point[];
  metric: 'clicks' | 'conversions' | 'revenue' | 'commission';
}) {
  const data = series.map((p) => ({
    date: p.date.slice(5),
    value:
      metric === 'clicks'
        ? p.clicks
        : metric === 'conversions'
        ? p.conversions
        : Number(metric === 'revenue' ? p.revenue : p.commission),
  }));

  return (
    <div className="h-64 w-full rounded-lg border bg-white p-4">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data}>
          <defs>
            <linearGradient id="grad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#2563eb" stopOpacity={0.4} />
              <stop offset="100%" stopColor="#2563eb" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis dataKey="date" tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} />
          <Tooltip />
          <Area
            type="monotone"
            dataKey="value"
            stroke="#2563eb"
            strokeWidth={2}
            fill="url(#grad)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
