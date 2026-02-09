import IORedis from 'ioredis';
import { logger } from 'mordcai-api/src/utils/logger.js';

const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

export const redisConnection = new IORedis(redisUrl, {
  maxRetriesPerRequest: null,
});

redisConnection.on('connect', () => {
  logger.info('Redis connected');
});

redisConnection.on('error', (error) => {
  logger.error({ error }, 'Redis connection error');
});
