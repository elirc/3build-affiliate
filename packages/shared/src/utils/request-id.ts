/**
 * The header that carries a correlation id between deployables.
 *
 * Lower case because Node lower-cases inbound header names, so this constant
 * can be used to read as well as to write.
 */
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Long enough for a UUID, a W3C trace id or a load balancer's own id, short
 * enough that it cannot be used to pad every log line we write.
 */
export const MAX_REQUEST_ID_LENGTH = 128;

/**
 * Printable US-ASCII, and nothing else.
 *
 * The value arrives from the client and then leaves again in a response header
 * and in every log line for the request, which makes three separate problems
 * out of one unvalidated string:
 *
 * 1. A `\n` splits a JSON log record in two, so an attacker can forge entries
 *    that look exactly like ours -- the classic log injection.
 * 2. A `\r` splits the HTTP response header block (header injection).
 * 3. Node's `setHeader` throws on control characters, so a hostile header
 *    would turn into a 500 rather than a redirect.
 */
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

/**
 * Returns the id if it can be trusted, or `null` if the caller should generate
 * one instead.
 *
 * Rejects rather than truncates. Truncating a 2KB header would still echo
 * bytes the attacker chose, and two different ids sharing a 128-byte prefix
 * would collapse into one -- which defeats the only thing a correlation id is
 * for.
 */
export function sanitiseRequestId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (raw.length === 0 || raw.length > MAX_REQUEST_ID_LENGTH) return null;
  if (!PRINTABLE_ASCII.test(raw)) return null;
  return raw;
}
