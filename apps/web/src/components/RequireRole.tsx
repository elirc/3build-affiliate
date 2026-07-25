'use client';

import { useEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import type { UserRole } from '@affiliate/shared';
import { useAuth } from '@/lib/store';

const HOME_FOR_ROLE: Record<UserRole, string> = {
  BRAND: '/brand/dashboard',
  AFFILIATE: '/affiliate/dashboard',
  ADMIN: '/admin/fraud',
};

/**
 * Client-side route guard.
 *
 * This is a usability control, not a security one. The security control is
 * `requireAuth` + `requireRole` on the API, which every request goes through
 * regardless of what the browser believes. Someone who edits their way past
 * this sees an empty shell and a wall of 403s.
 *
 * What it fixes: previously an unauthenticated visitor to /brand/dashboard got
 * the whole dashboard chrome and a page of silently failing queries, with no
 * indication they needed to sign in.
 */
export function RequireRole({
  role,
  children,
}: {
  role: UserRole;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { user, status, hydrate } = useAuth();

  useEffect(() => {
    if (status === 'unknown') void hydrate();
  }, [status, hydrate]);

  useEffect(() => {
    if (status === 'unknown') return;

    if (status === 'anonymous') {
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
      return;
    }

    // Wrong role goes to *their* dashboard, not to login. Sending a logged-in
    // affiliate to a login form they are already past is a dead end.
    if (user && user.role !== role) {
      router.replace(HOME_FOR_ROLE[user.role]);
    }
  }, [status, user, role, router, pathname]);

  // Render nothing until we know. Rendering children first and redirecting
  // after produces a flash of a dashboard the visitor is not entitled to.
  if (status !== 'authenticated' || user?.role !== role) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-gray-500">
        Checking your session…
      </div>
    );
  }

  return <>{children}</>;
}
