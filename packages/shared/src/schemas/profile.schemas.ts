import { z } from 'zod';

/**
 * A social link must be an absolute https URL.
 *
 * `javascript:` and `data:` URLs are the reason. These render as clickable
 * links on the brand's affiliate-review page, so an affiliate who could store
 * `javascript:...` would have a stored XSS aimed squarely at the brand about
 * to approve them. Plain `http:` is refused too -- there is no reason to
 * publish an insecure link in 2026, and allowing it means someone eventually
 * allows the rest.
 */
const socialUrl = z
  .string()
  .url()
  .max(500)
  .refine((v) => v.startsWith('https://'), {
    message: 'Links must start with https://',
  });

export const updateProfileSchema = z
  .object({
    firstName: z.string().min(1).max(100).optional(),
    lastName: z.string().min(1).max(100).optional(),
    avatarUrl: socialUrl.nullable().optional(),

    // Affiliate-facing
    bio: z.string().max(2000).nullable().optional(),
    socialLinks: z
      .record(z.string().min(1).max(40), socialUrl)
      .refine((v) => Object.keys(v).length <= 10, {
        message: 'At most 10 social links',
      })
      .nullable()
      .optional(),

    // Brand-facing
    companyName: z.string().min(1).max(200).optional(),
    companyUrl: socialUrl.nullable().optional(),
    companyLogo: socialUrl.nullable().optional(),
  })
  .strict();

export const changePasswordSchema = z.object({
  /**
   * Required even though the caller is already authenticated. An access token
   * left behind on a shared machine should not be enough to lock the real
   * owner out of their account.
   */
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(200),
});

export const changeEmailSchema = z.object({
  currentPassword: z.string().min(1),
  newEmail: z.string().email().max(200),
});

export const PAYOUT_METHODS = ['stripe_connect', 'paypal', 'manual'] as const;

/**
 * Payout details, discriminated by method.
 *
 * Each method needs different information, and a single optional-everything
 * shape would let someone save a PayPal payout method with no PayPal address
 * -- which is exactly the bug this story exists to close.
 */
export const payoutSettingsSchema = z.discriminatedUnion('method', [
  z.object({
    method: z.literal('stripe_connect'),
    stripeConnectAccountId: z.string().min(1).max(200),
  }),
  z.object({
    method: z.literal('paypal'),
    paypalEmail: z.string().email().max(200),
  }),
  z.object({
    method: z.literal('manual'),
    /** Free text: an IBAN, a sort code and account number, a reference. */
    manualDetails: z.string().min(1).max(500),
  }),
]);

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type ChangeEmailInput = z.infer<typeof changeEmailSchema>;
export type PayoutSettingsInput = z.infer<typeof payoutSettingsSchema>;
