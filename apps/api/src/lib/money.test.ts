import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { money } from './money';

describe('money', () => {
  it('always gives two decimal places', () => {
    // The bug this exists to stop: Prisma's Decimal serialises 120.00 as
    // "120", so the same amount had two spellings depending on the endpoint.
    expect(money(new Prisma.Decimal('120.00'))).toBe('120.00');
    expect(money(120)).toBe('120.00');
    expect(money('120')).toBe('120.00');
    expect(money('120.5')).toBe('120.50');
  });

  it('treats a missing value as zero rather than as "NaN"', () => {
    expect(money(null)).toBe('0.00');
    expect(money(undefined)).toBe('0.00');
  });

  it('keeps cents intact', () => {
    expect(money(new Prisma.Decimal('19.99'))).toBe('19.99');
    expect(money(new Prisma.Decimal('0.01'))).toBe('0.01');
  });

  it('handles negative amounts, which clawbacks produce', () => {
    expect(money(new Prisma.Decimal('-42.50'))).toBe('-42.50');
  });
});
