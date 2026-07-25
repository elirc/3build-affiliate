'use client';

import { DashboardShell } from '@/components/DashboardShell';
import { BRAND_NAV } from '@/components/nav';
import { SettingsForm } from '@/components/SettingsForm';

export default function SettingsPage() {
  return (
    <DashboardShell title="Brand" nav={BRAND_NAV}>
      <h1 className="text-2xl font-semibold">Settings</h1>
      <div className="mt-6">
        <SettingsForm role="BRAND" />
      </div>
    </DashboardShell>
  );
}
