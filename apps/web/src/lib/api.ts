const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}

export class HttpError extends Error {
  constructor(public status: number, public payload: ApiError) {
    super(payload.error?.message ?? `HTTP ${status}`);
  }
}

let accessToken: string | null = null;

/**
 * Both tokens live in localStorage.
 *
 * The refresh token belongs in an httpOnly cookie, where script cannot read
 * it -- that is the whole point of having two tokens. Doing it properly means
 * the API setting and clearing the cookie, `credentials: 'include'` on every
 * request, and a CORS origin that is not `true`. That is a backend change with
 * deployment consequences, so it is deliberately not bundled into this story.
 *
 * The exposure while it stays here: any XSS on this origin can read a 30-day
 * refresh token rather than only a 15-minute access token. Written down rather
 * than glossed over, and it is the next thing to fix in this area.
 *
 * Rotation (BE-01) does not remove that exposure, but it does change its
 * shape. A stolen token is now single-use, so the theft either stops working
 * as soon as this client refreshes, or -- if the attacker gets there first --
 * announces itself when we present the token they already spent. It is
 * detection, not prevention.
 */
const ACCESS_KEY = 'accessToken';
const REFRESH_KEY = 'refreshToken';

export const tokenStore = {
  get: () =>
    accessToken ??
    (typeof window !== 'undefined' ? localStorage.getItem(ACCESS_KEY) : null),

  getRefresh: () =>
    typeof window !== 'undefined' ? localStorage.getItem(REFRESH_KEY) : null,

  set: (tokens: { accessToken: string; refreshToken?: string } | null) => {
    accessToken = tokens?.accessToken ?? null;
    if (typeof window === 'undefined') return;

    if (!tokens) {
      localStorage.removeItem(ACCESS_KEY);
      localStorage.removeItem(REFRESH_KEY);
      return;
    }
    localStorage.setItem(ACCESS_KEY, tokens.accessToken);
    if (tokens.refreshToken) localStorage.setItem(REFRESH_KEY, tokens.refreshToken);
  },
};

/**
 * The in-flight refresh, shared by every caller that hits a 401 at once.
 *
 * A dashboard fires several queries on mount. When the access token expires
 * they all get 401 within milliseconds of each other. Without this, each
 * starts its own refresh, and they race: the API issues a new token per call,
 * and whichever finishes last wins while the others hold tokens nobody is
 * using.
 *
 * Since BE-01 this is no longer only an efficiency concern. Refresh tokens
 * rotate, so parallel refreshes would send the *same* token several times;
 * one succeeds and the rest are refused. Single-flighting is what keeps this
 * client from logging itself out on every dashboard load.
 */
let refreshInFlight: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  const refreshToken = tokenStore.getRefresh();
  if (!refreshToken) return null;

  const res = await fetch(`${API_URL}/api/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });

  if (!res.ok) return null;

  const tokens = (await res.json()) as { accessToken: string; refreshToken: string };
  tokenStore.set(tokens);
  return tokens.accessToken;
}

function sharedRefresh(): Promise<string | null> {
  if (!refreshInFlight) {
    refreshInFlight = refreshAccessToken().finally(() => {
      // Cleared only once settled, so callers arriving mid-flight join this
      // attempt rather than starting another.
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

/** Where to send someone whose session is genuinely over. */
function redirectToLogin() {
  if (typeof window === 'undefined') return;
  tokenStore.set(null);

  // Preserve where they were, so login can send them back. Without this every
  // expiry dumps the user on the dashboard having lost their place.
  const next = encodeURIComponent(window.location.pathname + window.location.search);
  if (!window.location.pathname.startsWith('/login')) {
    window.location.href = `/login?next=${next}`;
  }
}

export async function api<T = unknown>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const send = async (token: string | null) => {
    const headers = new Headers(init.headers);
    headers.set('Content-Type', 'application/json');
    if (token) headers.set('Authorization', `Bearer ${token}`);
    return fetch(`${API_URL}${path}`, { ...init, headers });
  };

  let res = await send(tokenStore.get());

  // One refresh attempt, then replay. Not a loop: if the replay also 401s the
  // session is genuinely over, and retrying would spin.
  //
  // Auth routes are excluded -- a failed login returning 401 is an answer, not
  // an expired session, and trying to refresh past it would be nonsense.
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    const fresh = await sharedRefresh();
    if (fresh) {
      res = await send(fresh);
    }
    if (res.status === 401) {
      redirectToLogin();
    }
  }

  if (!res.ok) {
    let payload: ApiError = { error: { code: 'UNKNOWN', message: res.statusText } };
    try {
      payload = (await res.json()) as ApiError;
    } catch {
      // Not every error is JSON -- a proxy 502 is not. The status still is.
    }
    throw new HttpError(res.status, payload);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Exposed for tests, which need module state reset between cases. */
export function __resetAuthStateForTests() {
  accessToken = null;
  refreshInFlight = null;
}
