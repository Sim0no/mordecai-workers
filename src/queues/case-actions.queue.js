import { Queue } from 'bullmq';
import { withBullmqPrefix } from 'mordcai-api/src/queues/bullmq-queue-options.js';
import { redisConnection } from './redis.js';

export const CASE_ACTIONS_QUEUE = 'case-actions';

export const JOB_TYPES = {
  CALL_CASE: 'CALL_CASE',
  SMS_CASE: 'SMS_CASE',
  EMAIL_CASE: 'EMAIL_CASE',
  SYNC_CALL_SUMMARY: 'SYNC_CALL_SUMMARY',
};

export const caseActionsQueue = new Queue(
  CASE_ACTIONS_QUEUE,
  withBullmqPrefix({ connection: redisConnection })
);
