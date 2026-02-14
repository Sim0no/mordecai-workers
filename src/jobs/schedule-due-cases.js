import { sequelize } from 'mordcai-api/src/config/database.js';
import { logger } from 'mordcai-api/src/utils/logger.js';
import { caseActionsQueue, JOB_TYPES } from '../queues/case-actions.queue.js';

const DEFAULT_LIMIT = 500;
const DEFAULT_PER_TENANT_LIMIT = 10;
const DEFAULT_COOLDOWN_MINUTES = 360;
const includeDemoCases =
  String(process.env.SCHEDULER_INCLUDE_DEMO_CASES || 'false').toLowerCase() ===
  'true';

const resolvePerTenantLimit = (tenantId, limit, perTenantLimit) =>
  tenantId ? limit : perTenantLimit;

const buildTenantClause = (tenantId, replacements) => {
  if (!tenantId) {
    return '';
  }

  replacements.tenantId = tenantId;
  return 'AND dc.tenant_id = :tenantId';
};

const buildDemoSourceClause = () => {
  if (includeDemoCases) return '';
  return "AND COALESCE(dc.meta->>'source', '') <> 'demo-ui'";
};

export const listDueCallCases = async ({
  tenantId,
  limit = DEFAULT_LIMIT,
  perTenantLimit = DEFAULT_PER_TENANT_LIMIT,
} = {}) => {
  if (!sequelize) {
    throw new Error('Database connection is not initialized.');
  }

  const effectivePerTenantLimit = resolvePerTenantLimit(
    tenantId,
    limit,
    perTenantLimit
  );
  const replacements = { limit, perTenantLimit: effectivePerTenantLimit };
  const tenantClause = buildTenantClause(tenantId, replacements);
  const demoClause = buildDemoSourceClause();

  const sql = `
    WITH due AS (
      SELECT
        dc.id,
        dc.tenant_id,
        dc.next_action_at,
        dc.created_at,
        row_number() OVER (
          PARTITION BY dc.tenant_id
          ORDER BY dc.next_action_at NULLS FIRST, dc.created_at
        ) AS rn
      FROM debt_cases dc
      JOIN flow_policies fp ON fp.id = dc.flow_policy_id
      WHERE dc.status IN ('NEW','IN_PROGRESS')
        AND (dc.next_action_at IS NULL OR dc.next_action_at <= NOW())
        ${tenantClause}
        ${demoClause}
        AND COALESCE((fp.channels->>'call')::boolean, false) = true
    )
    SELECT id, tenant_id
    FROM due
    WHERE rn <= :perTenantLimit
    ORDER BY next_action_at NULLS FIRST, created_at
    LIMIT :limit;
  `;

  const [rows] = await sequelize.query(sql, { replacements });
  return rows || [];
};

const claimDueCallCases = async ({
  tenantId,
  limit = DEFAULT_LIMIT,
  perTenantLimit = DEFAULT_PER_TENANT_LIMIT,
  cooldownMinutes = DEFAULT_COOLDOWN_MINUTES,
  transaction,
} = {}) => {
  if (!sequelize) {
    throw new Error('Database connection is not initialized.');
  }

  const effectivePerTenantLimit = resolvePerTenantLimit(
    tenantId,
    limit,
    perTenantLimit
  );
  const replacements = {
    limit,
    perTenantLimit: effectivePerTenantLimit,
    cooldownMinutes,
  };
  const tenantClause = buildTenantClause(tenantId, replacements);
  const demoClause = buildDemoSourceClause();

  const sql = `
    WITH due AS (
      SELECT
        dc.id,
        dc.tenant_id,
        dc.next_action_at,
        dc.created_at,
        row_number() OVER (
          PARTITION BY dc.tenant_id
          ORDER BY dc.next_action_at NULLS FIRST, dc.created_at
        ) AS rn
      FROM debt_cases dc
      JOIN flow_policies fp ON fp.id = dc.flow_policy_id
      WHERE dc.status IN ('NEW','IN_PROGRESS')
        AND (dc.next_action_at IS NULL OR dc.next_action_at <= NOW())
        ${tenantClause}
        ${demoClause}
        AND COALESCE((fp.channels->>'call')::boolean, false) = true
    ),
    picked AS (
      SELECT id
      FROM due
      WHERE rn <= :perTenantLimit
      ORDER BY next_action_at NULLS FIRST, created_at
      LIMIT :limit
      FOR UPDATE SKIP LOCKED
    )
    UPDATE debt_cases dc
    SET next_action_at = NOW() + (:cooldownMinutes || ' minutes')::interval
    FROM picked
    WHERE dc.id = picked.id
    RETURNING dc.id, dc.tenant_id;
  `;

  const [rows] = await sequelize.query(sql, {
    replacements,
    transaction,
  });

  return rows || [];
};

export const scheduleDueCallCases = async ({
  tenantId,
  limit = DEFAULT_LIMIT,
  perTenantLimit = DEFAULT_PER_TENANT_LIMIT,
  cooldownMinutes = DEFAULT_COOLDOWN_MINUTES,
  dryRun = false,
} = {}) => {
  if (dryRun) {
    const rows = await listDueCallCases({ tenantId, limit, perTenantLimit });
    return {
      dryRun: true,
      queued: 0,
      found: rows.length,
      cases: rows,
    };
  }

  const result = await sequelize.transaction(async (transaction) => {
    const rows = await claimDueCallCases({
      tenantId,
      limit,
      perTenantLimit,
      cooldownMinutes,
      transaction,
    });

    return rows;
  });

  let queued = 0;
  for (const row of result) {
    try {
      const payload = {
        tenantId: row.tenant_id,
        caseId: row.id,
      };

      await caseActionsQueue.add(
        JOB_TYPES.CALL_CASE,
        payload,
        {
          jobId: `${JOB_TYPES.CALL_CASE}-${row.id}`,
          attempts: Number(process.env.WORKER_ATTEMPTS) || 3,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: 1000,
          removeOnFail: 5000,
        }
      );
      queued += 1;
    } catch (error) {
      logger.error(
        { err: error, caseId: row.id },
        'Failed to enqueue case action job'
      );
    }
  }

  return {
    dryRun: false,
    queued,
    found: result.length,
  };
};
