'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, tokenStore } from '@/lib/api';

export default function RegisterPage() {
  const router = useRouter();
  const [form, setForm] = useState({
    email: '',
    password: '',
    firstName: '',
    lastName: '',
    role: 'AFFILIATE' as 'BRAND' | 'AFFILIATE',
    companyName: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const body =
        form.role === 'BRAND'
          ? form
          : { ...form, companyName: undefined };
      const tokens = await api<{ accessToken: string; refreshToken: string }>(
        '/api/auth/register',
        { method: 'POST', body: JSON.stringify(body) }
      );
      tokenStore.set(tokens);
      router.push(form.role === 'BRAND' ? '/brand/dashboard' : '/affiliate/dashboard');
    } catch (err: any) {
      setError(err.message ?? 'Registration failed');
    } finally {
      setLoading(false);
    }
  }

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  return (
    <main className="mx-auto max-w-md px-6 py-16">
      <h1 className="text-2xl font-semibold">Create an account</h1>
      <form onSubmit={onSubmit} className="mt-6 space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <input
            placeholder="First name"
            value={form.firstName}
            onChange={(e) => set('firstName', e.target.value)}
            className="rounded-md border-gray-300 shadow-sm"
            required
          />
          <input
            placeholder="Last name"
            value={form.lastName}
            onChange={(e) => set('lastName', e.target.value)}
            className="rounded-md border-gray-300 shadow-sm"
            required
          />
        </div>
        <input
          type="email"
          placeholder="Email"
          value={form.email}
          onChange={(e) => set('email', e.target.value)}
          className="block w-full rounded-md border-gray-300 shadow-sm"
          required
        />
        <input
          type="password"
          placeholder="Password (min 8 chars)"
          value={form.password}
          onChange={(e) => set('password', e.target.value)}
          className="block w-full rounded-md border-gray-300 shadow-sm"
          required
          minLength={8}
        />
        <select
          value={form.role}
          onChange={(e) => set('role', e.target.value as 'BRAND' | 'AFFILIATE')}
          className="block w-full rounded-md border-gray-300 shadow-sm"
        >
          <option value="AFFILIATE">I'm an affiliate (promoting products)</option>
          <option value="BRAND">I'm a brand (running a program)</option>
        </select>
        {form.role === 'BRAND' && (
          <input
            placeholder="Company name"
            value={form.companyName}
            onChange={(e) => set('companyName', e.target.value)}
            className="block w-full rounded-md border-gray-300 shadow-sm"
            required
          />
        )}
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-md bg-brand-600 px-4 py-2 text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {loading ? 'Creating…' : 'Create account'}
        </button>
      </form>
    </main>
  );
}
