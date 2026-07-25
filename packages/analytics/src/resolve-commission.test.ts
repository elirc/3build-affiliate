import { describe, expect, it } from 'vitest';
import type { CommissionStructure } from '@affiliate/shared';
import { resolveCommissionStructure } from './resolve-commission';

const CAMPAIGN: CommissionStructure = { type: 'percentage', percentage: 20 };
const OVERRIDE: CommissionStructure = { type: 'percentage', percentage: 30 };

/** Stand-in for the Zod schema the service passes in. */
const isValid = (v: unknown): v is CommissionStructure =>
  typeof v === 'object' && v !== null && 'type' in v;

describe('resolveCommissionStructure', () => {
  it('falls back to the campaign when there is no relationship', () => {
    expect(resolveCommissionStructure(CAMPAIGN, null, isValid)).toEqual({
      structure: CAMPAIGN,
      origin: 'campaign',
    });
  });

  it('falls back to the campaign when no override is set', () => {
    expect(
      resolveCommissionStructure(
        CAMPAIGN,
        { status: 'APPROVED', customCommission: null },
        isValid
      )
    ).toEqual({ structure: CAMPAIGN, origin: 'campaign' });
  });

  it('prefers an override on an approved relationship', () => {
    expect(
      resolveCommissionStructure(
        CAMPAIGN,
        { status: 'APPROVED', customCommission: OVERRIDE },
        isValid
      )
    ).toEqual({ structure: OVERRIDE, origin: 'affiliate_override' });
  });

  it('ignores an override on a relationship that is not approved', () => {
    // A negotiated rate was part of an arrangement. If the arrangement has
    // ended, so has the rate -- otherwise a deactivated partner who somehow
    // converts keeps their premium terms.
    for (const status of ['PENDING', 'REJECTED', 'DEACTIVATED'] as const) {
      expect(
        resolveCommissionStructure(
          CAMPAIGN,
          { status, customCommission: OVERRIDE },
          isValid
        ),
        status
      ).toEqual({ structure: CAMPAIGN, origin: 'campaign' });
    }
  });

  it('ignores a malformed override rather than throwing', () => {
    // customCommission is a JSON column, so anything could be in there --
    // a bad migration, a hand-edited row. Paying the campaign default is the
    // safe failure: it is the rate that was published.
    expect(
      resolveCommissionStructure(
        CAMPAIGN,
        { status: 'APPROVED', customCommission: 'not-a-structure' },
        isValid
      )
    ).toEqual({ structure: CAMPAIGN, origin: 'campaign' });
  });

  it('reports where the rate came from', () => {
    // The UI needs this to say "custom rate" truthfully rather than guessing
    // by comparing numbers.
    expect(
      resolveCommissionStructure(
        CAMPAIGN,
        { status: 'APPROVED', customCommission: OVERRIDE },
        isValid
      ).origin
    ).toBe('affiliate_override');
  });
});
