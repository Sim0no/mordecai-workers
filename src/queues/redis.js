import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import IORedis from 'ioredis';
import { logger } from 'mordcai-api/src/utils/logger.js';

const pkgRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
dotenv.config({ path: path.join(pkgRoot, '.env') });

const redisUrl = process.env.REDIS_URL?.trim() || 'redis://127.0.0.1:6379';

/** For startup logs (no credentials). */
export function describeWorkerRedisTarget() {
  const fromEnv = Boolean(process.env.REDIS_URL?.trim());
  let host = '127.0.0.1:6379';
  try {
    host = new URL(redisUrl).host;
  } catch {
    host = '(unparseable REDIS_URL)';
  }
  return { host, fromEnv };
}

export const redisConnection = new IORedis(redisUrl, {
  maxRetriesPerRequest: null,
});

redisConnection.on('connect', () => {
  logger.info('Redis connected');
});

redisConnection.on('error', (error) => {
  logger.error({ error }, 'Redis connection error');
});
