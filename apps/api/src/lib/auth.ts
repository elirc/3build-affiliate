import type { FastifyReply, FastifyRequest } from 'fastify';
import type { UserRole } from '@affiliate/shared';
import { Errors } from './errors';
import { prisma } from '../config/prisma';

export interface AuthedRequest extends FastifyRequest {
  user: {
    id: string;
    role: UserRole;
    tokenVersion: number;
    /**
     * Which session this access token belongs to.
     *
     * Carried in the token rather than looked up, because the whole point is
     * to know it without a database round-trip on every request. Optional so
     * that an access token issued before rotation existed still authenticates
     * -- it simply cannot scope a logout, and `logout` handles that.
     */
    familyId?: string;
  };
}

export async function requireAuth(req: FastifyRequest, _reply: FastifyReply) {
  let tokenUser: {
    id?: string;
    role?: UserRole;
    tokenVersion?: number;
    familyId?: string;
  };
  try {
    tokenUser = await req.jwtVerify();
  } catch {
    throw Errors.unauthorized();
  }
  if (!tokenUser.id || !tokenUser.role || tokenUser.tokenVersion === undefined) {
    throw Errors.unauthorized();
  }
  // Both lookups in parallel: the second costs no extra latency, only an extra
  // connection for the overlap.
  //
  // The family check is what makes logging out take effect immediately. Access
  // tokens are stateless and live ~15 minutes, so revoking only the refresh
  // family would leave the just-logged-out token working for a quarter of an
  // hour -- which is exactly the window someone closing a session on a shared
  // machine is worried about. Logout used to close it by bumping tokenVersion,
  // but that ended every session the user had; checking the family gets the
  // same immediacy while staying scoped to one.
  const [user, liveFamilyTokens] = await Promise.all([
    prisma.user.findUnique({
      where: { id: tokenUser.id },
      select: { id: true, role: true, tokenVersion: true },
    }),
    tokenUser.familyId
      ? prisma.refreshToken.count({
          where: { familyId: tokenUser.familyId, revokedAt: null },
        })
      : Promise.resolve(1),
  ]);

  if (!user || user.role !== tokenUser.role || user.tokenVersion !== tokenUser.tokenVersion) {
    throw Errors.unauthorized('Session expired');
  }
  if (liveFamilyTokens === 0) throw Errors.unauthorized('Session ended');

  (req as AuthedRequest).user = { ...user, familyId: tokenUser.familyId };
}

export function requireRole(...roles: UserRole[]) {
  return async (req: FastifyRequest) => {
    const user = (req as AuthedRequest).user;
    if (!user) throw Errors.unauthorized();
    if (!roles.includes(user.role)) throw Errors.forbidden();
  };
}
