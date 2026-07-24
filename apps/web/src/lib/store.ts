import { create } from 'zustand';
import type { UserRole } from '@affiliate/shared';

interface AuthState {
  userId: string | null;
  role: UserRole | null;
  setUser: (u: { id: string; role: UserRole } | null) => void;
}

export const useAuth = create<AuthState>((set) => ({
  userId: null,
  role: null,
  setUser: (u) => set({ userId: u?.id ?? null, role: u?.role ?? null }),
}));
