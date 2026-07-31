import { describe, expect, it } from 'vitest';
import {
  contextLogFields,
  getContext,
  getRequestId,
  newRequestId,
  runWithContext,
  updateContext,
} from './request-context';

describe('request context', () => {
  it('is empty outside a request', () => {
    // A worker tick and a startup line must not claim a request id they do not
    // have -- a fabricated correlation is worse than none.
    expect(getContext()).toBeUndefined();
    expect(getRequestId()).toBeUndefined();
    expect(contextLogFields()).toEqual({});
  });

  it('is readable anywhere inside the callback, including after an await', () => {
    return runWithContext({ requestId: 'req-1' }, async () => {
      expect(getRequestId()).toBe('req-1');
      await new Promise((resolve) => setTimeout(resolve, 5));
      // The interesting half: the store has to survive the await, or nothing
      // below the first I/O call in a service would be correlated.
      expect(getRequestId()).toBe('req-1');
    });
  });

  it('does not leak between two interleaved flows', async () => {
    // The test that actually exercises AsyncLocalStorage. Both flows are in
    // flight at the same time and each yields in the middle, so a naive
    // module-level "current request id" would fail this and only this.
    const seen: string[] = [];

    async function flow(id: string, delayMs: number) {
      return runWithContext({ requestId: id }, async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        updateContext({ userId: `user-for-${id}` });
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        seen.push(`${getRequestId()}/${getContext()?.userId}`);
        return contextLogFields();
      });
    }

    // Deliberately staggered so the second flow's writes land between the
    // first flow's read and its own.
    const [a, b] = await Promise.all([flow('req-a', 20), flow('req-b', 5)]);

    expect(a).toEqual({ requestId: 'req-a', userId: 'user-for-req-a' });
    expect(b).toEqual({ requestId: 'req-b', userId: 'user-for-req-b' });
    expect(seen.sort()).toEqual([
      'req-a/user-for-req-a',
      'req-b/user-for-req-b',
    ]);
    // And nothing escaped into the ambient scope.
    expect(getRequestId()).toBeUndefined();
  });

  it('updates the live store, so code already mid-flight sees the change', async () => {
    await runWithContext({ requestId: 'req-2' }, async () => {
      const before = contextLogFields();
      expect(before.userId).toBeUndefined();

      // `requireAuth` does exactly this, after the token is verified.
      updateContext({ userId: 'user-9', route: '/api/brand/campaigns/:id' });

      expect(contextLogFields()).toEqual({
        requestId: 'req-2',
        userId: 'user-9',
        route: '/api/brand/campaigns/:id',
      });
    });
  });

  it('ignores an update outside a request rather than throwing', () => {
    // A service called from a seed script or a unit test must not have to know
    // whether it is inside a request.
    expect(() => updateContext({ userId: 'nobody' })).not.toThrow();
  });

  it('generates distinct ids', () => {
    const ids = new Set(Array.from({ length: 100 }, () => newRequestId()));
    expect(ids.size).toBe(100);
  });
});
