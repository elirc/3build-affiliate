import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TOLERANCE_MS,
  generateApiKeyPair,
  signPostback,
  verifyPostbackSignature,
} from './postback-signature';

const SECRET = 'sk_test_secret_value';
const NOW = 1_800_000_000_000;
const BODY = JSON.stringify({ externalOrderId: 'order-1', conversionValue: 149.99 });

function signedAt(ms: number, body = BODY, secret = SECRET) {
  const timestamp = String(ms);
  return { timestamp, signature: signPostback(secret, timestamp, body) };
}

describe('verifyPostbackSignature', () => {
  it('accepts a correctly signed request', () => {
    const { timestamp, signature } = signedAt(NOW);

    expect(
      verifyPostbackSignature({
        secret: SECRET,
        timestamp,
        signature,
        rawBody: BODY,
        nowMs: NOW,
      })
    ).toEqual({ ok: true });
  });

  it('rejects a tampered body', () => {
    // The attack this exists to stop: capture a real postback, change the
    // order value, replay it.
    const { timestamp, signature } = signedAt(NOW);
    const tampered = JSON.stringify({
      externalOrderId: 'order-1',
      conversionValue: 14999.0,
    });

    expect(
      verifyPostbackSignature({
        secret: SECRET,
        timestamp,
        signature,
        rawBody: tampered,
        nowMs: NOW,
      })
    ).toEqual({ ok: false, reason: 'signature_mismatch' });
  });

  it('rejects a signature made with a different secret', () => {
    const { timestamp, signature } = signedAt(NOW, BODY, 'sk_someone_elses_key');

    expect(
      verifyPostbackSignature({
        secret: SECRET,
        timestamp,
        signature,
        rawBody: BODY,
        nowMs: NOW,
      })
    ).toEqual({ ok: false, reason: 'signature_mismatch' });
  });

  it('rejects a replay from outside the tolerance window', () => {
    const { timestamp, signature } = signedAt(NOW);

    expect(
      verifyPostbackSignature({
        secret: SECRET,
        timestamp,
        signature,
        rawBody: BODY,
        nowMs: NOW + DEFAULT_TOLERANCE_MS + 1,
      })
    ).toEqual({ ok: false, reason: 'timestamp_out_of_tolerance' });
  });

  it('tolerates modest clock drift in both directions', () => {
    const drift = DEFAULT_TOLERANCE_MS - 1;
    const { timestamp, signature } = signedAt(NOW);

    for (const now of [NOW + drift, NOW - drift]) {
      expect(
        verifyPostbackSignature({
          secret: SECRET,
          timestamp,
          signature,
          rawBody: BODY,
          nowMs: now,
        }).ok
      ).toBe(true);
    }
  });

  it('rejects a timestamp far in the future', () => {
    // Symmetry matters: allowing future timestamps would let anyone who can
    // set their own clock mint a signature that stays valid for as long as
    // they like.
    const { timestamp, signature } = signedAt(NOW + DEFAULT_TOLERANCE_MS * 10);

    expect(
      verifyPostbackSignature({
        secret: SECRET,
        timestamp,
        signature,
        rawBody: BODY,
        nowMs: NOW,
      })
    ).toEqual({ ok: false, reason: 'timestamp_out_of_tolerance' });
  });

  it('rejects a timestamp moved without re-signing', () => {
    // The timestamp is part of the signed payload, so refreshing it alone
    // invalidates the signature. This is what stops a captured request from
    // being replayed forever.
    const { signature } = signedAt(NOW);

    expect(
      verifyPostbackSignature({
        secret: SECRET,
        timestamp: String(NOW + 1000),
        signature,
        rawBody: BODY,
        nowMs: NOW + 1000,
      })
    ).toEqual({ ok: false, reason: 'signature_mismatch' });
  });

  it('reports missing and malformed inputs distinctly for logging', () => {
    const { timestamp, signature } = signedAt(NOW);
    const base = { secret: SECRET, rawBody: BODY, nowMs: NOW };

    expect(
      verifyPostbackSignature({ ...base, timestamp: undefined, signature })
    ).toEqual({ ok: false, reason: 'missing_timestamp' });

    expect(
      verifyPostbackSignature({ ...base, timestamp, signature: undefined })
    ).toEqual({ ok: false, reason: 'missing_signature' });

    expect(
      verifyPostbackSignature({ ...base, timestamp: 'not-a-number', signature })
    ).toEqual({ ok: false, reason: 'malformed_timestamp' });
  });

  it('is not confused by a signature of the wrong length', () => {
    // timingSafeEqual throws when the buffers differ in length, so this would
    // be a 500 rather than a 401 if the length check were missing.
    const { timestamp } = signedAt(NOW);

    expect(
      verifyPostbackSignature({
        secret: SECRET,
        timestamp,
        signature: 'abc',
        rawBody: BODY,
        nowMs: NOW,
      })
    ).toEqual({ ok: false, reason: 'signature_mismatch' });
  });
});

describe('generateApiKeyPair', () => {
  it('produces distinguishable, prefixed, unique values', () => {
    const a = generateApiKeyPair();
    const b = generateApiKeyPair();

    expect(a.keyId).toMatch(/^ak_[0-9a-f]{24}$/);
    expect(a.secret).toMatch(/^sk_[0-9a-f]{64}$/);
    expect(a.keyId).not.toBe(b.keyId);
    expect(a.secret).not.toBe(b.secret);
  });
});
