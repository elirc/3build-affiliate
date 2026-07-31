import { describe, expect, it } from 'vitest';
import {
  InvalidCursorError,
  decodeCursor,
  encodeCursor,
  toCursorPage,
} from './pagination';

describe('cursor encoding', () => {
  it('round-trips a date and an id', () => {
    const at = new Date('2026-03-01T12:00:00.000Z');
    const decoded = decodeCursor(encodeCursor(at, 'conv-1'));

    expect(decoded.sortValue).toBe(at.toISOString());
    expect(decoded.id).toBe('conv-1');
  });

  it('rejects a tampered cursor rather than failing unhelpfully', () => {
    // A client that edits a cursor must get a 400, not a 500. Anything
    // arriving from outside is attacker-controlled, cursors included.
    expect(() => decodeCursor('not-base64!!')).toThrow(InvalidCursorError);
    expect(() => decodeCursor(Buffer.from('{}').toString('base64url'))).toThrow(
      InvalidCursorError
    );
    expect(() =>
      decodeCursor(Buffer.from(JSON.stringify({ v: 'x' })).toString('base64url'))
    ).toThrow(InvalidCursorError);
    expect(() =>
      decodeCursor(Buffer.from(JSON.stringify({ v: '', i: '' })).toString('base64url'))
    ).toThrow(InvalidCursorError);
    expect(() => decodeCursor('')).toThrow(InvalidCursorError);
  });

  it('is opaque enough that a client will not hand-build one', () => {
    // Not secrecy -- base64 is not encryption and the contents are the
    // client's own data. It is so clients cannot *construct* cursors: the
    // moment someone hand-builds one, the encoding is a public API and the
    // sort key can never change.
    const cursor = encodeCursor('2026-01-01T00:00:00.000Z', 'abc');
    expect(cursor).not.toContain('2026');
    expect(cursor).not.toContain('abc');
  });
});

describe('toCursorPage', () => {
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `id-${i}`,
      at: new Date(2026, 0, 1, 0, 0, i),
    }));

  it('trims the probe row and offers a cursor', () => {
    const page = toCursorPage(rows(21), 20, (r) => r.at);

    expect(page.data).toHaveLength(20);
    expect(page.hasMore).toBe(true);

    // The cursor points at the last row *returned*, not the extra one fetched
    // to detect there was more.
    expect(decodeCursor(page.nextCursor!).id).toBe('id-19');
  });

  it('returns a null cursor on the last page', () => {
    const page = toCursorPage(rows(5), 20, (r) => r.at);

    expect(page.data).toHaveLength(5);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it('returns a null cursor when the last page is exactly full', () => {
    // The case that breaks "I got pageSize rows, so there must be more".
    // Fetching pageSize + 1 is what makes this answerable at all, and the bug
    // only shows up on one dataset in pageSize.
    const page = toCursorPage(rows(20), 20, (r) => r.at);

    expect(page.data).toHaveLength(20);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it('handles an empty result', () => {
    const page = toCursorPage(rows(0), 20, (r) => r.at);

    expect(page.data).toHaveLength(0);
    expect(page.nextCursor).toBeNull();
    expect(page.hasMore).toBe(false);
  });
});
