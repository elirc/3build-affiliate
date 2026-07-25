'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { DashboardShell } from '@/components/DashboardShell';
import { BRAND_NAV } from '@/components/nav';
import { api } from '@/lib/api';
import type { CommissionStructure } from '@affiliate/shared';

type CommissionType = CommissionStructure['type'];

export default function NewCampaignPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [landingPageUrl, setLandingPageUrl] = useState('');
  const [allowedDomains, setAllowedDomains] = useState('');
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10));
  const [endDate, setEndDate] = useState('');
  const [attributionModel, setAttributionModel] = useState<
    'FIRST_CLICK' | 'LAST_CLICK' | 'LINEAR'
  >('LAST_CLICK');
  const [attributionWindowDays, setWindow] = useState(30);
  const [cookieLifetimeDays, setCookie] = useState(30);
  const [lockPeriodDays, setLock] = useState(30);
  const [isOpen, setIsOpen] = useState(true);

  const [commissionType, setCommissionType] = useState<CommissionType>('percentage');
  const [flatAmount, setFlatAmount] = useState('10');
  const [percentage, setPercentage] = useState('20');
  const [recurringMonths, setRecurringMonths] = useState('12');
  const [tiers, setTiers] = useState([
    { minSales: 0, percentage: 15 },
    { minSales: 10, percentage: 25 },
  ]);

  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function buildCommissionStructure(): CommissionStructure {
    switch (commissionType) {
      case 'flat_per_sale':
        return { type: 'flat_per_sale', flatAmount: Number(flatAmount) };
      case 'percentage':
        return { type: 'percentage', percentage: Number(percentage) };
      case 'recurring':
        return {
          type: 'recurring',
          percentage: Number(percentage),
          recurringMonths: Number(recurringMonths),
        };
      case 'tiered_percentage':
        return { type: 'tiered_percentage', tiers };
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const body = {
        name,
        description: description || undefined,
        landingPageUrl,
        allowedDomains: allowedDomains.split(',').map((d) => d.trim()).filter(Boolean),
        startDate: new Date(startDate).toISOString(),
        endDate: endDate ? new Date(endDate).toISOString() : undefined,
        commissionStructure: buildCommissionStructure(),
        attributionModel,
        attributionWindowDays,
        cookieLifetimeDays,
        lockPeriodDays,
        isOpen,
      };
      const c = await api<{ id: string }>('/api/brand/campaigns', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      router.push(`/brand/campaigns/${c.id}`);
    } catch (err: any) {
      setError(err?.message ?? 'Failed to create campaign');
    } finally {
      setLoading(false);
    }
  }

  return (
    <DashboardShell title="Brand" nav={BRAND_NAV}>
      <h1 className="text-2xl font-semibold">New Campaign</h1>
      <form onSubmit={onSubmit} className="mt-6 max-w-2xl space-y-4 rounded-lg border bg-white p-6">
        <Field label="Campaign name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            minLength={3}
            className="block w-full rounded-md border-gray-300 shadow-sm"
          />
        </Field>
        <Field label="Description">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="block w-full rounded-md border-gray-300 shadow-sm"
          />
        </Field>
        <Field label="Landing page URL">
          <input
            type="url"
            value={landingPageUrl}
            onChange={(e) => setLandingPageUrl(e.target.value)}
            required
            className="block w-full rounded-md border-gray-300 shadow-sm"
            placeholder="https://yourbrand.com/landing"
          />
        </Field>
        <Field label="Allowed destination domains (comma-separated)">
          <input
            value={allowedDomains}
            onChange={(e) => setAllowedDomains(e.target.value)}
            required
            className="block w-full rounded-md border-gray-300 shadow-sm"
            placeholder="yourbrand.com, shop.yourbrand.com"
          />
        </Field>

        <fieldset className="rounded-md border p-4">
          <legend className="px-2 text-sm font-medium text-gray-700">Commission</legend>
          <select
            value={commissionType}
            onChange={(e) => setCommissionType(e.target.value as CommissionType)}
            className="block w-full rounded-md border-gray-300 shadow-sm"
          >
            <option value="flat_per_sale">Flat per sale (USD)</option>
            <option value="percentage">Percentage of sale</option>
            <option value="tiered_percentage">Tiered percentage</option>
            <option value="recurring">Recurring percentage</option>
          </select>
          <div className="mt-3 space-y-3">
            {commissionType === 'flat_per_sale' && (
              <Field label="Flat amount (USD)">
                <input
                  type="number"
                  step="0.01"
                  value={flatAmount}
                  onChange={(e) => setFlatAmount(e.target.value)}
                  className="block w-full rounded-md border-gray-300 shadow-sm"
                />
              </Field>
            )}
            {(commissionType === 'percentage' || commissionType === 'recurring') && (
              <Field label="Percentage">
                <input
                  type="number"
                  step="0.1"
                  value={percentage}
                  onChange={(e) => setPercentage(e.target.value)}
                  className="block w-full rounded-md border-gray-300 shadow-sm"
                />
              </Field>
            )}
            {commissionType === 'recurring' && (
              <Field label="Recurring months">
                <input
                  type="number"
                  value={recurringMonths}
                  onChange={(e) => setRecurringMonths(e.target.value)}
                  className="block w-full rounded-md border-gray-300 shadow-sm"
                />
              </Field>
            )}
            {commissionType === 'tiered_percentage' && (
              <div>
                <div className="text-xs text-gray-600">
                  Tier triggers when affiliate's prior approved sales on this campaign
                  reach the threshold.
                </div>
                {tiers.map((t, i) => (
                  <div key={i} className="mt-2 flex items-center gap-2">
                    <input
                      type="number"
                      value={t.minSales}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        setTiers((arr) =>
                          arr.map((x, j) => (j === i ? { ...x, minSales: v } : x))
                        );
                      }}
                      className="w-24 rounded-md border-gray-300 shadow-sm"
                      placeholder="Min sales"
                    />
                    <input
                      type="number"
                      step="0.1"
                      value={t.percentage}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        setTiers((arr) =>
                          arr.map((x, j) => (j === i ? { ...x, percentage: v } : x))
                        );
                      }}
                      className="w-24 rounded-md border-gray-300 shadow-sm"
                      placeholder="%"
                    />
                    <button
                      type="button"
                      onClick={() => setTiers((arr) => arr.filter((_, j) => j !== i))}
                      className="text-xs text-red-600 hover:underline"
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() =>
                    setTiers((arr) => [
                      ...arr,
                      { minSales: (arr[arr.length - 1]?.minSales ?? 0) + 10, percentage: 30 },
                    ])
                  }
                  className="mt-2 text-xs text-brand-700 hover:underline"
                >
                  Add tier
                </button>
              </div>
            )}
          </div>
        </fieldset>

        <fieldset className="rounded-md border p-4">
          <legend className="px-2 text-sm font-medium text-gray-700">Attribution</legend>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Model">
              <select
                value={attributionModel}
                onChange={(e) => setAttributionModel(e.target.value as any)}
                className="block w-full rounded-md border-gray-300 shadow-sm"
              >
                <option value="FIRST_CLICK">First click</option>
                <option value="LAST_CLICK">Last click</option>
                <option value="LINEAR">Linear</option>
              </select>
            </Field>
            <Field label="Window (days)">
              <input
                type="number"
                min={1}
                max={90}
                value={attributionWindowDays}
                onChange={(e) => setWindow(Number(e.target.value))}
                className="block w-full rounded-md border-gray-300 shadow-sm"
              />
            </Field>
            <Field label="Cookie lifetime (days)">
              <input
                type="number"
                min={1}
                max={90}
                value={cookieLifetimeDays}
                onChange={(e) => setCookie(Number(e.target.value))}
                className="block w-full rounded-md border-gray-300 shadow-sm"
              />
            </Field>
            <Field label="Lock period (days)">
              <input
                type="number"
                min={0}
                max={90}
                value={lockPeriodDays}
                onChange={(e) => setLock(Number(e.target.value))}
                className="block w-full rounded-md border-gray-300 shadow-sm"
              />
            </Field>
          </div>
        </fieldset>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Starts">
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="block w-full rounded-md border-gray-300 shadow-sm"
            />
          </Field>
          <Field label="Ends (optional)">
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="block w-full rounded-md border-gray-300 shadow-sm"
            />
          </Field>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={isOpen}
            onChange={(e) => setIsOpen(e.target.checked)}
          />
          Open enrollment (affiliates auto-approved on apply)
        </label>

        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex gap-3">
          <button
            type="submit"
            disabled={loading}
            className="rounded-md bg-brand-600 px-4 py-2 text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {loading ? 'Creating…' : 'Create campaign'}
          </button>
        </div>
      </form>
    </DashboardShell>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-gray-700">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}
