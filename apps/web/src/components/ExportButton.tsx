'use client';

import { useState } from 'react';
import { tokenStore } from '@/lib/api';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

/**
 * Downloads a CSV.
 *
 * A plain <a href> would be simpler, but the export endpoints need an
 * Authorization header and a link cannot carry one. Putting the token in the
 * query string instead would leak it into browser history, server logs and
 * any Referer header the download generates.
 *
 * So: fetch with the header, then hand the browser a blob.
 */
export function ExportButton({
  endpoint,
  label = 'Export CSV',
}: {
  endpoint: string;
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}${endpoint}`, {
        headers: { Authorization: `Bearer ${tokenStore.get() ?? ''}` },
      });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);

      // Prefer the filename the server chose, so the date in it is the
      // server's date rather than the browser's.
      const disposition = res.headers.get('content-disposition') ?? '';
      const match = disposition.match(/filename="([^"]+)"/);
      const filename = match?.[1] ?? 'export.csv';

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      // Released immediately: the click has already started the download, and
      // an un-revoked object URL keeps the whole blob in memory.
      URL.revokeObjectURL(url);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={download}
        disabled={busy}
        className="rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-50"
      >
        {busy ? 'Preparing…' : label}
      </button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </span>
  );
}
