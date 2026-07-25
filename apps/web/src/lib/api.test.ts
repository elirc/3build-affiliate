import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAuthStateForTests, api, tokenStore } from './api';

/**
 * The refresh interceptor.
 *
 * All of this is about what happens when several requests expire at once,
 * which is the normal case -- a dashboard fires its queries together, so their
 * tokens also expire together.
 */

const store = new Map<string, string>();

function installBrowserGlobals() {
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  vi.stubGlobal('window', {
    location: { pathname: '/affiliate/links', search: '', href: '' },
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('api refresh handling', () => {
  beforeEach(() => {
    store.clear();
    __resetAuthStateForTests();
    installBrowserGlobals();
    store.set('accessToken', 'expired-access');
    store.set('refreshToken', 'valid-refresh');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('refreshes once and replays the original request', async () => {
    const fetchMock = vi
      .fn()
      // The original request, with the expired token.
      .mockResolvedValueOnce(json({ error: { code: 'UNAUTHORIZED' } }, 401))
      // The refresh.
      .mockResolvedValueOnce(
        json({ accessToken: 'fresh-access', refreshToken: 'fresh-refresh' })
      )
      // The replay.
      .mockResolvedValueOnce(json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api('/api/affiliate/links')).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    // The replay carries the new token, not the expired one.
    const replayHeaders = fetchMock.mock.calls[2]![1].headers as Headers;
    expect(replayHeaders.get('Authorization')).toBe('Bearer fresh-access');
    // And the rotated refresh token was stored.
    expect(store.get('refreshToken')).toBe('fresh-refresh');
  });

  it('refreshes exactly once for concurrent 401s', async () => {
    // This is the whole reason the shared promise exists. Five parallel
    // queries expiring together must not trigger five refreshes.
    let refreshCalls = 0;

    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/api/auth/refresh')) {
        refreshCalls += 1;
        // A real refresh is not instant. The delay is the point: without a
        // shared promise, the other four start their own during this gap.
        await new Promise((r) => setTimeout(r, 10));
        return json({ accessToken: 'fresh-access', refreshToken: 'fresh-refresh' });
      }
      // Anything presenting the new token succeeds; the expired one does not.
      const token = (init.headers as Headers).get('Authorization');
      return token === 'Bearer fresh-access'
        ? json({ ok: url })
        : json({ error: { code: 'UNAUTHORIZED' } }, 401);
    });
    vi.stubGlobal('fetch', fetchMock);

    const results = await Promise.all([
      api('/api/a'),
      api('/api/b'),
      api('/api/c'),
      api('/api/d'),
      api('/api/e'),
    ]);

    expect(results).toHaveLength(5);
    expect(refreshCalls).toBe(1);
  });

  it('does not try to refresh a failed login', async () => {
    // A 401 from /auth/login is an answer -- wrong password -- not an expired
    // session. Refreshing past it would be nonsense.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(json({ error: { code: 'UNAUTHORIZED' } }, 401));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api('/api/auth/login', { method: 'POST' })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('clears the session and redirects when refresh fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ error: { code: 'UNAUTHORIZED' } }, 401))
      .mockResolvedValueOnce(json({ error: { code: 'UNAUTHORIZED' } }, 401));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api('/api/affiliate/links')).rejects.toThrow();

    expect(store.has('accessToken')).toBe(false);
    expect(store.has('refreshToken')).toBe(false);
    // And the user is sent somewhere they can do something about it, with
    // their destination preserved.
    expect((globalThis as { window: { location: { href: string } } }).window.location.href)
      .toContain('/login?next=');
  });

  it('does not attempt a refresh with no refresh token', async () => {
    store.delete('refreshToken');
    const fetchMock = vi
      .fn()
      .mockResolvedValue(json({ error: { code: 'UNAUTHORIZED' } }, 401));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api('/api/affiliate/links')).rejects.toThrow();
    // One call: the original. No point asking for a refresh we cannot make.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('passes through non-401 errors untouched', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        json({ error: { code: 'FORBIDDEN', message: 'Nope' } }, 403)
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(api('/api/brand/campaigns')).rejects.toMatchObject({
      status: 403,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
