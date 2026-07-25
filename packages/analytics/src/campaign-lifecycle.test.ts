import { describe, expect, it } from 'vitest';
import type { CampaignStatus } from '@affiliate/shared';
import {
  acceptsConversions,
  acceptsNewAffiliates,
  allowedTransitions,
  canTransition,
  lockedFieldsIn,
  servesTraffic,
} from './campaign-lifecycle';

const ALL: CampaignStatus[] = ['DRAFT', 'ACTIVE', 'PAUSED', 'ENDED'];

describe('canTransition', () => {
  const legal: Array<[CampaignStatus, CampaignStatus]> = [
    ['DRAFT', 'ACTIVE'],
    ['ACTIVE', 'PAUSED'],
    ['ACTIVE', 'ENDED'],
    ['PAUSED', 'ACTIVE'],
    ['PAUSED', 'ENDED'],
  ];

  it.each(legal)('allows %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  // Exhaustive: every pair not in the legal list must be refused. Written this
  // way so that adding a status to the enum without deciding its transitions
  // fails the suite rather than quietly permitting nothing.
  it('refuses every other pair', () => {
    const legalKeys = new Set(legal.map(([f, t]) => `${f}->${t}`));
    for (const from of ALL) {
      for (const to of ALL) {
        if (legalKeys.has(`${from}->${to}`)) continue;
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(false);
      }
    }
  });

  it('treats ENDED as terminal', () => {
    expect(allowedTransitions('ENDED')).toEqual([]);
  });

  it('refuses a transition to the same status', () => {
    for (const s of ALL) expect(canTransition(s, s)).toBe(false);
  });
});

describe('capability predicates', () => {
  it('only lets affiliates join an active campaign', () => {
    expect(ALL.filter(acceptsNewAffiliates)).toEqual(['ACTIVE']);
  });

  it('keeps serving traffic until the campaign ends', () => {
    // A paused campaign must not strand an affiliate's existing placements.
    expect(ALL.filter(servesTraffic)).toEqual(['DRAFT', 'ACTIVE', 'PAUSED']);
  });

  it('accepts conversions while active or paused', () => {
    // A sale can land days after the click that earned it.
    expect(ALL.filter(acceptsConversions)).toEqual(['ACTIVE', 'PAUSED']);
  });

  it('never accepts conversions once ended', () => {
    expect(acceptsConversions('ENDED')).toBe(false);
  });
});

describe('lockedFieldsIn', () => {
  it('finds commercial terms in an update payload', () => {
    expect(
      lockedFieldsIn({ name: 'New name', commissionStructure: { type: 'percentage' } })
    ).toEqual(['commissionStructure']);
  });

  it('ignores payloads that only touch presentation', () => {
    expect(lockedFieldsIn({ name: 'New name', description: 'x' })).toEqual([]);
  });

  it('reports every locked field present, not just the first', () => {
    expect(
      lockedFieldsIn({ attributionModel: 'LINEAR', lockPeriodDays: 7, name: 'x' })
    ).toEqual(['attributionModel', 'lockPeriodDays']);
  });
});
