import 'dotenv/config';
import { loadDatabase } from 'mordcai-api/src/loaders/sequelize.load.js';
import { sequelize } from 'mordcai-api/src/config/database.js';
import { logger } from 'mordcai-api/src/utils/logger.js';
import { caseActionsQueue } from '../queues/case-actions.queue.js';
import { redisConnection } from '../queues/redis.js';
import { scheduleDueCallCases } from './schedule-due-cases.js';

const run = async () => {
  await loadDatabase();

  if (!sequelize) {
    logger.warn('Scheduler aborted: database is not initialized.');
    return;
  }

  const limit = Number(process.env.SCHEDULER_LIMIT) || 500;
  const perTenantLimit =
    Number(process.env.SCHEDULER_PER_TENANT_LIMIT) || 10;
  const cooldownMinutes = Number(process.env.SCHEDULER_COOLDOWN_MINUTES) || 360;
  const tenantId = process.env.SCHEDULER_TENANT_ID || null;

  const result = await scheduleDueCallCases({
    tenantId,
    limit,
    perTenantLimit,
    cooldownMinutes,
  });

  logger.info(
    { ...result, limit, perTenantLimit, cooldownMinutes, tenantId },
    'Scheduler run completed'
  );
};

run()
  .catch((error) => {
    logger.error({ error }, 'Scheduler run failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await caseActionsQueue.close();
      await redisConnection.quit();
      if (sequelize) {
        await sequelize.close();
      }
    } catch (error) {
      logger.error({ error }, 'Scheduler cleanup failed');
    }
  });
