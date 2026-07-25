import { create } from 'zustand';
import type { UserRole } from '@affiliate/shared';
import { api, tokenStore } from './api';

interface SessionUser {
  id: string;
  role: UserRole;
}

interface AuthState {
  user: SessionUser | null;
  /** 'unknown' until the first hydrate resolves, so guards can wait rather than guess. */
  status: 'unknown' | 'authenticated' | 'anonymous';
  setUser: (u: SessionUser | null) => void;
  /** Re-reads the session from the API. Safe to call repeatedly. */
  hydrate: () => Promise<void>;
  logout: () => Promise<void>;
}

export const useAuth = create<AuthState>((set) => ({
  user: null,
  status: 'unknown',

  setUser: (user) => set({ user, status: user ? 'authenticated' : 'anonymous' }),

  /**
   * The store is derived from the API, not from whatever is in localStorage.
   *
   * A token in storage proves only that someone logged in once. It may have
   * been revoked by a logout elsewhere, or belong to a user whose role has
   * since changed. Asking the API is the only way to know, and `requireAuth`
   * re-reads the user on every request anyway.
   */
  hydrate: async () => {
    if (!tokenStore.get()) {
      set({ user: null, status: 'anonymous' });
      return;
    }
    try {
      const me = await api<SessionUser>('/api/auth/me');
      set({ user: me, status: 'authenticated' });
    } catch {
      set({ user: null, status: 'anonymous' });
    }
  },

  /**
   * Logs out server-side first.
   *
   * The previous implementation only cleared localStorage, so the access token
   * stayed valid for up to fifteen minutes after "signing out". On a shared
   * machine someone could pull it out of the browser and keep using it.
   * `POST /auth/logout` bumps tokenVersion, which invalidates every
   * outstanding token for that user immediately.
   */
  logout: async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch {
      // Even if the call fails -- offline, server down -- the local session
      // must still end. Better a token that outlives the click than a user
      // who cannot sign out at all.
    }
    tokenStore.set(null);
    set({ user: null, status: 'anonymous' });
  },
}));
