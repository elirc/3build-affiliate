import { z } from 'zod';

export const createApiKeySchema = z.object({
  /**
   * Free text so a brand can tell their integrations apart later
   * ("shopify-live", "staging"). Required rather than optional: an unlabelled
   * list of keys is impossible to revoke safely, because nobody remembers
   * which one is in production.
   */
  label: z.string().min(1).max(100),
});

export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;
