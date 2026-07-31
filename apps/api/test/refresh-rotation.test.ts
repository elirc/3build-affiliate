import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { build } from '../src/server';
import { prisma } from '../src/config/prisma';
import { cleanupRefreshTokens } from '../src/services/auth.service';
import { makeAffiliate } from './factories';

/**
 * Refresh token rotation and reuse detection.
 *
 * The old implementation signed a stateless token and never recorded it, so
 * every test here that asserts an *old* token stops working fails against it.
 * That is deliberate -- a story about detecting stolen tokens is worth nothing
 * if the tests would pass without the detection.
 */
describe('refresh token rotation', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await build({ rateLimit: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function loginUser(agent = 'vitest/1.0') {
    const user = await makeAffiliate();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'user-agent': agent },
      payload: { email: user.email, password: 'Password123!' },
    });
    expect(res.statusCode).toBe(200);
    return { user, ...(res.json() as { accessToken: string; refreshToken: string }) };
  }

  function refresh(refreshToken: string) {
    return app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      payload: { refreshToken },
    });
  }

  it('issues a different refresh token and retires the old one', async () => {
    const session = await loginUser();

    const res = await refresh(session.refreshToken);
    expect(res.statusCode).toBe(200);
    const rotated = res.json() as { refreshToken: string };

    // The point of rotation: the token changed.
    expect(rotated.refreshToken).not.toBe(session.refreshToken);

    // And the new one works.
    expect((await refresh(rotated.refreshToken)).statusCode).toBe(200);
  });

  it('revokes the whole family when a rotated token is replayed', async () => {
    // The scenario the design exists for. An attacker copies T1. The real user
    // refreshes (T1 -> T2 -> T3) and carries on. Then the attacker plays T1.
    // We cannot tell which party is legitimate, so both are cut off.
    const session = await loginUser();

    const second = (await refresh(session.refreshToken)).json() as { refreshToken: string };
    const third = (await refresh(second.refreshToken)).json() as { refreshToken: string };
    expect((await refresh(third.refreshToken)).statusCode).toBe(200);

    const replay = await refresh(session.refreshToken);
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.code).toBe('TOKEN_REUSE_DETECTED');

    // The live token dies too. Rotation alone would have left it working,
    // which is exactly the gap this closes.
    const afterDetection = await refresh(third.refreshToken);
    expect(afterDetection.statusCode).toBe(401);
  });

  it('lets exactly one of several concurrent refreshes win', async () => {
    // Read-then-write would let all five mint a valid token from one. The
    // conditional claim is what makes this exactly one.
    const session = await loginUser();

    const responses = await Promise.all(
      Array.from({ length: 5 }, () => refresh(session.refreshToken))
    );

    const winners = responses.filter((r) => r.statusCode === 200);
    expect(winners).toHaveLength(1);

    const rows = await prisma.refreshToken.findMany({
      where: { userId: session.user.id },
    });
    // The original plus exactly one successor -- not five.
    expect(rows).toHaveLength(2);

    // And the winner's token must still be usable.
    //
    // This assertion is the whole point of the test. Without it the first
    // implementation passed: the four losers each saw a token that had just
    // been rotated, called that reuse, and revoked the family -- destroying
    // the winner's brand-new token in the process. Two browser tabs refreshing
    // at the same instant would have logged the user out completely, and
    // counting status codes would never have shown it.
    const winner = winners[0]!.json() as { refreshToken: string };
    expect((await refresh(winner.refreshToken)).statusCode).toBe(200);

    expect(
      await prisma.refreshToken.count({
        where: { userId: session.user.id, revokedAt: { not: null } },
      })
    ).toBe(0);
  });

  it('still catches a replay once the family has moved on', async () => {
    // The other side of the same coin: a race is forgiven, but a token
    // replayed after the legitimate client has rotated again is not. This is
    // what stops the race allowance from becoming a hole an attacker can sit
    // in.
    const session = await loginUser();
    const second = (await refresh(session.refreshToken)).json() as { refreshToken: string };
    await refresh(second.refreshToken);

    const replay = await refresh(session.refreshToken);
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.code).toBe('TOKEN_REUSE_DETECTED');
  });

  it('stores a hash, never the token', async () => {
    const session = await loginUser();
    const rows = await prisma.refreshToken.findMany({ where: { userId: session.user.id } });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).not.toBe(session.refreshToken);
    expect(rows[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    // Nothing in the row should let you reconstruct the token.
    expect(JSON.stringify(rows[0])).not.toContain(session.refreshToken);
  });

  it('logs out one device without touching the other', async () => {
    // The old logout bumped tokenVersion, so signing out of a shared laptop
    // also signed you out of your phone.
    const user = await makeAffiliate();
    const login = async (agent: string) =>
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: { 'user-agent': agent },
          payload: { email: user.email, password: 'Password123!' },
        })
      ).json() as { accessToken: string; refreshToken: string };

    const laptop = await login('laptop');
    const phone = await login('phone');

    const out = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { authorization: `Bearer ${laptop.accessToken}` },
    });
    expect(out.statusCode).toBe(200);

    expect((await refresh(laptop.refreshToken)).statusCode).toBe(401);
    expect((await refresh(phone.refreshToken)).statusCode).toBe(200);
  });

  it('logout-all ends every session', async () => {
    const user = await makeAffiliate();
    const login = async () =>
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { email: user.email, password: 'Password123!' },
        })
      ).json() as { accessToken: string; refreshToken: string };

    const a = await login();
    const b = await login();

    await app.inject({
      method: 'POST',
      url: '/api/auth/logout-all',
      headers: { authorization: `Bearer ${a.accessToken}` },
    });

    expect((await refresh(a.refreshToken)).statusCode).toBe(401);
    expect((await refresh(b.refreshToken)).statusCode).toBe(401);
  });

  it('lists sessions and marks the current one', async () => {
    const user = await makeAffiliate();
    const login = async (agent: string) =>
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: { 'user-agent': agent },
          payload: { email: user.email, password: 'Password123!' },
        })
      ).json() as { accessToken: string; refreshToken: string };

    await login('device-one');
    const current = await login('device-two');

    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/sessions',
      headers: { authorization: `Bearer ${current.accessToken}` },
    });
    expect(res.statusCode).toBe(200);

    const sessions = res.json() as Array<{
      id: string;
      current: boolean;
      userAgent: string | null;
    }>;
    expect(sessions).toHaveLength(2);
    expect(sessions.filter((s) => s.current)).toHaveLength(1);
    expect(sessions.map((s) => s.userAgent).sort()).toEqual(['device-one', 'device-two']);
  });

  it('rotation keeps one row per session in the list', async () => {
    // Rotating five times must not look like five sessions. The list is
    // grouped by family for exactly this reason.
    const session = await loginUser();
    let token = session.refreshToken;
    for (let i = 0; i < 5; i++) {
      token = ((await refresh(token)).json() as { refreshToken: string }).refreshToken;
    }

    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/sessions',
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    expect((res.json() as unknown[]).length).toBe(1);
  });

  it('revokes a single named session', async () => {
    const user = await makeAffiliate();
    const login = async (agent: string) =>
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: { 'user-agent': agent },
          payload: { email: user.email, password: 'Password123!' },
        })
      ).json() as { accessToken: string; refreshToken: string };

    const keep = await login('keep');
    const kill = await login('kill');

    const list = (
      await app.inject({
        method: 'GET',
        url: '/api/auth/sessions',
        headers: { authorization: `Bearer ${keep.accessToken}` },
      })
    ).json() as Array<{ id: string; userAgent: string }>;
    const target = list.find((s) => s.userAgent === 'kill')!;

    const res = await app.inject({
      method: 'POST',
      url: `/api/auth/sessions/${target.id}/revoke`,
      headers: { authorization: `Bearer ${keep.accessToken}` },
    });
    expect(res.statusCode).toBe(204);

    expect((await refresh(kill.refreshToken)).statusCode).toBe(401);
    expect((await refresh(keep.refreshToken)).statusCode).toBe(200);
  });

  it('will not let one user revoke another user\'s session', async () => {
    const victim = await loginUser();
    const attacker = await loginUser();

    const victimFamily = (
      await prisma.refreshToken.findFirstOrThrow({ where: { userId: victim.user.id } })
    ).familyId;

    const res = await app.inject({
      method: 'POST',
      url: `/api/auth/sessions/${victimFamily}/revoke`,
      headers: { authorization: `Bearer ${attacker.accessToken}` },
    });
    expect(res.statusCode).toBe(404);

    // And the victim is unaffected.
    expect((await refresh(victim.refreshToken)).statusCode).toBe(200);
  });

  it('rejects an expired token and a forged one', async () => {
    const session = await loginUser();

    await prisma.refreshToken.updateMany({
      where: { userId: session.user.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await refresh(session.refreshToken)).statusCode).toBe(401);

    // Tampering with the payload breaks the signature, and that is checked
    // before any database work happens.
    const [h, b, s] = session.refreshToken.split('.');
    const forged = `${h}.${Buffer.from('{"id":"x","type":"refresh"}').toString('base64url')}.${s}`;
    expect((await refresh(forged)).statusCode).toBe(401);
  });

  it('sweeps settled rows and leaves live ones alone', async () => {
    const live = await loginUser();
    const dead = await loginUser();

    await prisma.refreshToken.updateMany({
      where: { userId: dead.user.id },
      data: { expiresAt: new Date(Date.now() - 40 * 24 * 3600 * 1000) },
    });

    const { deleted } = await cleanupRefreshTokens();
    expect(deleted).toBeGreaterThanOrEqual(1);

    expect(await prisma.refreshToken.count({ where: { userId: dead.user.id } })).toBe(0);
    expect(await prisma.refreshToken.count({ where: { userId: live.user.id } })).toBe(1);
  });
});
