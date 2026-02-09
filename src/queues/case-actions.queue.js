import { Queue } from 'bullmq';
import { redisConnection } from './redis.js';

export const CASE_ACTIONS_QUEUE = 'case-actions';

export const JOB_TYPES = {
  CALL_CASE: 'CALL_CASE',
  SYNC_CALL_SUMMARY: 'SYNC_CALL_SUMMARY',
};

export const caseActionsQueue = new Queue(CASE_ACTIONS_QUEUE, {
  connection: redisConnection,
});
