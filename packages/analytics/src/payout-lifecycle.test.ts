import { describe, expect, it } from 'vitest';
import {
  allowedPayoutTransitions,
  canTransitionPayout,
  releasesCommissions,
  settlesCommissions,
  type PayoutStatusUpper,
} from './payout-lifecycle';

const ALL: PayoutStatusUpper[] = [
  'PENDING',
  'PROCESSING',
  'PAID',
  'FAILED',
  'CANCELLED',
];

describe('canTransitionPayout', () => {
  const legal: Array<[PayoutStatusUpper, PayoutStatusUpper]> = [
    ['PENDING', 'PROCESSING'],
    ['PENDING', 'FAILED'],
    ['PENDING', 'CANCELLED'],
    ['PROCESSING', 'PAID'],
    ['PROCESSING', 'FAILED'],
    ['FAILED', 'PROCESSING'],
  ];

  it.each(legal)('allows %s -> %s', (from, to) => {
    expect(canTransitionPayout(from, to)).toBe(true);
  });

  it('refuses every other pair', () => {
    const legalKeys = new Set(legal.map(([f, t]) => `${f}->${t}`));
    for (const from of ALL) {
      for (const to of ALL) {
        if (legalKeys.has(`${from}->${to}`)) continue;
        expect(canTransitionPayout(from, to), `${from} -> ${to}`).toBe(false);
      }
    }
  });

  it('treats PAID and CANCELLED as terminal', () => {
    expect(allowedPayoutTransitions('PAID')).toEqual([]);
    expect(allowedPayoutTransitions('CANCELLED')).toEqual([]);
  });

  it('lets a FAILED payout be retried', () => {
    // A transfer that bounced on a bad bank detail should be retryable once
    // the detail is fixed, without making the affiliate request it all again.
    expect(canTransitionPayout('FAILED', 'PROCESSING')).toBe(true);
  });

  it('never allows PENDING straight to PAID', () => {
    // Money must pass through PROCESSING, so there is always a record that
    // someone initiated the transfer before it completed.
    expect(canTransitionPayout('PENDING', 'PAID')).toBe(false);
  });
});

describe('commission consequences', () => {
  it('releases commissions when a payout dies', () => {
    expect(ALL.filter(releasesCommissions)).toEqual(['FAILED', 'CANCELLED']);
  });

  it('settles commissions only when the money actually left', () => {
    expect(ALL.filter(settlesCommissions)).toEqual(['PAID']);
  });

  it('never both releases and settles', () => {
    for (const s of ALL) {
      expect(releasesCommissions(s) && settlesCommissions(s)).toBe(false);
    }
  });
});
