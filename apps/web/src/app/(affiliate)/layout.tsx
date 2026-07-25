'use client';

import { RequireRole } from '@/components/RequireRole';

/**
 * Every route in this group requires the AFFILIATE role.
 *
 * Applied at the layout so a new page inherits the guard automatically. The
 * alternative -- remembering to wrap each page -- fails the first time someone
 * adds a page in a hurry, and the failure is invisible.
 */
export default function Layout({ children }: { children: React.ReactNode }) {
  return <RequireRole role="AFFILIATE">{children}</RequireRole>;
}
