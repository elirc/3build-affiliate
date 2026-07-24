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

export const tokenStore = {
  get: () => accessToken ?? (typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null),
  set: (t: string | null) => {
    accessToken = t;
    if (typeof window !== 'undefined') {
      if (t) localStorage.setItem('accessToken', t);
      else localStorage.removeItem('accessToken');
    }
  },
};

export async function api<T = unknown>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  const tok = tokenStore.get();
  if (tok) headers.set('Authorization', `Bearer ${tok}`);

  const res = await fetch(`${API_URL}${path}`, { ...init, headers });
  if (!res.ok) {
    let payload: ApiError = { error: { code: 'UNKNOWN', message: res.statusText } };
    try {
      payload = (await res.json()) as ApiError;
    } catch {}
    throw new HttpError(res.status, payload);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
