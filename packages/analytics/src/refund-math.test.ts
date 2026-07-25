import { describe, expect, it } from 'vitest';
import { calculateRefund } from './refund-math';

describe('calculateRefund', () => {
  it('takes back everything on a full refund', () => {
    expect(calculateRefund(100, 20, 100)).toEqual({
      remainingValue: '0.00',
      remainingCommission: '0.00',
      clawbackAmount: '20.00',
      isFullRefund: true,
    });
  });

  it('reduces the commission in proportion to a partial refund', () => {
    // Half the order came back, so half the commission does.
    expect(calculateRefund(100, 20, 50)).toEqual({
      remainingValue: '50.00',
      remainingCommission: '10.00',
      clawbackAmount: '10.00',
      isFullRefund: false,
    });
  });

  it('keeps kept-plus-clawed-back equal to the original commission', () => {
    // The invariant. Rounding both sides independently can leave a penny
    // that neither the affiliate nor the brand can account for.
    const cases: Array<[number, number, number]> = [
      [149.99, 30, 49.99],
      [33.33, 6.67, 11.11],
      [100, 20, 33.33],
      [0.03, 0.01, 0.01],
      [999.99, 149.99, 1],
    ];

    for (const [value, commission, refund] of cases) {
      const r = calculateRefund(value, commission, refund);
      expect(
        Number(r.remainingCommission) + Number(r.clawbackAmount),
        `${value}/${commission}/${refund}`
      ).toBeCloseTo(commission, 2);
    }
  });

  it('does not recompute against the reduced order value', () => {
    // The subtle one. A 20% structure with a $15 minimum on a $40 order pays
    // $15. Recomputing that structure against the remaining $20 would *also*
    // pay $15 -- the affiliate would keep their whole commission after
    // refunding half the order. Proportional reduction gives $7.50.
    expect(calculateRefund(40, 15, 20).remainingCommission).toBe('7.50');
  });

  it('rejects a refund larger than the order', () => {
    expect(() => calculateRefund(100, 20, 150)).toThrow(/cannot exceed/);
  });

  it('rejects a zero or negative refund', () => {
    expect(() => calculateRefund(100, 20, 0)).toThrow(/must be positive/);
    expect(() => calculateRefund(100, 20, -10)).toThrow(/must be positive/);
  });

  it('treats a refund of the exact order value as full', () => {
    expect(calculateRefund(19.99, 4, 19.99).isFullRefund).toBe(true);
  });

  it('handles a one-cent refund without losing the rest', () => {
    const r = calculateRefund(100, 20, 0.01);
    expect(r.remainingValue).toBe('99.99');
    expect(Number(r.remainingCommission) + Number(r.clawbackAmount)).toBeCloseTo(20, 2);
  });
});
