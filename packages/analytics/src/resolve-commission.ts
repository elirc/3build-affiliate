import type { CommissionStructure, RelationshipStatus } from '@affiliate/shared';

export interface CommissionSource {
  structure: CommissionStructure;
  /** Where the rate came from, so the UI can say "custom rate" honestly. */
  origin: 'campaign' | 'affiliate_override';
}

export interface RelationshipLike {
  status: RelationshipStatus;
  customCommission: unknown;
}

/**
 * Decides which commission structure applies to a given affiliate on a given
 * campaign.
 *
 * Resolution order is: the brand's per-affiliate override, then the campaign
 * default. Pure and separate from the conversion service so the precedence
 * can be asserted directly rather than inferred from a commission amount.
 *
 * The override is deliberately *not* applied when the relationship is anything
 * other than APPROVED. A deactivated partner should not keep a negotiated rate
 * that was part of an arrangement which has ended.
 */
export function resolveCommissionStructure(
  campaignStructure: CommissionStructure,
  relationship: RelationshipLike | null | undefined,
  isValidOverride: (value: unknown) => value is CommissionStructure
): CommissionSource {
  if (
    relationship &&
    relationship.status === 'APPROVED' &&
    relationship.customCommission != null &&
    isValidOverride(relationship.customCommission)
  ) {
    return { structure: relationship.customCommission, origin: 'affiliate_override' };
  }

  return { structure: campaignStructure, origin: 'campaign' };
}
