import type { FastifyInstance, FastifyError } from 'fastify';
import { ZodError } from 'zod';
import { AppError } from './errors';
import { logger } from './logger';
import { getRequestId } from './request-context';

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err: FastifyError, req, reply) => {
    // Returned to the caller so a support ticket can quote it. Without this
    // the id exists only in a header nobody reads and in logs nobody can
    // narrow down: "it failed around two o'clock" is not a query.
    const requestId = getRequestId();

    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid input',
          issues: err.issues,
          requestId,
        },
      });
    }
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({
        error: { code: err.code, message: err.message, details: err.details, requestId },
      });
    }

    // `requestId`, `route` and `userId` arrive automatically from the logger's
    // context mixin -- the same reason a service that threw three frames down
    // has already logged them there. The method and resolved path are added
    // because at 500 the first question is which call it actually was, and the
    // resolved path is safe in a log line even though it is not safe as a
    // metric label.
    logger.error({ err, method: req.method, url: req.url }, 'Unhandled error');
    return reply.status(500).send({
      error: { code: 'INTERNAL', message: 'Internal server error', requestId },
    });
  });
}
