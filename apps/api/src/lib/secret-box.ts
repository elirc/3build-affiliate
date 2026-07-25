import crypto from 'node:crypto';

/**
 * Reversible encryption for secrets we have to be able to read back.
 *
 * Passwords are hashed, never encrypted, because we only ever need to answer
 * "did the user supply this same value?". A postback secret is different: to
 * verify an HMAC signature the server has to recompute it, which means it
 * needs the original bytes. Hashing would make verification impossible.
 *
 * So these are encrypted at rest instead. The trade-off is explicit: a
 * database dump alone does not reveal the secrets, but a dump plus
 * POSTBACK_ENCRYPTION_KEY does. That is the same bargain Stripe makes for
 * webhook signing secrets, and it is why the key belongs in a secret manager
 * and not in the database.
 *
 * AES-256-GCM is authenticated, so tampering with a stored ciphertext is
 * detected on decrypt rather than silently producing garbage.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96 bits, the size GCM is specified for
const TAG_BYTES = 16;

function keyFromHex(hexKey: string): Buffer {
  const key = Buffer.from(hexKey, 'hex');
  if (key.length !== 32) {
    throw new Error(
      'POSTBACK_ENCRYPTION_KEY must be 32 bytes of hex (64 characters)'
    );
  }
  return key;
}

/** Returns base64 of iv | authTag | ciphertext, so one column holds everything. */
export function sealSecret(plaintext: string, hexKey: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, keyFromHex(hexKey), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

export function openSecret(sealed: string, hexKey: string): string {
  const raw = Buffer.from(sealed, 'base64');
  if (raw.length <= IV_BYTES + TAG_BYTES) {
    throw new Error('Sealed secret is malformed');
  }

  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES);

  const decipher = crypto.createDecipheriv(ALGORITHM, keyFromHex(hexKey), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
    'utf8'
  );
}
