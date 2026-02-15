import 'dotenv/config';
import crypto from 'crypto';
import { Worker } from 'bullmq';
import { loadDatabase } from 'mordcai-api/src/loaders/sequelize.load.js';
import { sequelize } from 'mordcai-api/src/config/database.js';
import { logger } from 'mordcai-api/src/utils/logger.js';
import { redisConnection } from '../queues/redis.js';
import { CASE_ACTIONS_QUEUE, JOB_TYPES } from '../queues/case-actions.queue.js';
import { PMS_SYNC_QUEUE_NAME } from 'mordcai-api/src/queues/pms-sync.queue.js';
import { runSync } from 'mordcai-api/src/modules/property-managers/sync/sync-runner.service.js';
import {
  DebtCase,
  Debtor,
  FlowPolicy,
  InteractionLog,
  PmsConnection,
} from 'mordcai-api/src/models/index.js';

const concurrency = Number(process.env.WORKER_CONCURRENCY) || 5;
const cooldownMinutes = Number(process.env.WORKER_COOLDOWN_MINUTES) || 360;
const contextSignatureVersion = process.env.CALL_CONTEXT_SIGNATURE_VERSION || '1';
const contextTtlSeconds = Number(process.env.CALL_CONTEXT_TTL_SECONDS) || 600;

const getTwilioConfig = () => {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_FROM_NUMBER;
  const voiceUrl = process.env.TWILIO_VOICE_URL;
  const contextHmacSecret = process.env.CALL_CONTEXT_HMAC_SECRET;

  if (!accountSid || !authToken || !fromNumber || !voiceUrl || !contextHmacSecret) {
    throw new Error(
      'Missing TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, TWILIO_VOICE_URL, or CALL_CONTEXT_HMAC_SECRET'
    );
  }

  return { accountSid, authToken, fromNumber, voiceUrl, contextHmacSecret };
};

const buildSignedVoiceUrl = ({ voiceUrl, interactionId, tenantId, caseId, contextHmacSecret }) => {
  const exp = Math.floor(Date.now() / 1000) + contextTtlSeconds;
  const payload = `${interactionId}|${tenantId}|${caseId}|${exp}|${contextSignatureVersion}`;
  const sig = crypto
    .createHmac('sha256', contextHmacSecret)
    .update(payload, 'utf8')
    .digest('base64url');

  const url = new URL(voiceUrl);
  url.searchParams.set('il', interactionId);
  url.searchParams.set('exp', String(exp));
  url.searchParams.set('v', contextSignatureVersion);
  url.searchParams.set('sig', sig);
  return url.toString();
};

const createTwilioCall = async ({ to, interactionId, tenantId, caseId }) => {
  const { accountSid, authToken, fromNumber, voiceUrl, contextHmacSecret } =
    getTwilioConfig();
  const signedVoiceUrl = buildSignedVoiceUrl({
    voiceUrl,
    interactionId,
    tenantId,
    caseId,
    contextHmacSecret,
  });

  const params = new URLSearchParams({
    To: to,
    From: fromNumber,
    Url: signedVoiceUrl,
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
    await debtCase.update({
      status: 'INVALID_CONTACT',
      nextActionAt: null,
      meta: {
        ...(debtCase.meta || {}),
        invalid_contact_reason: 'missing_phone',
      },
    });

    const log = await InteractionLog.create({
      tenantId,
      debtCaseId: debtCase.id,
      debtorId: debtCase.debtorId,
      type: 'CALL',
      status: 'failed',
      channelProvider: 'twilio',
      outcome: 'FAILED',
      summary: 'Call not attempted: debtor phone is missing.',
      error: {
        message: 'Debtor phone is missing',
      },
    });

    return { caseId: debtCase.id, logId: log.id, skipped: true };
  }

  const now = new Date();
  const nextActionAt = new Date(now.getTime() + cooldownMinutes * 60 * 1000);
  let log = null;

  // 1) Persist interaction first so it can be used as signed context in Twilio voice URL.
  const transaction = await sequelize.transaction();
  try {
    log = await InteractionLog.create(
      {
        tenantId,
        debtCaseId: debtCase.id,
        debtorId: debtCase.debtorId,
        type: 'CALL',
        status: 'queued',
        channelProvider: 'twilio',
        providerRef: null,
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
  } catch (error) {
    await transaction.rollback();
    throw error;
  }

  // 2) Call Twilio using signed interaction context.
  try {
    const callSid = await createTwilioCall({
      to: debtorPhone,
      interactionId: log.id,
      tenantId,
      caseId: debtCase.id,
    });

    await log.update({
      providerRef: callSid,
      status: 'in_progress',
    });

    return { caseId: debtCase.id, logId: log.id, callSid };
  } catch (error) {
    logger.error(
      { err: error, tenantId, caseId: debtCase.id, interactionId: log.id },
      'Twilio call failed after interaction creation'
    );

    await log.update({
      status: 'failed',
      outcome: 'FAILED',
      endedAt: new Date(),
      error: {
        ...(log.error || {}),
        message: error?.message || 'Twilio call failed',
      },
    });

    await debtCase.update({
      status: 'IN_PROGRESS',
      nextActionAt: new Date(Date.now() + cooldownMinutes * 60 * 1000),
      meta: {
        ...(debtCase.meta || {}),
        last_call_error_at: new Date().toISOString(),
        last_call_error_message: error?.message || 'Twilio call failed',
      },
    });

    return { caseId: debtCase.id, logId: log.id, callSid: null, failed: true };
  }
};

const start = async () => {
  await loadDatabase();

  if (!sequelize) {
    logger.warn('Worker aborted: database is not initialized.');
    return;
  }

  // Reduce Redis usage for Upstash (limit 500k req): stalled check every 2 min, shared connection
  const workerOpts = {
    connection: redisConnection,
    concurrency,
    stalledInterval: 120000, // 2 min (default 30s) — fewer stall checks = fewer Redis calls
    sharedConnection: true,
  };

  const worker = new Worker(
    CASE_ACTIONS_QUEUE,
    async (job) => {
      if (job.name === JOB_TYPES.CALL_CASE) {
        return processCallCase(job.data);
      }
      logger.warn({ jobName: job.name }, 'Unknown job type received');
      return null;
    },
    { ...workerOpts }
  );

  const pmsSyncWorker = new Worker(
    PMS_SYNC_QUEUE_NAME,
    async (job) => {
      if (job.name === 'sync') {
        const { connectionId, trigger, idempotencyKey, steps } = job.data;
        logger.info(
          { jobId: job.id, connectionId, trigger, steps, attempt: job.attemptsMade + 1 },
          'PMS sync job started'
        );
        return runSync(connectionId, { trigger, idempotencyKey, steps });
      }
      logger.warn({ jobName: job.name }, 'Unknown PMS sync job type');
      return null;
    },
    { ...workerOpts, concurrency: 1 }
  );

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id, name: job.name }, 'Job completed');
  });

  worker.on('failed', (job, error) => {
    logger.error({ jobId: job?.id, error }, 'Job failed');
  });

  pmsSyncWorker.on('completed', (job) => {
    logger.info({ jobId: job.id, name: job.name }, 'PMS sync job completed');
  });

  pmsSyncWorker.on('failed', async (job, error) => {
    const connectionId = job?.data?.connectionId;
    logger.error(
      {
        jobId: job?.id,
        connectionId,
        message: error?.message,
        stack: error?.stack,
        name: error?.name,
      },
      'PMS sync job failed'
    );
    if (connectionId) {
      try {
        await PmsConnection.update(
          {
            status: 'error',
            lastError: { message: error?.message || 'Sync job failed' },
          },
          { where: { id: connectionId } }
        );
        logger.info({ connectionId }, 'PMS connection status reset to error after job failure');
      } catch (updateErr) {
        logger.warn({ connectionId, err: updateErr?.message }, 'Could not reset connection status to error');
      }
    }
  });

  const SHUTDOWN_TIMEOUT_MS = Number(process.env.WORKER_SHUTDOWN_TIMEOUT_MS) || 90_000; // 90s default (PMS sync can be long)

  const doForceClose = async () => {
    try {
      await worker.close();
    } catch (e) {
      logger.warn({ err: e?.message }, 'Error closing case-actions worker');
    }
    try {
      await pmsSyncWorker.close();
    } catch (e) {
      logger.warn({ err: e?.message }, 'Error closing PMS sync worker');
    }
    try {
      await redisConnection.quit();
    } catch (e) {
      logger.warn({ err: e?.message }, 'Error closing Redis');
    }
    if (sequelize) {
      try {
        await sequelize.close();
      } catch (e) {
        logger.warn({ err: e?.message }, 'Error closing Sequelize');
      }
    }
    process.exit(0);
  };

  let shutdownTimeoutId = null;

  const shutdown = async (force = false) => {
    if (shutdown.inProgress && !force) {
      logger.warn('Shutdown already in progress. Press Ctrl+C again to force exit.');
      return;
    }
    if (force && shutdown.inProgress) {
      logger.warn('Forcing exit…');
      if (shutdownTimeoutId) clearTimeout(shutdownTimeoutId);
      await doForceClose();
      return;
    }
    shutdown.inProgress = true;
    logger.info('Shutdown requested. Waiting for current job(s) to finish (Ctrl+C again to force exit)…');

    shutdownTimeoutId = setTimeout(() => {
      shutdownTimeoutId = null;
      logger.warn('Shutdown timeout reached, closing workers and exiting');
      doForceClose();
    }, SHUTDOWN_TIMEOUT_MS);

    try {
      await worker.close();
      await pmsSyncWorker.close();
      if (shutdownTimeoutId) {
        clearTimeout(shutdownTimeoutId);
        shutdownTimeoutId = null;
      }
      await redisConnection.quit();
      if (sequelize) {
        await sequelize.close();
      }
      logger.info('Worker shut down cleanly');
      process.exit(0);
    } catch (err) {
      if (shutdownTimeoutId) {
        clearTimeout(shutdownTimeoutId);
        shutdownTimeoutId = null;
      }
      logger.warn({ err: err?.message }, 'Error during graceful shutdown');
      await doForceClose();
    }
  };
  shutdown.inProgress = false;

  process.on('SIGTERM', () => shutdown(false));
  process.on('SIGINT', () => {
    if (shutdown.inProgress) {
      shutdown(true);
    } else {
      shutdown(false);
    }
  });
};

start().catch((error) => {
  logger.error({ error }, 'Worker failed to start');
  process.exit(1);
});
