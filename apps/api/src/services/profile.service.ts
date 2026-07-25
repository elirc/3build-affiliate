import { Prisma } from '@prisma/client';
import type {
  ChangeEmailInput,
  ChangePasswordInput,
  PayoutSettingsInput,
  UpdateProfileInput,
} from '@affiliate/shared';
import { Errors } from '../lib/errors';
import { hashPassword, verifyPassword } from '../lib/hash';
import { prisma } from '../config/prisma';

/**
 * Fields each role may edit.
 *
 * A single allow-list beats scattered `if (role === 'BRAND')` checks: an
 * affiliate cannot set companyName by sending it, and adding a field means
 * deciding here who owns it rather than discovering later that everyone does.
 */
const EDITABLE_BY_ROLE = {
  AFFILIATE: ['firstName', 'lastName', 'avatarUrl', 'bio', 'socialLinks'],
  BRAND: ['firstName', 'lastName', 'avatarUrl', 'companyName', 'companyUrl', 'companyLogo'],
  ADMIN: ['firstName', 'lastName', 'avatarUrl'],
} as const;

/** Never selected: passwordHash, tokenVersion. */
const PROFILE_FIELDS = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  role: true,
  avatarUrl: true,
  emailVerified: true,
  bio: true,
  socialLinks: true,
  companyName: true,
  companyUrl: true,
  companyLogo: true,
  payoutMethod: true,
  stripeConnectAccountId: true,
  paypalEmail: true,
  manualPayoutDetails: true,
  createdAt: true,
} as const;

export function profileService() {
  return {
    async get(userId: string) {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: PROFILE_FIELDS,
      });
      if (!user) throw Errors.notFound('User');
      return user;
    },

    async update(
      userId: string,
      role: 'BRAND' | 'AFFILIATE' | 'ADMIN',
      input: UpdateProfileInput
    ) {
      const allowed = EDITABLE_BY_ROLE[role] as readonly string[];
      const rejected = Object.keys(input).filter((k) => !allowed.includes(k));
      if (rejected.length > 0) {
        throw Errors.forbidden(
          `A ${role.toLowerCase()} cannot set: ${rejected.join(', ')}`
        );
      }

      const data: Prisma.UserUpdateInput = {};
      for (const [key, value] of Object.entries(input)) {
        if (value === undefined) continue;
        if (key === 'socialLinks') {
          // Prisma.DbNull to actually clear a nullable Json column; plain null
          // stores the JSON value `null`, which is not the same as absent.
          (data as Record<string, unknown>)[key] =
            value === null ? Prisma.DbNull : value;
        } else {
          (data as Record<string, unknown>)[key] = value;
        }
      }

      return prisma.user.update({
        where: { id: userId },
        data,
        select: PROFILE_FIELDS,
      });
    },

    /**
     * Changing a password invalidates every other session.
     *
     * That is usually the reason someone is changing it -- they think somebody
     * else has it. A password change that leaves the intruder logged in
     * achieves nothing.
     */
    async changePassword(userId: string, input: ChangePasswordInput) {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) throw Errors.notFound('User');

      const ok = await verifyPassword(user.passwordHash, input.currentPassword);
      if (!ok) throw Errors.unauthorized('Current password is incorrect');

      await prisma.user.update({
        where: { id: userId },
        data: {
          passwordHash: await hashPassword(input.newPassword),
          tokenVersion: { increment: 1 },
        },
      });

      // The caller's own token is now dead too. Returning fresh ones would be
      // friendlier; making them sign in again is the honest signal that every
      // session really was revoked.
      return { ok: true, sessionsRevoked: true };
    },

    async changeEmail(userId: string, input: ChangeEmailInput) {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) throw Errors.notFound('User');

      const ok = await verifyPassword(user.passwordHash, input.currentPassword);
      if (!ok) throw Errors.unauthorized('Current password is incorrect');

      const email = input.newEmail.toLowerCase();
      const taken = await prisma.user.findUnique({ where: { email } });
      if (taken && taken.id !== userId) {
        throw Errors.conflict('That email address is already in use');
      }

      return prisma.user.update({
        where: { id: userId },
        data: {
          email,
          // The new address is unproven until someone clicks a link sent to
          // it. There is no verification flow yet, so this at least stops the
          // system claiming an address is confirmed when it is not.
          emailVerified: false,
        },
        select: PROFILE_FIELDS,
      });
    },

    /**
     * Saves payout details for one method.
     *
     * The discriminated union means the fields required for the chosen method
     * are present by construction, and the other methods' fields are cleared
     * so stale details cannot be used by accident later.
     */
    async setPayoutSettings(userId: string, input: PayoutSettingsInput) {
      const data: Prisma.UserUpdateInput = {
        payoutMethod: input.method.toUpperCase() as
          | 'STRIPE_CONNECT'
          | 'PAYPAL'
          | 'MANUAL',
        stripeConnectAccountId: null,
        paypalEmail: null,
        manualPayoutDetails: null,
      };

      if (input.method === 'stripe_connect') {
        data.stripeConnectAccountId = input.stripeConnectAccountId;
      } else if (input.method === 'paypal') {
        data.paypalEmail = input.paypalEmail;
      } else {
        data.manualPayoutDetails = input.manualDetails;
      }

      return prisma.user.update({
        where: { id: userId },
        data,
        select: PROFILE_FIELDS,
      });
    },

    /**
     * Whether an affiliate has the details needed to be paid by this method.
     *
     * Used to refuse a payout request before it reaches an admin, rather than
     * after -- discovering there is no PayPal address at the point of transfer
     * wastes an admin's time and delays the affiliate.
     */
    async assertCanReceive(
      userId: string,
      method: 'stripe_connect' | 'paypal' | 'manual'
    ) {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          stripeConnectAccountId: true,
          paypalEmail: true,
          manualPayoutDetails: true,
        },
      });
      if (!user) throw Errors.notFound('User');

      const missing =
        (method === 'stripe_connect' && !user.stripeConnectAccountId) ||
        (method === 'paypal' && !user.paypalEmail) ||
        (method === 'manual' && !user.manualPayoutDetails);

      if (missing) {
        throw Errors.invalidRequest(
          'PAYOUT_DETAILS_MISSING',
          `Add your ${method.replace('_', ' ')} details in Settings before ` +
            `requesting a payout by that method.`
        );
      }
    },
  };
}
