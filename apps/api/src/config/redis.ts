import { Redis } from 'ioredis';
import { env } from './env';
import { logger } from '../lib/logger';

export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
});

redis.on('error', (err) => {
  logger.error({ err }, 'Redis connection error');
});

export const queueConnection = {
  host: new URL(env.REDIS_URL).hostname,
  port: Number(new URL(env.REDIS_URL).port || 6379),
};
