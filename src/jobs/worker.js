import 'dotenv/config';
import crypto from 'crypto';
import { Worker, Queue } from 'bullmq';
import { Op } from 'sequelize';
import { loadDatabase } from 'mordcai-api/src/loaders/sequelize.load.js';
import { sequelize } from 'mordcai-api/src/config/database.js';
import { logger } from 'mordcai-api/src/utils/logger.js';
import { redisConnection } from '../queues/redis.js';
import { CASE_ACTIONS_QUEUE, JOB_TYPES } from '../queues/case-actions.queue.js';
import { PMS_SYNC_QUEUE_NAME } from 'mordcai-api/src/queues/pms-sync.queue.js';
import { COLLECTION_TICK_QUEUE_NAME } from 'mordcai-api/src/queues/collection-tick.queue.js';
import { AUTOMATION_MAINTENANCE_QUEUE_NAME } from 'mordcai-api/src/queues/automation-maintenance.queue.js';
import { runHourlyMaintenance } from 'mordcai-api/src/modules/automations/automation-hourly-maintenance.service.js';
import { runDailyFullSync } from 'mordcai-api/src/modules/automations/automation-daily-fullsync.service.js';
import { runSync } from 'mordcai-api/src/modules/property-managers/sync/sync-runner.service.js';
import { propertyManagersService } from 'mordcai-api/src/modules/property-managers/property-managers.service.js';
import { buildNewCasesFromPms } from 'mordcai-api/src/modules/property-managers/case-build.service.js';
import { refreshCasesFromPms } from 'mordcai-api/src/modules/property-managers/case-refresh.service.js';
import { releaseLock } from 'mordcai-api/src/utils/pms-sync-lock.js';
import { runCollectionTick } from 'mordcai-api/src/modules/collections/collection-tick.service.js';
import {
  DebtCase,
  Debtor,
  InteractionLog,
  PmsConnection,
  Tenant,
  CollectionStage,
  CaseAutomationState,
  CaseDispute,
} from 'mordcai-api/src/models/index.js';
import { resolvePolicyForCase } from 'mordcai-api/src/modules/collections/policy-resolver.service.js';
import { sendCollectionSms } from 'mordcai-api/src/modules/twilio/sms/twilio.sms.service.js';
import { sendCollectionEmail } from 'mordcai-api/src/modules/email/ses/ses.email.service.js';

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
    include: [{ model: Debtor, as: 'debtor' }],
  });

  if (!debtCase) {
    throw new Error('Debt case not found');
  }

  if ((debtCase.approvalStatus ?? debtCase.approval_status) !== 'APPROVED') {
    return { caseId: debtCase.id, skipped: true, reason: 'approval_required' };
  }

  const hasOpenDispute = await CaseDispute.count({
    where: { debtCaseId: caseId, status: 'OPEN' },
  }) > 0;
  if (hasOpenDispute) {
    return { caseId: debtCase.id, skipped: true, reason: 'open_dispute' };
  }

  const resolvedPolicy = await resolvePolicyForCase(tenantId, debtCase);
  debtCase.resolvedPolicy = resolvedPolicy;

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

  const activeCall = await InteractionLog.findOne({
    where: {
      tenantId,
      debtCaseId: debtCase.id,
      type: 'CALL',
      status: { [Op.in]: ['queued', 'in_progress'] },
      endedAt: null,
    },
    order: [['createdAt', 'DESC']],
  });

  if (activeCall) {
    logger.warn(
      {
        tenantId,
        caseId: debtCase.id,
        interactionId: activeCall.id,
      },
      'Skipping CALL_CASE because there is already an active call interaction'
    );
    return {
      caseId: debtCase.id,
      logId: activeCall.id,
      skipped: true,
      reason: 'active_call_exists',
    };
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

const processSmsCase = async ({ tenantId, caseId, automationId, stateId }) => {
  const debtCase = await DebtCase.findOne({
    where: { id: caseId, tenantId },
    include: [{ model: Debtor, as: 'debtor' }],
  });
  if (!debtCase) throw new Error('Debt case not found');

  let stage = null;
  if (stateId) {
    const state = await CaseAutomationState.findByPk(stateId, {
      include: [{ model: CollectionStage, as: 'currentStage' }],
    });
    stage = state?.currentStage || null;
  }

  const tenant = await Tenant.findByPk(tenantId, { attributes: ['id', 'name'] });

  return sendCollectionSms({
    tenantId,
    automationId,
    state: { debtCaseId: caseId, debtorId: debtCase.debtorId },
    debtCase,
    debtor: debtCase.debtor,
    stage,
    tenant,
  });
};

const processEmailCase = async ({ tenantId, caseId, automationId, stateId }) => {
  const debtCase = await DebtCase.findOne({
    where: { id: caseId, tenantId },
    include: [{ model: Debtor, as: 'debtor' }],
  });
  if (!debtCase) throw new Error('Debt case not found');

  if ((debtCase.approvalStatus ?? debtCase.approval_status) !== 'APPROVED') {
    return { caseId: debtCase.id, skipped: true, reason: 'approval_required' };
  }
  const hasOpenDispute = await CaseDispute.count({ where: { debtCaseId: caseId, status: 'OPEN' } }) > 0;
  if (hasOpenDispute) return { caseId: debtCase.id, skipped: true, reason: 'open_dispute' };

  let stage = null;
  if (stateId) {
    const state = await CaseAutomationState.findByPk(stateId, {
      include: [{ model: CollectionStage, as: 'currentStage' }],
    });
    stage = state?.currentStage || null;
  }

  return sendCollectionEmail({
    tenantId,
    automationId,
    state: { debtCaseId: caseId, debtorId: debtCase.debtorId },
    debtCase,
    debtor: debtCase.debtor,
    stage,
  });
};

const start = async () => {
  await loadDatabase();

  if (!sequelize) {
    logger.warn('Worker aborted: database is not initialized.');
    return;
  }

  // Reduce Redis usage for Upstash (limit 500k req)
  const workerOpts = {
    connection: redisConnection,
    concurrency,
    stalledInterval: 120000, // 2 min (default 30s) — fewer stall checks = fewer Redis calls
    sharedConnection: true,
    blockingTimeout: 60000, // 60s — in idle, pop every min vs ~5s default → ~10–12x fewer BZPOPMIN/EVALSHA
    drainDelay: 5000,       // graceful drain on shutdown
  };

  const worker = new Worker(
    CASE_ACTIONS_QUEUE,
    async (job) => {
      if (job.name === JOB_TYPES.CALL_CASE) {
        return processCallCase(job.data);
      }
      if (job.name === JOB_TYPES.SMS_CASE) {
        return processSmsCase(job.data);
      }
      if (job.name === JOB_TYPES.EMAIL_CASE) {
        return processEmailCase(job.data);
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
      if (job.name === 'build-cases' || job.name === 'build-new-cases') {
        const { connectionId, tenantId } = job.data;
        logger.info({ jobId: job.id, connectionId, tenantId }, 'Build new cases job started');
        const result = await buildNewCasesFromPms(tenantId, connectionId);
        logger.info({ jobId: job.id, ...result }, 'Build new cases job completed');
        return result;
      }
      if (job.name === 'refresh-cases') {
        const { connectionId, tenantId } = job.data;
        logger.info({ jobId: job.id, connectionId, tenantId }, 'Refresh cases job started');
        const result = await refreshCasesFromPms(tenantId, connectionId);
        logger.info({ jobId: job.id, ...result }, 'Refresh cases job completed');
        return result;
      }
      if (job.name === 'sync-full-flow') {
        const { connectionId, tenantId } = job.data;
        logger.info({ jobId: job.id, connectionId, tenantId }, 'Sync full flow job started');
        const results = await propertyManagersService.runSyncFullFlow(tenantId, connectionId);
        logger.info({ jobId: job.id, ...results }, 'Sync full flow job completed');
        return results;
      }
      logger.warn({ jobName: job.name }, 'Unknown PMS sync job type');
      return null;
    },
    { ...workerOpts, concurrency: 1 }
  );

  const collectionTickWorker = new Worker(
    COLLECTION_TICK_QUEUE_NAME,
    async (job) => {
      if (job.name === 'tick') {
        logger.debug({ jobId: job.id }, 'Collection tick job started');
        return runCollectionTick();
      }
      logger.warn({ jobName: job.name }, 'Unknown collection tick job type');
      return null;
    },
    { ...workerOpts, concurrency: 1 }
  );

  const collectionTickQueue = new Queue(COLLECTION_TICK_QUEUE_NAME, { connection: redisConnection });
  await collectionTickQueue.add('tick', {}, { repeat: { every: 15 * 60 * 1000 } });
  logger.info('Collection tick repeatable job scheduled (every 15 min)');

  const automationMaintenanceWorker = new Worker(
    AUTOMATION_MAINTENANCE_QUEUE_NAME,
    async (job) => {
      if (job.name === 'hourly') {
        logger.info({ jobId: job.id }, 'Automation hourly maintenance job started');
        return runHourlyMaintenance();
      }
      if (job.name === 'daily-fullsync') {
        logger.info({ jobId: job.id }, 'Automation daily full sync job started');
        return runDailyFullSync();
      }
      logger.warn({ jobName: job.name }, 'Unknown automation maintenance job type');
      return null;
    },
    { ...workerOpts, concurrency: 1 }
  );

  const automationMaintenanceQueue = new Queue(AUTOMATION_MAINTENANCE_QUEUE_NAME, {
    connection: redisConnection,
  });
  if (process.env.REDIS_URL) {
    await automationMaintenanceQueue.add(
      'hourly',
      {},
      { jobId: 'automation-hourly-recurring', repeat: { every: 60 * 60 * 1000 } }
    );
    await automationMaintenanceQueue.add(
      'daily-fullsync',
      {},
      { jobId: 'automation-daily-fullsync-recurring', repeat: { every: 24 * 60 * 60 * 1000 } }
    );
    logger.info(
      'Automation maintenance repeatable jobs scheduled (hourly: 60 min, daily-fullsync: 24h)'
    );
  } else {
    logger.warn('Automation maintenance queue not available (REDIS_URL?). Skipping scheduled jobs.');
  }

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id, name: job.name }, 'Job completed');
  });

  worker.on('failed', (job, error) => {
    logger.error({ jobId: job?.id, error }, 'Job failed');
  });

  pmsSyncWorker.on('completed', async (job) => {
    logger.info({ jobId: job.id, name: job.name }, 'PMS sync job completed');
    const { tenantId, connectionId } = job?.data || {};
    if (tenantId && connectionId) {
      await releaseLock(tenantId, connectionId);
    }
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
    const tenantId = job?.data?.tenantId;
    if (tenantId && connectionId) {
      await releaseLock(tenantId, connectionId);
    }
    if (connectionId) {
      try {
        const conn = await PmsConnection.findByPk(connectionId, { attributes: ['id', 'syncState'] });
        if (conn) {
          const prevState = conn.syncState ?? {};
          await PmsConnection.update(
            {
              status: 'error',
              lastError: { message: error?.message || 'Sync job failed' },
              syncState: {
                ...prevState,
                lastRunStatus: 'FAILED',
                lastErrorMessage: error?.message || 'Sync job failed',
              },
            },
            { where: { id: connectionId } }
          );
          logger.info({ connectionId }, 'PMS connection status reset to error after job failure');
        }
      } catch (updateErr) {
        logger.warn({ connectionId, err: updateErr?.message }, 'Could not reset connection status to error');
      }
    }
  });

  const SHUTDOWN_TIMEOUT_MS = Number(process.env.WORKER_SHUTDOWN_TIMEOUT_MS) || 90_000; // 90s default (PMS sync can be long)

  collectionTickWorker.on('completed', (job) => {
    logger.debug({ jobId: job.id }, 'Collection tick job completed');
  });
  collectionTickWorker.on('failed', (job, error) => {
    logger.error({ jobId: job?.id, error }, 'Collection tick job failed');
  });

  automationMaintenanceWorker.on('completed', (job) => {
    logger.info({ jobId: job.id, name: job.name }, 'Automation maintenance job completed');
  });
  automationMaintenanceWorker.on('failed', (job, error) => {
    logger.error({ jobId: job?.id, name: job?.name, error }, 'Automation maintenance job failed');
  });

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
      await collectionTickWorker.close();
    } catch (e) {
      logger.warn({ err: e?.message }, 'Error closing collection tick worker');
    }
    try {
      await automationMaintenanceWorker.close();
    } catch (e) {
      logger.warn({ err: e?.message }, 'Error closing automation maintenance worker');
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
      await collectionTickWorker.close();
      await automationMaintenanceWorker.close();
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
