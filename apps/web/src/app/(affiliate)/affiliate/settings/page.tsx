'use client';

import { DashboardShell } from '@/components/DashboardShell';
import { AFFILIATE_NAV } from '@/components/nav';
import { SettingsForm } from '@/components/SettingsForm';

export default function SettingsPage() {
  return (
    <DashboardShell title="Affiliate" nav={AFFILIATE_NAV}>
      <h1 className="text-2xl font-semibold">Settings</h1>
      <div className="mt-6">
        <SettingsForm role="AFFILIATE" />
      </div>
    </DashboardShell>
  );
}
