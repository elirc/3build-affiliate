import { describe, expect, it } from 'vitest';
import { openSecret, sealSecret } from './secret-box';

const KEY = 'a'.repeat(64);
const OTHER_KEY = 'b'.repeat(64);

describe('secret-box', () => {
  it('round-trips a secret', () => {
    const secret = 'sk_0123456789abcdef';
    expect(openSecret(sealSecret(secret, KEY), KEY)).toBe(secret);
  });

  it('produces a different ciphertext each time', () => {
    // A fresh IV per seal. Without it, identical secrets would produce
    // identical ciphertexts and the database would leak which keys match.
    const a = sealSecret('same-secret', KEY);
    const b = sealSecret('same-secret', KEY);

    expect(a).not.toBe(b);
    expect(openSecret(a, KEY)).toBe(openSecret(b, KEY));
  });

  it('refuses to decrypt with the wrong key', () => {
    const sealed = sealSecret('sk_secret', KEY);
    expect(() => openSecret(sealed, OTHER_KEY)).toThrow();
  });

  it('detects a tampered ciphertext', () => {
    // This is why GCM and not CBC: authenticated encryption turns tampering
    // into an error rather than into plausible-looking plaintext.
    const sealed = sealSecret('sk_secret', KEY);
    const raw = Buffer.from(sealed, 'base64');
    raw[raw.length - 1] ^= 0xff;

    expect(() => openSecret(raw.toString('base64'), KEY)).toThrow();
  });

  it('rejects a key of the wrong length rather than silently padding', () => {
    expect(() => sealSecret('x', 'abcd')).toThrow(/32 bytes of hex/);
  });

  it('rejects a truncated sealed value', () => {
    expect(() => openSecret(Buffer.from('short').toString('base64'), KEY)).toThrow(
      /malformed/
    );
  });
});
