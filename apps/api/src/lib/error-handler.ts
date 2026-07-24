import type { FastifyInstance, FastifyError } from 'fastify';
import { ZodError } from 'zod';
import { AppError } from './errors';
import { logger } from './logger';

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err: FastifyError, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Invalid input', issues: err.issues },
      });
    }
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({
        error: { code: err.code, message: err.message, details: err.details },
      });
    }
    logger.error({ err }, 'Unhandled error');
    return reply.status(500).send({
      error: { code: 'INTERNAL', message: 'Internal server error' },
    });
  });
}
