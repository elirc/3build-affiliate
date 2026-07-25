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

  /**
   * A 400 with a specific machine-readable code.
   *
   * Clients branch on `code`, not on the message. State machines in
   * particular need a code a UI can recognise ("INVALID_TRANSITION") so it
   * can re-fetch and re-render the buttons rather than showing a toast and
   * leaving stale controls on screen.
   */
  invalidRequest: (code: string, msg: string, details?: unknown) =>
    new AppError(400, code, msg, details),
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
