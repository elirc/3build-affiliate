import { describe, expect, it } from 'vitest';
import { calculatePayoutBreakdown } from './payout-math';

describe('calculatePayoutBreakdown', () => {
  it('takes the platform percentage off the top', () => {
    expect(calculatePayoutBreakdown(120, 5)).toEqual({
      gross: '120.00',
      fee: '6.00',
      net: '114.00',
    });
  });

  it('always has fee plus net equal to gross', () => {
    // The invariant that matters. Rounding fee and net independently can
    // produce a penny the books cannot explain.
    const cases: Array<[number, number]> = [
      [133.33, 5],
      [0.01, 5],
      [99.99, 7.5],
      [1234.56, 12.5],
      [50, 0],
      [50, 50],
      [1.005, 5],
      [10.045, 3],
    ];

    for (const [gross, percent] of cases) {
      const b = calculatePayoutBreakdown(gross, percent);
      expect(
        Number(b.fee) + Number(b.net),
        `${gross} at ${percent}%`
      ).toBeCloseTo(Number(b.gross), 2);
    }
  });

  it('handles a zero fee', () => {
    expect(calculatePayoutBreakdown(100, 0)).toEqual({
      gross: '100.00',
      fee: '0.00',
      net: '100.00',
    });
  });

  it('rounds the fee to cents', () => {
    // 133.33 * 5% = 6.6665
    expect(calculatePayoutBreakdown(133.33, 5)).toEqual({
      gross: '133.33',
      fee: '6.67',
      net: '126.66',
    });
  });

  it('rounds a half-cent up rather than down', () => {
    // 1.005 is 1.00499999999999989 as a double, so the naive
    // Math.round(x * 100) / 100 rounds it *down* to 1.00.
    expect(calculatePayoutBreakdown(20.1, 5)).toEqual({
      gross: '20.10',
      fee: '1.01',
      net: '19.09',
    });
  });

  it('never produces more than two decimal places', () => {
    for (const [gross, percent] of [[0.03, 33.3], [7.77, 12.34]] as const) {
      const b = calculatePayoutBreakdown(gross, percent);
      for (const v of [b.gross, b.fee, b.net]) {
        expect(v).toMatch(/^-?\d+\.\d{2}$/);
      }
    }
  });
});
