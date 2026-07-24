import { describe, expect, it } from 'vitest';
import { calculateCommission } from './commission-calc';

describe('calculateCommission', () => {
  it('returns flat commissions unchanged', () => {
    expect(calculateCommission({ type: 'flat_per_sale', flatAmount: 25 }, 999)).toBe(25);
  });

  it('rounds percentage commissions to cents', () => {
    expect(calculateCommission({ type: 'percentage', percentage: 12.5 }, 19.99)).toBe(2.5);
  });

  it('applies percentage commission min and max bounds', () => {
    const structure = {
      type: 'percentage' as const,
      percentage: 20,
      minCommission: 15,
      maxCommission: 50,
    };

    expect(calculateCommission(structure, 40)).toBe(15);
    expect(calculateCommission(structure, 400)).toBe(50);
  });

  it('selects tiered commission from prior approved sale count', () => {
    const structure = {
      type: 'tiered_percentage' as const,
      tiers: [
        { minSales: 0, percentage: 10 },
        { minSales: 10, percentage: 15 },
        { minSales: 25, percentage: 20 },
      ],
    };

    expect(calculateCommission(structure, 100, 9)).toBe(10);
    expect(calculateCommission(structure, 100, 10)).toBe(15);
    expect(calculateCommission(structure, 100, 30)).toBe(20);
  });

  it('calculates recurring commission from the first invoice value', () => {
    expect(
      calculateCommission({ type: 'recurring', percentage: 30, recurringMonths: 12 }, 80)
    ).toBe(24);
  });
});
