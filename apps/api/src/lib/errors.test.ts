import { describe, expect, it } from 'vitest';
import { AppError, Errors } from './errors';

describe('Errors factory', () => {
  it('creates typed operational errors', () => {
    const err = Errors.conflict('Email already registered');

    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe('CONFLICT');
    expect(err.message).toBe('Email already registered');
  });

  it('formats not-found resources consistently', () => {
    const err = Errors.notFound('Campaign');

    expect(err.statusCode).toBe(404);
    expect(err.code).toBe('NOT_FOUND');
    expect(err.message).toBe('Campaign not found');
  });

  it('carries validation details on unprocessable errors', () => {
    const details = { field: 'attributionCookieId' };
    const err = Errors.unprocessable('No attributable clicks found', details);

    expect(err.details).toEqual(details);
  });
});
