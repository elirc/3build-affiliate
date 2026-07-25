'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

interface ApiKey {
  id: string;
  keyId: string;
  label: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

interface CreatedKey extends ApiKey {
  secret: string;
}

export function ApiKeyPanel({ campaignId }: { campaignId: string }) {
  const qc = useQueryClient();
  const [label, setLabel] = useState('');
  const [justCreated, setJustCreated] = useState<CreatedKey | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['campaign-api-keys', campaignId],
    queryFn: () => api<ApiKey[]>(`/api/brand/campaigns/${campaignId}/api-keys`),
  });

  const create = useMutation({
    mutationFn: () =>
      api<CreatedKey>(`/api/brand/campaigns/${campaignId}/api-keys`, {
        method: 'POST',
        body: JSON.stringify({ label }),
      }),
    onSuccess: async (key) => {
      // Held in component state, never refetched: this is the only moment the
      // plaintext secret exists outside the caller's storage.
      setJustCreated(key);
      setLabel('');
      setError(null);
      await qc.invalidateQueries({ queryKey: ['campaign-api-keys', campaignId] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const revoke = useMutation({
    mutationFn: (id: string) =>
      api(`/api/brand/campaigns/${campaignId}/api-keys/${id}`, { method: 'DELETE' }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['campaign-api-keys', campaignId] }),
    onError: (err: Error) => setError(err.message),
  });

  async function copySecret(secret: string) {
    await navigator.clipboard.writeText(secret);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <section className="mt-8">
      <h2 className="text-lg font-semibold">Postback credentials</h2>
      <p className="mt-1 text-sm text-gray-600">
        Your storefront signs conversion reports with these. See the{' '}
        <span className="font-medium">postback integration guide</span> for the
        signing scheme.
      </p>

      {justCreated && (
        <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4">
          <p className="text-sm font-medium text-amber-900">
            Copy this secret now — it will not be shown again.
          </p>
          <dl className="mt-3 space-y-2 text-sm">
            <div>
              <dt className="text-xs uppercase text-amber-800">Key ID</dt>
              <dd className="font-mono">{justCreated.keyId}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-amber-800">Secret</dt>
              <dd className="break-all font-mono">{justCreated.secret}</dd>
            </div>
          </dl>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => copySecret(justCreated.secret)}
              className="rounded-md bg-amber-600 px-3 py-1 text-xs text-white hover:bg-amber-700"
            >
              {copied ? 'Copied' : 'Copy secret'}
            </button>
            <button
              type="button"
              onClick={() => setJustCreated(null)}
              className="rounded-md border border-amber-400 px-3 py-1 text-xs text-amber-900"
            >
              I've stored it
            </button>
          </div>
        </div>
      )}

      <form
        className="mt-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          required
          maxLength={100}
          placeholder="Label, e.g. shopify-live"
          className="w-64 rounded-md border-gray-300 shadow-sm"
        />
        <button
          type="submit"
          disabled={create.isPending || label.trim() === ''}
          className="rounded-md bg-brand-600 px-3 py-2 text-sm text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {create.isPending ? 'Creating…' : 'Create key'}
        </button>
      </form>

      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      <div className="mt-4 overflow-hidden rounded-lg border bg-white">
        <table className="min-w-full divide-y">
          <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
            <tr>
              <th className="px-4 py-2">Label</th>
              <th className="px-4 py-2">Key ID</th>
              <th className="px-4 py-2">Last used</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading && (
              <tr>
                <td className="px-4 py-3 text-gray-500" colSpan={5}>
                  Loading…
                </td>
              </tr>
            )}
            {(data ?? []).map((k) => (
              <tr key={k.id} className={k.revokedAt ? 'text-gray-400' : undefined}>
                <td className="px-4 py-3">{k.label}</td>
                <td className="px-4 py-3 font-mono text-xs">{k.keyId}</td>
                <td className="px-4 py-3 text-sm">
                  {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : 'Never'}
                </td>
                <td className="px-4 py-3 text-sm">
                  {k.revokedAt ? 'Revoked' : 'Active'}
                </td>
                <td className="px-4 py-3 text-right">
                  {!k.revokedAt && (
                    <button
                      onClick={() => {
                        if (
                          confirm(
                            `Revoke "${k.label}"? Any storefront using it will start ` +
                              `failing immediately.`
                          )
                        ) {
                          revoke.mutate(k.id);
                        }
                      }}
                      className="rounded-md border border-gray-300 px-3 py-1 text-xs hover:bg-gray-50"
                    >
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {data?.length === 0 && (
              <tr>
                <td className="px-4 py-3 text-gray-500" colSpan={5}>
                  No keys yet. Your storefront needs one to report conversions.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
