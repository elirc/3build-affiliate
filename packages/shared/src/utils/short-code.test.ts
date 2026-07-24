import { describe, expect, it } from 'vitest';
import { SHORT_CODE_ALPHABET, SHORT_CODE_LENGTH } from '../constants/defaults';
import { generateShortCode } from './short-code';

describe('generateShortCode', () => {
  it('generates a default-length code using the configured alphabet', () => {
    const code = generateShortCode();

    expect(code).toHaveLength(SHORT_CODE_LENGTH);
    for (const char of code) {
      expect(SHORT_CODE_ALPHABET).toContain(char);
    }
  });

  it('supports custom lengths', () => {
    expect(generateShortCode(12)).toHaveLength(12);
  });
});
