import { describe, expect, it } from 'vitest';
import {
  buildTaggedUrl,
  isReservedSubIdKey,
  MAX_SUB_ID_KEYS,
  MAX_SUB_ID_VALUE_LENGTH,
  normaliseSubIds,
} from './sub-ids';

describe('normaliseSubIds', () => {
  it('keeps ordinary tags', () => {
    expect(
      normaliseSubIds({ subid: 'newsletter', placement: 'header' }).subIds
    ).toEqual({ subid: 'newsletter', placement: 'header' });
  });

  it('drops reserved keys', () => {
    // _ref is the attribution cookie id we append to the destination. An
    // affiliate who could define it as a sub-ID would overwrite it and break
    // their own attribution.
    const { subIds, rejected } = normaliseSubIds({ _ref: 'hijack', subid: 'ok' });

    expect(subIds).toEqual({ subid: 'ok' });
    expect(rejected).toContainEqual({ key: '_ref', reason: 'reserved' });
  });

  it('caps the number of keys', () => {
    const many = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`k${i}`, 'v'])
    );
    const { subIds, rejected } = normaliseSubIds(many);

    expect(Object.keys(subIds)).toHaveLength(MAX_SUB_ID_KEYS);
    expect(rejected.filter((r) => r.reason === 'too_many')).toHaveLength(7);
  });

  it('keeps the first keys, not an arbitrary five', () => {
    // Deterministic, so the same link always records the same tags rather
    // than a different subset depending on parameter order.
    const { subIds } = normaliseSubIds({
      a: '1', b: '2', c: '3', d: '4', e: '5', f: '6',
    });
    expect(Object.keys(subIds)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('truncates long values rather than rejecting them', () => {
    // A 4KB value is almost certainly a mistake, not an attack. Truncating
    // keeps the click and its tag; rejecting would lose both.
    const { subIds } = normaliseSubIds({ subid: 'x'.repeat(5000) });
    expect(subIds.subid).toHaveLength(MAX_SUB_ID_VALUE_LENGTH);
  });

  it('takes the first value when a parameter repeats', () => {
    // ?a=1&a=2 arrives as an array. Stringifying it gives "1,2", which reads
    // as a single value nobody actually sent.
    expect(normaliseSubIds({ subid: ['first', 'second'] }).subIds.subid).toBe(
      'first'
    );
  });

  it('ignores empty and null values', () => {
    const { subIds } = normaliseSubIds({ a: undefined, b: null, c: 'kept' });
    expect(subIds).toEqual({ c: 'kept' });
  });

  it('coerces non-string values', () => {
    expect(normaliseSubIds({ n: 42, b: true }).subIds).toEqual({
      n: '42',
      b: 'true',
    });
  });
});

describe('isReservedSubIdKey', () => {
  it('recognises the underscore prefix', () => {
    expect(isReservedSubIdKey('_ref')).toBe(true);
    expect(isReservedSubIdKey('_anything')).toBe(true);
    expect(isReservedSubIdKey('subid')).toBe(false);
  });
});

describe('buildTaggedUrl', () => {
  it('appends tags to a tracking URL', () => {
    const url = buildTaggedUrl('https://links.example.com/r/abc123', {
      subid: 'newsletter',
    });
    expect(url).toBe('https://links.example.com/r/abc123?subid=newsletter');
  });

  it('encodes values that need it', () => {
    const url = buildTaggedUrl('https://links.example.com/r/abc', {
      subid: 'spring sale & more',
    });
    expect(url).toContain('subid=spring+sale+%26+more');
  });

  it('will not let a builder emit a reserved key', () => {
    const url = buildTaggedUrl('https://links.example.com/r/abc', {
      _ref: 'nope',
      subid: 'yes',
    });
    expect(url).not.toContain('_ref');
    expect(url).toContain('subid=yes');
  });
});
