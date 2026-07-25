import crypto from 'node:crypto';

/**
 * HMAC signing for server-to-server conversion postbacks.
 *
 * The brand's storefront signs each request with a secret we issued. This is
 * the same scheme Stripe and GitHub use for webhooks, in the same direction:
 * the sender proves it holds the secret without ever transmitting it.
 *
 * Everything here is pure -- no database, no clock of its own -- so the
 * interesting cases (tampering, replay, wrong key) are cheap to test.
 */

export const SIGNATURE_HEADER = 'x-affiliate-signature';
export const KEY_HEADER = 'x-affiliate-key';
export const TIMESTAMP_HEADER = 'x-affiliate-timestamp';

/**
 * How far a request's timestamp may be from ours. Bounds how long a captured
 * request stays replayable, while tolerating ordinary clock drift between two
 * machines that have never met.
 */
export const DEFAULT_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * The bytes that get signed.
 *
 * The timestamp is inside the signature, not merely alongside it. If it were
 * only a header, an attacker could replay a captured body with a fresh
 * timestamp and the signature would still verify.
 */
export function buildSignaturePayload(timestamp: string, rawBody: string): string {
  return `${timestamp}.${rawBody}`;
}

export function signPostback(
  secret: string,
  timestamp: string,
  rawBody: string
): string {
  return crypto
    .createHmac('sha256', secret)
    .update(buildSignaturePayload(timestamp, rawBody))
    .digest('hex');
}

export type SignatureFailure =
  | 'missing_timestamp'
  | 'malformed_timestamp'
  | 'timestamp_out_of_tolerance'
  | 'missing_signature'
  | 'signature_mismatch';

export type SignatureResult =
  | { ok: true }
  | { ok: false; reason: SignatureFailure };

export interface VerifyInput {
  secret: string;
  timestamp: string | undefined;
  signature: string | undefined;
  rawBody: string;
  nowMs: number;
  toleranceMs?: number;
}

/**
 * Verifies a postback signature.
 *
 * Returns a reason on failure for logging only. Callers must not pass the
 * reason back to the sender: telling an attacker whether the timestamp or the
 * signature was wrong helps them, and helps a legitimate integrator very
 * little compared with reading the docs.
 */
export function verifyPostbackSignature(input: VerifyInput): SignatureResult {
  const { secret, timestamp, signature, rawBody, nowMs } = input;
  const toleranceMs = input.toleranceMs ?? DEFAULT_TOLERANCE_MS;

  if (!timestamp) return { ok: false, reason: 'missing_timestamp' };
  if (!signature) return { ok: false, reason: 'missing_signature' };

  const sentMs = Number(timestamp);
  if (!Number.isFinite(sentMs)) {
    return { ok: false, reason: 'malformed_timestamp' };
  }

  // Absolute difference: a timestamp far in the future is as suspicious as one
  // far in the past, and tolerating it would extend the replay window
  // indefinitely for anyone who can set their own clock.
  if (Math.abs(nowMs - sentMs) > toleranceMs) {
    return { ok: false, reason: 'timestamp_out_of_tolerance' };
  }

  const expected = signPostback(secret, timestamp, rawBody);

  // Both are hex of a fixed-length digest, so a length mismatch means the
  // input was malformed rather than merely wrong. timingSafeEqual throws on
  // unequal lengths, so this check has to come first regardless.
  const a = Buffer.from(signature, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'signature_mismatch' };
  }

  return { ok: true };
}

/**
 * Generates a new key pair. The secret is returned once and never stored in
 * plaintext -- only the caller ever sees it again.
 */
export function generateApiKeyPair(): { keyId: string; secret: string } {
  return {
    keyId: `ak_${crypto.randomBytes(12).toString('hex')}`,
    secret: `sk_${crypto.randomBytes(32).toString('hex')}`,
  };
}
