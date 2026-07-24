import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-20">
      <h1 className="text-4xl font-bold text-gray-900">
        Affiliate &amp; Referral Marketing Platform
      </h1>
      <p className="mt-4 text-lg text-gray-600">
        Connect brands with affiliates. Track clicks, attribute conversions,
        compute commissions, manage payouts.
      </p>
      <div className="mt-8 flex gap-4">
        <Link
          href="/login"
          className="rounded-md bg-brand-600 px-4 py-2 text-white hover:bg-brand-700"
        >
          Sign in
        </Link>
        <Link
          href="/register"
          className="rounded-md border border-gray-300 px-4 py-2 text-gray-800 hover:bg-gray-50"
        >
          Create an account
        </Link>
        <Link
          href="/programs"
          className="rounded-md border border-gray-300 px-4 py-2 text-gray-800 hover:bg-gray-50"
        >
          Browse programs
        </Link>
      </div>
    </main>
  );
}
