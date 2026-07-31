import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { hashPassword, verifyPassword } from '../lib/hash';
import { AppError, Errors } from '../lib/errors';
import type { RegisterInput, LoginInput } from '@affiliate/shared';
import { userRepository } from '../repositories/user.repository';
import { refreshTokenRepository } from '../repositories/refresh-token.repository';
import { prisma } from '../config/prisma';
import { env } from '../config/env';
import { logger } from '../lib/logger';

/** Settled rows older than this are swept; see `cleanupRefreshTokens`. */
const RETENTION_DAYS = 30;

/**
 * Deletes refresh tokens that can no longer authorise anything.
 *
 * Exported rather than scheduled here on purpose. Every API instance runs its
 * own `setInterval` workers today (see BE-07), so adding another timer would
 * add another job that runs N times on N instances. This is called from an
 * existing worker tick until leases land.
 */
export async function cleanupRefreshTokens(now: Date = new Date()) {
  const before = new Date(now.getTime() - RETENTION_DAYS * 24 * 3600 * 1000);
  const { count } = await refreshTokenRepository(prisma).deleteSettled(before);
  return { deleted: count };
}

interface RefreshPayload {
  id: string;
  tokenVersion: number;
  /** Every token minted from one login carries the same family id. */
  familyId: string;
  /**
   * A random per-token id. Without it, two tokens issued to the same user in
   * the same second with the same family and expiry would serialise to
   * identical bytes -- and therefore to the same hash, colliding on the unique
   * index. The jti is what makes each token distinct.
   */
  jti: string;
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
  if (!payload.familyId || !payload.jti) {
    // A token from before rotation existed. It cannot be rotated -- there is
    // no family to move forward and no stored row to mark -- so it is refused
    // and the user logs in again. See the PR for why that one-time cost was
    // preferred to carrying a second, weaker code path forever.
    throw Errors.unauthorized('Invalid refresh token');
  }
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) {
    throw Errors.unauthorized('Refresh token expired');
  }
  return payload;
}

/**
 * What we store. Never the token itself.
 *
 * The signature check above runs first and costs no database round-trip, so
 * random garbage is rejected before it can make us do work -- the cheap filter
 * in front of the expensive one.
 */
function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function hashIp(ip: string | undefined): string | null {
  if (!ip) return null;
  return crypto.createHash('sha256').update(ip).digest('hex').slice(0, 32);
}

export interface TokenContext {
  userAgent?: string;
  ip?: string;
}

export function authService(app: FastifyInstance) {
  const users = userRepository(prisma);
  const tokens = refreshTokenRepository(prisma);

  return {
    async register(input: RegisterInput, ctx: TokenContext = {}) {
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

      return this.issueTokens(user, ctx);
    },

    async login(input: LoginInput, ctx: TokenContext = {}) {
      const user = await users.findByEmail(input.email);
      if (!user) throw Errors.unauthorized('Invalid credentials');
      const ok = await verifyPassword(user.passwordHash, input.password);
      if (!ok) throw Errors.unauthorized('Invalid credentials');
      return this.issueTokens(user, ctx);
    },

    /**
     * Mints an access/refresh pair and records the refresh token.
     *
     * `familyId` defaults to a fresh one -- a login starts a new family.
     * Rotation passes the existing family so the chain stays linked.
     */
    async issueTokens(
      user: { id: string; role: string; tokenVersion: number },
      ctx: TokenContext = {},
      // Annotated rather than inferred: `randomUUID()` returns a template
      // literal type, which would make this parameter reject an ordinary
      // string -- and rotation passes the stored family id straight back in.
      familyId: string = crypto.randomUUID()
    ) {
      const accessToken = app.jwt.sign(
        { id: user.id, role: user.role, tokenVersion: user.tokenVersion, familyId },
        { expiresIn: env.JWT_ACCESS_TTL }
      );
      const refreshToken = signRefreshToken({
        id: user.id,
        tokenVersion: user.tokenVersion,
        familyId,
        jti: crypto.randomUUID(),
        type: 'refresh',
      });

      await tokens.create({
        familyId,
        tokenHash: hashToken(refreshToken),
        userId: user.id,
        expiresAt: new Date(Date.now() + ttlToSeconds(env.JWT_REFRESH_TTL) * 1000),
        userAgent: ctx.userAgent?.slice(0, 500) ?? null,
        ipHash: hashIp(ctx.ip),
      });

      return { accessToken, refreshToken };
    },

    /**
     * Rotates a refresh token, and treats a second use of one as an incident.
     *
     * Rotation alone is not enough. If refreshing merely swapped one token for
     * another, an attacker holding a copy would simply race the real user --
     * whoever refreshes first wins and the other is silently logged out. That
     * is a coin flip, not a defence.
     *
     * Keeping the family is what turns it into detection. A token that has
     * already been rotated should never be seen again, so seeing one is proof
     * that two parties hold the same token. We cannot tell which is the
     * attacker, so we revoke the family and make both log in.
     */
    async refresh(token: string, ctx: TokenContext = {}) {
      const payload = verifyRefreshToken(token);
      const now = new Date();
      const stored = await tokens.findByHash(hashToken(token));

      if (!stored) {
        // Correctly signed but unknown: either issued before this feature
        // existed, or already swept. Nothing to rotate either way.
        throw Errors.unauthorized('Invalid refresh token');
      }

      // Checked before rotation, so that replaying a token from a family we
      // already revoked -- by logging out, or by detecting reuse a moment ago
      // -- is a quiet 401 rather than a second alarm about the same incident.
      if (stored.revokedAt) throw Errors.unauthorized('Session revoked');

      if (stored.rotatedAt) {
        // A rotated token has been presented twice. That is either an attack,
        // or the client racing itself -- and the two need telling apart,
        // because the response to one is revoking every session the user has.
        //
        // Two tabs sharing localStorage genuinely do this: tab A refreshes and
        // stores the successor, tab B sends the token it read microseconds
        // earlier. Treating that as theft logs people out for using a browser
        // normally.
        //
        // The discriminator is whether the family has *moved on past* this
        // token. In the race, the presented token is the most recently rotated
        // one -- the client has not used its successor yet. In a real theft,
        // the legitimate holder has carried on (T1 → T2 → T3), so rotations
        // exist that are strictly newer than the one being replayed.
        //
        // A clock-based grace window would be the more common answer, and it
        // is worse: it fails whenever a race takes longer than the window, and
        // it forgives an attacker who is merely quick. This test is exact and
        // needs no clock.
        const movedOn = await tokens.countRotationsAfter(stored.familyId, stored.rotatedAt);

        if (movedOn === 0) {
          logger.info(
            { familyId: stored.familyId, userId: stored.userId },
            'Refresh token replayed while its rotation was still the newest; treating as a client race'
          );
          throw Errors.unauthorized('Refresh token already used');
        }

        await tokens.revokeFamily(stored.familyId, now);
        logger.warn(
          {
            familyId: stored.familyId,
            userId: stored.userId,
            rotatedAgoMs: now.getTime() - stored.rotatedAt.getTime(),
            rotationsSince: movedOn,
            issuedAt: stored.issuedAt,
          },
          'Refresh token reuse detected; family revoked'
        );
        throw new AppError(
          401,
          'TOKEN_REUSE_DETECTED',
          'This session has been revoked because a refresh token was used twice'
        );
      }

      if (stored.expiresAt <= now) throw Errors.unauthorized('Refresh token expired');

      // The claim, not a read-then-write. Two concurrent refreshes with the
      // same token both reach here; exactly one updates a row.
      //
      // The loser gets a plain 401 rather than tripping reuse detection,
      // because at this instant it is indistinguishable from a client that
      // fired two refreshes at once -- a real and common thing for a browser
      // with two tabs to do. A replay that arrives *after* rotation completes
      // is unambiguous, and that one is handled above.
      const claimed = await tokens.claimForRotation(stored.id, now);
      if (claimed.count !== 1) throw Errors.unauthorized('Invalid refresh token');

      const user = await users.findById(payload.id);
      if (!user || user.tokenVersion !== payload.tokenVersion) {
        throw Errors.unauthorized('Token revoked');
      }

      return this.issueTokens(user, ctx, stored.familyId);
    },

    /**
     * Ends one session.
     *
     * Previously this bumped `tokenVersion`, which logged the user out
     * everywhere -- signing out of a shared laptop also signed you out of your
     * phone. Now it revokes the presenting family and nothing else.
     */
    async logout(familyId: string | undefined) {
      if (!familyId) return;
      await tokens.revokeFamily(familyId, new Date());
    },

    /** The nuclear option, and now the only thing that bumps `tokenVersion`. */
    async logoutAll(userId: string) {
      await tokens.revokeAllForUser(userId, new Date());
      await users.bumpTokenVersion(userId);
    },

    async listSessions(userId: string, currentFamilyId?: string) {
      const rows = await tokens.listActiveForUser(userId, new Date());

      // One row per family: the login is the session, not each rotation.
      const byFamily = new Map<string, (typeof rows)[number] & { lastUsedAt: Date }>();
      for (const row of rows) {
        const existing = byFamily.get(row.familyId);
        if (!existing) {
          byFamily.set(row.familyId, { ...row });
          continue;
        }
        if (row.lastUsedAt > existing.lastUsedAt) existing.lastUsedAt = row.lastUsedAt;
      }

      return [...byFamily.values()]
        .map((row) => ({
          id: row.familyId,
          createdAt: row.issuedAt,
          lastUsedAt: row.lastUsedAt,
          userAgent: row.userAgent,
          ipHash: row.ipHash,
          current: row.familyId === currentFamilyId,
        }))
        .sort((a, b) => b.lastUsedAt.getTime() - a.lastUsedAt.getTime());
    },

    async revokeSession(userId: string, familyId: string) {
      // Checked in the service, not the route: a user must not be able to end
      // someone else's session by guessing an id.
      const owned = await tokens.familyBelongsTo(familyId, userId);
      if (!owned) throw Errors.notFound('Session');
      await tokens.revokeFamily(familyId, new Date());
    },
  };
}
