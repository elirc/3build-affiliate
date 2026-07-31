import pino from 'pino';
import { env } from '../config/env';
import { contextLogFields } from './request-context';

export const logger = pino({
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',

  /**
   * Every record picks up the request id, the route and the authenticated user
   * from the ambient context.
   *
   * This is the whole point of the `AsyncLocalStorage`: a repository can call
   * `logger.warn(...)` and the line comes out correlated without the repository
   * knowing that request ids exist. Threading a parameter instead would work
   * only as long as every service in between remembered to forward it, and the
   * one that forgot would be the one needed during an incident.
   */
  mixin: contextLogFields,

  transport:
    env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
});
