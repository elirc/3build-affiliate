import type { FastifyReply, FastifyRequest } from 'fastify';
import type { UserRole } from '@affiliate/shared';
import { Errors } from './errors';
import { prisma } from '../config/prisma';

export interface AuthedRequest extends FastifyRequest {
  user: { id: string; role: UserRole; tokenVersion: number };
}

export async function requireAuth(req: FastifyRequest, _reply: FastifyReply) {
  let tokenUser: { id?: string; role?: UserRole; tokenVersion?: number };
  try {
    tokenUser = await req.jwtVerify();
  } catch {
    throw Errors.unauthorized();
  }
  if (!tokenUser.id || !tokenUser.role || tokenUser.tokenVersion === undefined) {
    throw Errors.unauthorized();
  }
  const user = await prisma.user.findUnique({
    where: { id: tokenUser.id },
    select: { id: true, role: true, tokenVersion: true },
  });
  if (!user || user.role !== tokenUser.role || user.tokenVersion !== tokenUser.tokenVersion) {
    throw Errors.unauthorized('Session expired');
  }
  (req as AuthedRequest).user = user;
}

export function requireRole(...roles: UserRole[]) {
  return async (req: FastifyRequest) => {
    const user = (req as AuthedRequest).user;
    if (!user) throw Errors.unauthorized();
    if (!roles.includes(user.role)) throw Errors.forbidden();
  };
}
