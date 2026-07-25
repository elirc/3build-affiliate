'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { NOTIFICATION_COPY, type NotificationType } from '@affiliate/shared';
import { api } from '@/lib/api';

interface Notification {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

export function NotificationBell() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  const { data } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api<{ items: Notification[]; unread: number }>('/api/me/notifications'),
    refetchInterval: 60_000,
  });

  const markAll = useMutation({
    mutationFn: () => api('/api/me/notifications/read-all', { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });

  const unread = data?.unread ?? 0;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="relative w-full rounded-md border border-gray-300 px-3 py-2 text-left text-sm hover:bg-gray-50"
      >
        Notifications
        {unread > 0 && (
          <span className="ml-2 rounded-full bg-brand-600 px-2 py-0.5 text-xs font-medium text-white">
            {unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute left-0 z-20 mt-1 max-h-96 w-80 overflow-y-auto rounded-lg border bg-white shadow-lg">
          <div className="flex items-center justify-between border-b px-3 py-2">
            <span className="text-sm font-medium">Notifications</span>
            {unread > 0 && (
              <button
                onClick={() => markAll.mutate()}
                className="text-xs text-brand-700 hover:underline"
              >
                Mark all read
              </button>
            )}
          </div>

          <ul className="divide-y">
            {(data?.items ?? []).map((n) => (
              <li
                key={n.id}
                className={`px-3 py-2 text-sm ${n.readAt ? 'text-gray-500' : ''}`}
              >
                <div className="font-medium">
                  {NOTIFICATION_COPY[n.type as NotificationType] ?? n.type}
                </div>
                {typeof n.payload.reason === 'string' && (
                  <div className="mt-0.5 text-xs text-gray-600">
                    {n.payload.reason}
                  </div>
                )}
                {typeof n.payload.amount === 'string' && (
                  <div className="mt-0.5 text-xs text-gray-600">
                    ${n.payload.amount}
                  </div>
                )}
                <div className="mt-0.5 text-xs text-gray-400">
                  {new Date(n.createdAt).toLocaleString()}
                </div>
              </li>
            ))}
            {data?.items.length === 0 && (
              <li className="px-3 py-4 text-sm text-gray-500">Nothing yet.</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
