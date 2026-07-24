export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  badRequest: (msg: string, details?: unknown) =>
    new AppError(400, 'BAD_REQUEST', msg, details),
  unauthorized: (msg = 'Authentication required') =>
    new AppError(401, 'UNAUTHORIZED', msg),
  forbidden: (msg = 'Forbidden') => new AppError(403, 'FORBIDDEN', msg),
  notFound: (resource: string) =>
    new AppError(404, 'NOT_FOUND', `${resource} not found`),
  conflict: (msg: string) => new AppError(409, 'CONFLICT', msg),
  unprocessable: (msg: string, details?: unknown) =>
    new AppError(422, 'UNPROCESSABLE', msg, details),
  rateLimited: (msg = 'Too many requests') =>
    new AppError(429, 'RATE_LIMITED', msg),
  internal: (msg = 'Internal server error') =>
    new AppError(500, 'INTERNAL', msg),
};
