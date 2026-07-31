import { describe, expect, it } from 'vitest';
import { canonicalise, fingerprint } from './fingerprint';

describe('fingerprint', () => {
  it('ignores key order', () => {
    // The reason canonicalisation exists. Two JSON serialisers -- or two
    // versions of the same client -- will disagree about key order for
    // identical data, and treating that as a different body would reject
    // legitimate retries.
    expect(fingerprint({ a: 1, b: 2 })).toBe(fingerprint({ b: 2, a: 1 }));
  });

  it('ignores key order at every depth', () => {
    expect(fingerprint({ outer: { a: 1, b: [{ x: 1, y: 2 }] } })).toBe(
      fingerprint({ outer: { b: [{ y: 2, x: 1 }], a: 1 } })
    );
  });

  it('does not reorder arrays', () => {
    // `[1,2]` and `[2,1]` are genuinely different bodies. Sorting them would
    // make two different requests look like a retry of each other.
    expect(fingerprint({ items: [1, 2] })).not.toBe(fingerprint({ items: [2, 1] }));
  });

  it('distinguishes different values', () => {
    expect(fingerprint({ amount: 100 })).not.toBe(fingerprint({ amount: 101 }));
    expect(fingerprint({ amount: 100 })).not.toBe(fingerprint({ amount: '100' }));
  });

  it('treats a missing key and an undefined value as the same', () => {
    // `JSON.stringify` drops undefined, so a client that sends `{a:1}` and one
    // that sends `{a:1, b:undefined}` put identical bytes on the wire.
    expect(fingerprint({ a: 1 })).toBe(fingerprint({ a: 1, b: undefined }));
  });

  it('distinguishes null from absent', () => {
    // Unlike undefined, null survives serialisation and means something.
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 1, b: null }));
  });

  it('handles an empty and an absent body', () => {
    expect(fingerprint(undefined)).toBe(fingerprint(null));
    expect(fingerprint({})).not.toBe(fingerprint(null));
  });

  it('produces a hex sha256', () => {
    expect(fingerprint({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('canonicalises without mutating the input', () => {
    const input = { b: 2, a: 1 };
    canonicalise(input);
    expect(Object.keys(input)).toEqual(['b', 'a']);
  });
});
