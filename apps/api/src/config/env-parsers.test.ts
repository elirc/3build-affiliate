import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { boolFromString } from './env-parsers';

describe('boolFromString', () => {
  const schema = z.object({ flag: boolFromString(false) });

  it('reads "false" as false', () => {
    // This is the whole point of the helper. `z.coerce.boolean()` returns
    // true here, because Boolean("false") is true.
    expect(schema.parse({ flag: 'false' }).flag).toBe(false);
  });

  it('reads "true" as true', () => {
    expect(schema.parse({ flag: 'true' }).flag).toBe(true);
  });

  it('falls back to the declared default when unset', () => {
    expect(schema.parse({}).flag).toBe(false);
    expect(z.object({ flag: boolFromString(true) }).parse({}).flag).toBe(true);
  });

  it('rejects anything else rather than guessing', () => {
    for (const bad of ['1', '0', 'yes', 'no', 'TRUE', '']) {
      expect(schema.safeParse({ flag: bad }).success).toBe(false);
    }
  });
});
