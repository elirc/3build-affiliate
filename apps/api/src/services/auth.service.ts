import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { hashPassword, verifyPassword } from '../lib/hash';
import { Errors } from '../lib/errors';
import type { RegisterInput, LoginInput } from '@affiliate/shared';
import { userRepository } from '../repositories/user.repository';
import { prisma } from '../config/prisma';
import { env } from '../config/env';

interface RefreshPayload {
  id: string;
  tokenVersion: number;
  type: 'refresh';
}

function ttlToSeconds(ttl: string): number {
  const match = ttl.match(/^(\d+)([smhd])$/);
  if (!match) return 30 * 24 * 60 * 60;
  const value = Number(match[1]);
  const unit = match[2];
  if (unit === 's') return value;
  if (unit === 'm') return value * 60;
  if (unit === 'h') return value * 60 * 60;
  return value * 24 * 60 * 60;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function signRefreshToken(payload: RefreshPayload): string {
  const header = base64UrlJson({ alg: 'HS256', typ: 'JWT' });
  const body = base64UrlJson({
    ...payload,
    exp: Math.floor(Date.now() / 1000) + ttlToSeconds(env.JWT_REFRESH_TTL),
  });
  const data = `${header}.${body}`;
  const signature = crypto
    .createHmac('sha256', env.JWT_REFRESH_SECRET)
    .update(data)
    .digest('base64url');
  return `${data}.${signature}`;
}

function verifyRefreshToken(token: string): RefreshPayload {
  const [header, body, signature] = token.split('.');
  if (!header || !body || !signature) throw Errors.unauthorized('Invalid refresh token');
  const data = `${header}.${body}`;
  const expected = crypto
    .createHmac('sha256', env.JWT_REFRESH_SECRET)
    .update(data)
    .digest('base64url');
  const actualSignature = Buffer.from(signature);
  const expectedSignature = Buffer.from(expected);
  if (
    actualSignature.length !== expectedSignature.length ||
    !crypto.timingSafeEqual(actualSignature, expectedSignature)
  ) {
    throw Errors.unauthorized('Invalid refresh token');
  }
  let payload: RefreshPayload & { exp?: number };
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as RefreshPayload & {
      exp?: number;
    };
  } catch {
    throw Errors.unauthorized('Invalid refresh token');
  }
  if (payload.type !== 'refresh') throw Errors.unauthorized('Invalid token type');
  if (!payload.id || payload.tokenVersion === undefined) {
    throw Errors.unauthorized('Invalid refresh token');
  }
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) {
    throw Errors.unauthorized('Refresh token expired');
  }
  return payload;
}

export function authService(app: FastifyInstance) {
  const users = userRepository(prisma);

  return {
    async register(input: RegisterInput) {
      const existing = await users.findByEmail(input.email);
      if (existing) throw Errors.conflict('Email already registered');

      const passwordHash = await hashPassword(input.password);
      const user = await users.create({
        email: input.email,
        passwordHash,
        firstName: input.firstName,
        lastName: input.lastName,
        role: input.role,
        companyName: input.companyName,
        companyUrl: input.companyUrl,
      });

      return this.issueTokens(user);
    },

    async login(input: LoginInput) {
      const user = await users.findByEmail(input.email);
      if (!user) throw Errors.unauthorized('Invalid credentials');
      const ok = await verifyPassword(user.passwordHash, input.password);
      if (!ok) throw Errors.unauthorized('Invalid credentials');
      return this.issueTokens(user);
    },

    issueTokens(user: { id: string; role: string; tokenVersion: number }) {
      const accessToken = app.jwt.sign(
        { id: user.id, role: user.role, tokenVersion: user.tokenVersion },
        { expiresIn: env.JWT_ACCESS_TTL }
      );
      const refreshToken = signRefreshToken({
        id: user.id,
        tokenVersion: user.tokenVersion,
        type: 'refresh',
      });
      return { accessToken, refreshToken };
    },

    async refresh(token: string) {
      const payload = verifyRefreshToken(token);
      const user = await users.findById(payload.id);
      if (!user || user.tokenVersion !== payload.tokenVersion) {
        throw Errors.unauthorized('Token revoked');
      }
      return this.issueTokens(user);
    },

    async logout(userId: string) {
      await users.bumpTokenVersion(userId);
    },
  };
}
