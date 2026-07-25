'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/lib/store';
import { NotificationBell } from './NotificationBell';

interface NavItem {
  href: string;
  label: string;
}

export function DashboardShell({
  title,
  nav,
  children,
}: {
  title: string;
  nav: NavItem[];
  children: React.ReactNode;
}) {
  const path = usePathname();
  const router = useRouter();

  const signOut = useAuth((s) => s.logout);

  async function logout() {
    // Ends the session server-side (bumping tokenVersion) before clearing
    // local state, so the access token cannot outlive the click.
    await signOut();
    router.push('/login');
  }

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-60 shrink-0 border-r bg-white p-4 md:block">
        <div className="text-lg font-bold">{title}</div>
        <nav className="mt-6 space-y-1">
          {nav.map((item) => {
            const active = path === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`block rounded-md px-3 py-2 text-sm ${
                  active
                    ? 'bg-brand-50 font-medium text-brand-700'
                    : 'text-gray-700 hover:bg-gray-50'
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="mt-6">
          <NotificationBell />
        </div>
        <button
          onClick={logout}
          className="mt-8 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
        >
          Sign out
        </button>
      </aside>
      <main className="flex-1 p-6">{children}</main>
    </div>
  );
}
