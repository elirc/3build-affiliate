import { describe, expect, it } from 'vitest';
import { formatCommission } from './commission-format';

describe('formatCommission', () => {
  it('describes a flat commission', () => {
    expect(formatCommission({ type: 'flat_per_sale', flatAmount: 25 })).toBe(
      '$25.00 per sale'
    );
  });

  it('describes a plain percentage without trailing zeros', () => {
    expect(formatCommission({ type: 'percentage', percentage: 20 })).toBe(
      '20% of sale'
    );
    expect(formatCommission({ type: 'percentage', percentage: 12.5 })).toBe(
      '12.5% of sale'
    );
  });

  it('mentions min and max bounds when present', () => {
    expect(
      formatCommission({
        type: 'percentage',
        percentage: 20,
        minCommission: 15,
        maxCommission: 50,
      })
    ).toBe('20% of sale (min $15.00, max $50.00)');

    expect(
      formatCommission({ type: 'percentage', percentage: 20, minCommission: 15 })
    ).toBe('20% of sale (min $15.00)');
  });

  it('gives a range for tiered commissions', () => {
    expect(
      formatCommission({
        type: 'tiered_percentage',
        tiers: [
          { minSales: 0, percentage: 15 },
          { minSales: 10, percentage: 25 },
        ],
      })
    ).toBe('15%–25% of sale (tiered)');
  });

  it('collapses a tiered range whose ends are equal', () => {
    // "20%-20%" reads as a bug rather than as a deliberate flat rate.
    expect(
      formatCommission({
        type: 'tiered_percentage',
        tiers: [
          { minSales: 0, percentage: 20 },
          { minSales: 10, percentage: 20 },
        ],
      })
    ).toBe('20% of sale (tiered)');
  });

  it('pluralises recurring months correctly', () => {
    expect(
      formatCommission({ type: 'recurring', percentage: 30, recurringMonths: 12 })
    ).toBe('30% of sale, recurring for 12 months');

    expect(
      formatCommission({ type: 'recurring', percentage: 30, recurringMonths: 1 })
    ).toBe('30% of sale, recurring for 1 month');
  });
});
