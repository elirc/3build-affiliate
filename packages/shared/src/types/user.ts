import type { UserRole } from '../constants/roles';

export interface PublicUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: UserRole;
  avatarUrl: string | null;
  companyName: string | null;
  companyUrl: string | null;
  bio: string | null;
  createdAt: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface SessionUser {
  id: string;
  email: string;
  role: UserRole;
  tokenVersion: number;
}
