import type { CampaignStatus } from '@affiliate/shared';

/**
 * The campaign state machine.
 *
 * Pure and data-driven so the rules can be asserted in a unit test and read at
 * a glance, rather than being spread across a service as a chain of ifs.
 *
 *   DRAFT ──► ACTIVE ⇄ PAUSED
 *               │        │
 *               └──► ENDED ◄┘
 *
 * DRAFT is where a campaign is still being written. ENDED is terminal: a
 * campaign that has paid commissions should never be editable again, and
 * "un-ending" one would silently resurrect its tracking links.
 */
export const CAMPAIGN_TRANSITIONS: Record<CampaignStatus, CampaignStatus[]> = {
  DRAFT: ['ACTIVE'],
  ACTIVE: ['PAUSED', 'ENDED'],
  PAUSED: ['ACTIVE', 'ENDED'],
  ENDED: [],
};

export function canTransition(from: CampaignStatus, to: CampaignStatus): boolean {
  return CAMPAIGN_TRANSITIONS[from].includes(to);
}

export function allowedTransitions(from: CampaignStatus): CampaignStatus[] {
  return CAMPAIGN_TRANSITIONS[from];
}

/**
 * Whether affiliates may join and build links.
 *
 * Only ACTIVE. A paused campaign keeps serving its existing links -- pausing
 * is meant to stop *new* promotion, not to strand traffic an affiliate has
 * already paid to acquire -- but it accepts no new partners.
 */
export function acceptsNewAffiliates(status: CampaignStatus): boolean {
  return status === 'ACTIVE';
}

/**
 * Whether existing tracking links should still redirect.
 *
 * Everything except ENDED. This is the asymmetry that matters: a brand
 * pausing a campaign is making a commercial decision, and an affiliate whose
 * blog post has been live for six months should not have their traffic
 * silently dropped because of it.
 */
export function servesTraffic(status: CampaignStatus): boolean {
  return status !== 'ENDED';
}

/**
 * Whether new conversions may be reported.
 *
 * Paused campaigns still accept them: a sale can legitimately land days after
 * the click that earned it, and the lock period exists precisely because
 * money moves slower than clicks. Refusing them would quietly rob affiliates
 * of conversions they had already earned.
 */
export function acceptsConversions(status: CampaignStatus): boolean {
  return status === 'ACTIVE' || status === 'PAUSED';
}

/**
 * Fields that stop being editable once a campaign has gone live.
 *
 * Changing the commission structure or the attribution model under affiliates
 * who already joined would rewrite the deal they agreed to. They keep their
 * terms; a brand that wants different terms launches a different campaign.
 */
export const LOCKED_AFTER_ACTIVATION = [
  'commissionStructure',
  'attributionModel',
  'attributionWindowDays',
  'cookieLifetimeDays',
  'lockPeriodDays',
] as const;

export type LockedField = (typeof LOCKED_AFTER_ACTIVATION)[number];

export function lockedFieldsIn(input: object): LockedField[] {
  return LOCKED_AFTER_ACTIVATION.filter((f) => f in input);
}
