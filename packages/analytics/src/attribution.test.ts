import { describe, expect, it } from 'vitest';
import { attribute } from './attribution';

const clicks = [
  { trackingLinkId: 'link-2', affiliateId: 'affiliate-2', timestamp: 200 },
  { trackingLinkId: 'link-1', affiliateId: 'affiliate-1', timestamp: 100 },
  { trackingLinkId: 'link-3', affiliateId: 'affiliate-3', timestamp: 300 },
];

describe('attribute', () => {
  it('returns no shares when there are no eligible clicks', () => {
    expect(attribute('LAST_CLICK', [])).toEqual([]);
  });

  it('attributes first-click conversions to the earliest click', () => {
    expect(attribute('FIRST_CLICK', clicks)).toEqual([
      { trackingLinkId: 'link-1', affiliateId: 'affiliate-1', share: 1 },
    ]);
  });

  it('attributes last-click conversions to the most recent click', () => {
    expect(attribute('LAST_CLICK', clicks)).toEqual([
      { trackingLinkId: 'link-3', affiliateId: 'affiliate-3', share: 1 },
    ]);
  });

  it('splits linear attribution across unique tracking links', () => {
    expect(
      attribute('LINEAR', [
        { trackingLinkId: 'link-1', affiliateId: 'affiliate-1', timestamp: 100 },
        { trackingLinkId: 'link-1', affiliateId: 'affiliate-1', timestamp: 150 },
        { trackingLinkId: 'link-2', affiliateId: 'affiliate-2', timestamp: 200 },
      ])
    ).toEqual([
      { trackingLinkId: 'link-1', affiliateId: 'affiliate-1', share: 0.5 },
      { trackingLinkId: 'link-2', affiliateId: 'affiliate-2', share: 0.5 },
    ]);
  });
});
