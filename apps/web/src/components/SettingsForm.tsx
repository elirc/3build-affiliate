'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/store';

interface Profile {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: 'BRAND' | 'AFFILIATE' | 'ADMIN';
  emailVerified: boolean;
  bio: string | null;
  socialLinks: Record<string, string> | null;
  companyName: string | null;
  companyUrl: string | null;
  payoutMethod: 'STRIPE_CONNECT' | 'PAYPAL' | 'MANUAL' | null;
  stripeConnectAccountId: string | null;
  paypalEmail: string | null;
  manualPayoutDetails: string | null;
}

type PayoutMethod = 'stripe_connect' | 'paypal' | 'manual';

export function SettingsForm({ role }: { role: 'BRAND' | 'AFFILIATE' }) {
  const qc = useQueryClient();
  const router = useRouter();
  const signOut = useAuth((s) => s.logout);

  const { data: profile } = useQuery({
    queryKey: ['profile'],
    queryFn: () => api<Profile>('/api/me/profile'),
  });

  const [form, setForm] = useState({ firstName: '', lastName: '', bio: '', companyName: '' });
  const [links, setLinks] = useState<Array<[string, string]>>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!profile) return;
    setForm({
      firstName: profile.firstName,
      lastName: profile.lastName,
      bio: profile.bio ?? '',
      companyName: profile.companyName ?? '',
    });
    setLinks(Object.entries(profile.socialLinks ?? {}));
  }, [profile]);

  const saveProfile = useMutation({
    mutationFn: () =>
      api('/api/me/profile', {
        method: 'PATCH',
        body: JSON.stringify(
          role === 'AFFILIATE'
            ? {
                firstName: form.firstName,
                lastName: form.lastName,
                bio: form.bio || null,
                socialLinks:
                  links.length > 0
                    ? Object.fromEntries(links.filter(([k, v]) => k && v))
                    : null,
              }
            : {
                firstName: form.firstName,
                lastName: form.lastName,
                companyName: form.companyName,
              }
        ),
      }),
    onSuccess: () => {
      setMessage('Profile saved.');
      setError(null);
      qc.invalidateQueries({ queryKey: ['profile'] });
    },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <div className="max-w-2xl space-y-8">
      <section className="rounded-lg border bg-white p-5">
        <h2 className="text-lg font-semibold">Profile</h2>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <Field label="First name">
            <input
              value={form.firstName}
              onChange={(e) => setForm({ ...form, firstName: e.target.value })}
              className="block w-full rounded-md border-gray-300 shadow-sm"
            />
          </Field>
          <Field label="Last name">
            <input
              value={form.lastName}
              onChange={(e) => setForm({ ...form, lastName: e.target.value })}
              className="block w-full rounded-md border-gray-300 shadow-sm"
            />
          </Field>
        </div>

        {role === 'BRAND' && (
          <Field label="Company name">
            <input
              value={form.companyName}
              onChange={(e) => setForm({ ...form, companyName: e.target.value })}
              className="block w-full rounded-md border-gray-300 shadow-sm"
            />
          </Field>
        )}

        {role === 'AFFILIATE' && (
          <>
            <Field label="Bio">
              <textarea
                rows={3}
                value={form.bio}
                onChange={(e) => setForm({ ...form, bio: e.target.value })}
                className="block w-full rounded-md border-gray-300 shadow-sm"
                placeholder="What do you write about, and who reads it?"
              />
              <span className="mt-1 block text-xs text-gray-500">
                Brands see this when deciding whether to approve you.
              </span>
            </Field>

            <Field label="Social links">
              {links.map(([k, v], i) => (
                <div key={i} className="mt-2 flex gap-2">
                  <input
                    value={k}
                    onChange={(e) =>
                      setLinks(links.map((l, j) => (j === i ? [e.target.value, l[1]] : l)))
                    }
                    placeholder="youtube"
                    className="w-32 rounded-md border-gray-300 shadow-sm"
                  />
                  <input
                    value={v}
                    onChange={(e) =>
                      setLinks(links.map((l, j) => (j === i ? [l[0], e.target.value] : l)))
                    }
                    placeholder="https://…"
                    className="flex-1 rounded-md border-gray-300 shadow-sm"
                  />
                  <button
                    type="button"
                    onClick={() => setLinks(links.filter((_, j) => j !== i))}
                    className="text-xs text-red-600 hover:underline"
                  >
                    Remove
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => setLinks([...links, ['', '']])}
                className="mt-2 text-xs text-brand-700 hover:underline"
              >
                Add link
              </button>
              <span className="mt-1 block text-xs text-gray-500">
                Must start with https://
              </span>
            </Field>
          </>
        )}

        {message && <p className="mt-3 text-sm text-green-700">{message}</p>}
        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

        <button
          onClick={() => saveProfile.mutate()}
          disabled={saveProfile.isPending}
          className="mt-4 rounded-md bg-brand-600 px-4 py-2 text-sm text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {saveProfile.isPending ? 'Saving…' : 'Save profile'}
        </button>
      </section>

      {role === 'AFFILIATE' && <PayoutSettings profile={profile} />}

      <PasswordSection
        onChanged={async () => {
          // Every session was revoked, including this one. Send them to log in
          // again rather than letting the next request fail mysteriously.
          await signOut();
          router.push('/login');
        }}
      />
    </div>
  );
}

function PayoutSettings({ profile }: { profile: Profile | undefined }) {
  const qc = useQueryClient();
  const [method, setMethod] = useState<PayoutMethod>('paypal');
  const [value, setValue] = useState('');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!profile?.payoutMethod) return;
    const m = profile.payoutMethod.toLowerCase() as PayoutMethod;
    setMethod(m);
    setValue(
      m === 'paypal'
        ? profile.paypalEmail ?? ''
        : m === 'stripe_connect'
        ? profile.stripeConnectAccountId ?? ''
        : profile.manualPayoutDetails ?? ''
    );
  }, [profile]);

  const save = useMutation({
    mutationFn: () =>
      api('/api/me/payout-settings', {
        method: 'PUT',
        body: JSON.stringify(
          method === 'paypal'
            ? { method, paypalEmail: value }
            : method === 'stripe_connect'
            ? { method, stripeConnectAccountId: value }
            : { method, manualDetails: value }
        ),
      }),
    onSuccess: () => {
      setSaved(true);
      setError(null);
      qc.invalidateQueries({ queryKey: ['profile'] });
    },
    onError: (e: Error) => setError(e.message),
  });

  const label =
    method === 'paypal'
      ? 'PayPal email'
      : method === 'stripe_connect'
      ? 'Stripe Connect account ID'
      : 'Bank details or reference';

  return (
    <section className="rounded-lg border bg-white p-5">
      <h2 className="text-lg font-semibold">How you get paid</h2>
      <p className="mt-1 text-sm text-gray-600">
        Required before you can request a payout by a given method.
      </p>

      <Field label="Method">
        <select
          value={method}
          onChange={(e) => {
            setMethod(e.target.value as PayoutMethod);
            setValue('');
          }}
          className="block w-full rounded-md border-gray-300 shadow-sm"
        >
          <option value="paypal">PayPal</option>
          <option value="stripe_connect">Stripe Connect</option>
          <option value="manual">Manual / bank transfer</option>
        </select>
      </Field>

      <Field label={label}>
        {method === 'manual' ? (
          <textarea
            rows={2}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="block w-full rounded-md border-gray-300 shadow-sm"
          />
        ) : (
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="block w-full rounded-md border-gray-300 shadow-sm"
          />
        )}
      </Field>

      {saved && <p className="mt-2 text-sm text-green-700">Saved.</p>}
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      <button
        onClick={() => save.mutate()}
        disabled={value.trim() === '' || save.isPending}
        className="mt-3 rounded-md bg-brand-600 px-4 py-2 text-sm text-white hover:bg-brand-700 disabled:opacity-50"
      >
        Save payout details
      </button>
    </section>
  );
}

function PasswordSection({ onChanged }: { onChanged: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState<string | null>(null);

  const change = useMutation({
    mutationFn: () =>
      api('/api/me/password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      }),
    onSuccess: onChanged,
    onError: (e: Error) => setError(e.message),
  });

  return (
    <section className="rounded-lg border bg-white p-5">
      <h2 className="text-lg font-semibold">Password</h2>
      <p className="mt-1 text-sm text-gray-600">
        Changing this signs you out everywhere, including here.
      </p>

      <Field label="Current password">
        <input
          type="password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          className="block w-full rounded-md border-gray-300 shadow-sm"
        />
      </Field>
      <Field label="New password (min 8 characters)">
        <input
          type="password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          className="block w-full rounded-md border-gray-300 shadow-sm"
        />
      </Field>

      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      <button
        onClick={() => change.mutate()}
        disabled={current === '' || next.length < 8 || change.isPending}
        className="mt-3 rounded-md border border-gray-300 px-4 py-2 text-sm hover:bg-gray-50 disabled:opacity-50"
      >
        Change password
      </button>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="mt-3 block">
      <span className="block text-sm font-medium text-gray-700">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}
