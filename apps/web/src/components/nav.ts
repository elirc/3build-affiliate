/**
 * Navigation, defined once per role.
 *
 * These arrays used to be copy-pasted at the top of every page file, and they
 * had already drifted: the affiliate links page was missing "My Applications",
 * so that section became unreachable from one of the five pages that should
 * have linked to it. Duplicated navigation always drifts, and the drift is
 * invisible until someone happens to be on the wrong page.
 */

export interface NavItem {
  href: string;
  label: string;
}

export const AFFILIATE_NAV: NavItem[] = [
  { href: '/affiliate/dashboard', label: 'Overview' },
  { href: '/affiliate/applications', label: 'My Applications' },
  { href: '/affiliate/links', label: 'Tracking Links' },
  { href: '/affiliate/creatives', label: 'Creatives' },
  { href: '/affiliate/earnings', label: 'Earnings' },
  { href: '/affiliate/payouts', label: 'Payouts' },
  { href: '/affiliate/settings', label: 'Settings' },
];

export const BRAND_NAV: NavItem[] = [
  { href: '/brand/dashboard', label: 'Overview' },
  { href: '/brand/campaigns', label: 'Campaigns' },
  { href: '/brand/affiliates', label: 'Affiliates' },
  { href: '/brand/conversions', label: 'Conversions' },
  { href: '/brand/settings', label: 'Settings' },
];

export const ADMIN_NAV: NavItem[] = [
  { href: '/admin/fraud', label: 'Fraud Review' },
  { href: '/admin/payouts', label: 'Payouts' },
];
