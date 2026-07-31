import type { DB } from '../config/prisma';

export function refreshTokenRepository(db: DB) {
  return {
    findByHash: (tokenHash: string) => db.refreshToken.findUnique({ where: { tokenHash } }),

    create: (data: {
      familyId: string;
      tokenHash: string;
      userId: string;
      expiresAt: Date;
      userAgent?: string | null;
      ipHash?: string | null;
    }) => db.refreshToken.create({ data }),

    /**
     * Claims a token for rotation.
     *
     * Conditional on `rotatedAt: null`, so two concurrent refreshes presenting
     * the same token cannot both succeed: the first update matches one row,
     * the second matches none. Reading the row and then updating it by id --
     * the obvious version -- lets both callers pass the check and mint two
     * valid tokens from one, which is the whole thing we are trying to make
     * impossible.
     */
    claimForRotation: (id: string, now: Date) =>
      db.refreshToken.updateMany({
        where: { id, rotatedAt: null, revokedAt: null },
        data: { rotatedAt: now, lastUsedAt: now },
      }),

    /**
     * How many tokens in this family were rotated *after* the given moment.
     *
     * Zero means the presented token's rotation is still the newest thing that
     * happened to this family -- nobody has used the successor yet, so a
     * second presentation is a race rather than a replay. Non-zero means the
     * legitimate holder has moved on and this token should have been dead.
     */
    countRotationsAfter: (familyId: string, after: Date) =>
      db.refreshToken.count({ where: { familyId, rotatedAt: { gt: after } } }),

    revokeFamily: (familyId: string, now: Date) =>
      db.refreshToken.updateMany({
        where: { familyId, revokedAt: null },
        data: { revokedAt: now },
      }),

    revokeAllForUser: (userId: string, now: Date) =>
      db.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now },
      }),

    /**
     * Active families, newest first.
     *
     * Grouped in the caller rather than with `groupBy` because we want the
     * family's user agent and IP as well as its timestamps, and `groupBy`
     * cannot carry non-aggregated columns.
     */
    listActiveForUser: (userId: string, now: Date) =>
      db.refreshToken.findMany({
        where: { userId, revokedAt: null, expiresAt: { gt: now } },
        orderBy: { issuedAt: 'asc' },
        select: {
          familyId: true,
          issuedAt: true,
          lastUsedAt: true,
          userAgent: true,
          ipHash: true,
        },
      }),

    familyBelongsTo: async (familyId: string, userId: string) =>
      (await db.refreshToken.count({ where: { familyId, userId } })) > 0,

    /**
     * Rows that can no longer authorise anything: expired, or revoked long
     * enough ago that nobody is going to ask about them. Without this the
     * table grows by one row per refresh forever.
     */
    deleteSettled: (before: Date) =>
      db.refreshToken.deleteMany({
        where: {
          OR: [{ expiresAt: { lt: before } }, { revokedAt: { lt: before } }],
        },
      }),
  };
}
