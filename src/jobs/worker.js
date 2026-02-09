import { Worker } from 'bullmq';
import { loadDatabase } from 'mordcai-api/src/loaders/sequelize.load.js';
import { sequelize } from 'mordcai-api/src/config/database.js';
import { logger } from 'mordcai-api/src/utils/logger.js';
import { redisConnection } from '../queues/redis.js';
import { CASE_ACTIONS_QUEUE, JOB_TYPES } from '../queues/case-actions.queue.js';
import {
  DebtCase,
  Debtor,
  FlowPolicy,
  InteractionLog,
} from 'mordcai-api/src/models/index.js';

const concurrency = Number(process.env.WORKER_CONCURRENCY) || 5;
const cooldownMinutes = Number(process.env.WORKER_COOLDOWN_MINUTES) || 360;

const getTwilioConfig = () => {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_FROM_NUMBER;
  const voiceUrl = process.env.TWILIO_VOICE_URL;

  if (!accountSid || !authToken || !fromNumber || !voiceUrl) {
    throw new Error(
      'Missing TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, or TWILIO_VOICE_URL'
    );
  }

  return { accountSid, authToken, fromNumber, voiceUrl };
};

const createTwilioCall = async ({ to }) => {
  const { accountSid, authToken, fromNumber, voiceUrl } = getTwilioConfig();

  const params = new URLSearchParams({
    To: to,
    From: fromNumber,
    Url: voiceUrl,
  });

  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(
          `${accountSid}:${authToken}`
        ).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    }
  );

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Twilio call failed: ${response.status} ${errorBody}`);
  }

  const json = await response.json();
  return json.sid;
};

const processCallCase = async ({ tenantId, caseId }) => {
  const debtCase = await DebtCase.findOne({
    where: { id: caseId, tenantId },
    include: [
      { model: Debtor, as: 'debtor' },
      { model: FlowPolicy, as: 'flowPolicy' },
    ],
  });

  if (!debtCase) {
    throw new Error('Debt case not found');
  }

  const debtorPhone = debtCase.debtor?.phone;
  if (!debtorPhone) {
    throw new Error('Debtor phone is missing');
  }

  const now = new Date();
  const nextActionAt = new Date(now.getTime() + cooldownMinutes * 60 * 1000);

  const callSid = await createTwilioCall({ to: debtorPhone });

  const transaction = await sequelize.transaction();
  try {
    const log = await InteractionLog.create(
      {
        tenantId,
        debtCaseId: debtCase.id,
        debtorId: debtCase.debtorId,
        type: 'CALL',
        status: 'queued',
        channelProvider: 'twilio',
        providerRef: callSid,
        startedAt: now,
      },
      { transaction }
    );

    await debtCase.update(
      {
        status: 'IN_PROGRESS',
        lastContactedAt: now,
        nextActionAt,
      },
      { transaction }
    );

    await transaction.commit();

    return { caseId: debtCase.id, logId: log.id, callSid };
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
};

const start = async () => {
  await loadDatabase();

  if (!sequelize) {
    logger.warn('Worker aborted: database is not initialized.');
    return;
  }

  const worker = new Worker(
    CASE_ACTIONS_QUEUE,
    async (job) => {
      if (job.name === JOB_TYPES.CALL_CASE) {
        return processCallCase(job.data);
      }
      logger.warn({ jobName: job.name }, 'Unknown job type received');
      return null;
    },
    {
      connection: redisConnection,
      concurrency,
    }
  );

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id, name: job.name }, 'Job completed');
  });

  worker.on('failed', (job, error) => {
    logger.error({ jobId: job?.id, error }, 'Job failed');
  });

  const shutdown = async () => {
    logger.info('Worker shutting down');
    await worker.close();
    await redisConnection.quit();
    if (sequelize) {
      await sequelize.close();
    }
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
};

start().catch((error) => {
  logger.error({ error }, 'Worker failed to start');
  process.exit(1);
});
