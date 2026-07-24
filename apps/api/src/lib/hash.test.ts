import { describe, expect, it } from 'vitest';
import { hashEmail, hashPassword, verifyPassword } from './hash';

describe('hashEmail', () => {
  it('normalizes case and surrounding whitespace before hashing', () => {
    expect(hashEmail(' User@Example.COM ')).toBe(hashEmail('user@example.com'));
  });

  it('does not collide obvious different emails', () => {
    expect(hashEmail('one@example.com')).not.toBe(hashEmail('two@example.com'));
  });
});

describe('password hashing', () => {
  it('verifies matching passwords and rejects mismatches', async () => {
    const hash = await hashPassword('CorrectHorseBatteryStaple');

    await expect(verifyPassword(hash, 'CorrectHorseBatteryStaple')).resolves.toBe(true);
    await expect(verifyPassword(hash, 'wrong-password')).resolves.toBe(false);
  });

  it('returns false for malformed hashes', async () => {
    await expect(verifyPassword('not-a-real-hash', 'password')).resolves.toBe(false);
  });
});
