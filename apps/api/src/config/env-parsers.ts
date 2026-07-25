import { z } from 'zod';

/**
 * Pure Zod helpers for reading environment variables.
 *
 * These live apart from `env.ts` on purpose. `env.ts` parses `process.env` at
 * module load, so importing anything from it requires a fully populated
 * environment. A helper that is pure should be testable without that, and
 * anything importable without side effects is easier to reuse.
 */

/**
 * Environment variables are always strings. `z.coerce.boolean()` runs
 * `Boolean(value)`, and every non-empty string is truthy -- including the
 * string "false". Any flag written that way is on whenever it is set at all,
 * which is the opposite of what the reader expects.
 *
 * This parses the two spellings a human would actually write, and rejects
 * anything else loudly at boot rather than guessing.
 */
export const boolFromString = (defaultValue: boolean) =>
  z
    .enum(['true', 'false'])
    .default(defaultValue ? 'true' : 'false')
    .transform((v) => v === 'true');
