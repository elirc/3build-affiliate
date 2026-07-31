import { describe, expect, it } from 'vitest';
import { MAX_REQUEST_ID_LENGTH, sanitiseRequestId } from './request-id';

const NUL = String.fromCharCode(0);
const ESC = String.fromCharCode(27);
const DEL = String.fromCharCode(127);
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const TAB = String.fromCharCode(9);

describe('sanitiseRequestId', () => {
  it('accepts an ordinary id', () => {
    expect(sanitiseRequestId('4f1a-9c3e')).toBe('4f1a-9c3e');
  });

  it('accepts a value exactly at the limit and rejects one byte more', () => {
    const atLimit = 'a'.repeat(MAX_REQUEST_ID_LENGTH);
    expect(sanitiseRequestId(atLimit)).toBe(atLimit);
    expect(sanitiseRequestId(atLimit + 'a')).toBeNull();
  });

  it('rejects a 2KB header outright rather than truncating it', () => {
    // Truncating would keep echoing bytes the client chose, and would map two
    // different ids onto the same prefix.
    expect(sanitiseRequestId('x'.repeat(2048))).toBeNull();
  });

  it('rejects a newline -- the log injection case', () => {
    const forged = 'abc' + LF + '{"level":30,"msg":"payout approved"}';
    expect(sanitiseRequestId(forged)).toBeNull();
  });

  it('rejects a carriage return -- the header injection case', () => {
    expect(sanitiseRequestId('abc' + CR + LF + 'Set-Cookie: admin=1')).toBeNull();
  });

  it('rejects other control characters and non-ASCII bytes', () => {
    expect(sanitiseRequestId('abc' + NUL + 'def')).toBeNull();
    expect(sanitiseRequestId('abc' + ESC + '[2Jdef')).toBeNull();
    expect(sanitiseRequestId('abc' + TAB + 'def')).toBeNull();
    expect(sanitiseRequestId('abc' + DEL)).toBeNull();
    // Node rejects these in a header value too, so accepting one here would
    // only move the failure to `setHeader`.
    expect(sanitiseRequestId('café')).toBeNull();
  });

  it('rejects an empty string and anything that is not a string', () => {
    expect(sanitiseRequestId('')).toBeNull();
    expect(sanitiseRequestId(undefined)).toBeNull();
    expect(sanitiseRequestId(['a', 'b'])).toBeNull();
    expect(sanitiseRequestId(42)).toBeNull();
  });
});
