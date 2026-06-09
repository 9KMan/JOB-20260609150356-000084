/**
 * Background worker — runs long-lived automations:
 *   - daily Charm → Healthie delta sync
 *   - nightly billing reconciliation against Stripe
 *   - lab results poller (fallback for missed webhooks)
 *
 * For a production deployment this is the entrypoint; for the PoC we
 * just have a minimal scheduler. In production we'd back this with
 * BullMQ on Redis.
 */
import { config } from '../config';
import { logger } from '../utils/logger';
import { getPool, closePool } from '../db/pool';
import { CharmClient } from '../integrations/charm/client';
import { HealthieClient } from '../integrations/healthie/client';
import { StripeClient } from '../integrations/stripe/client';
import { LabCorpClient } from '../integrations/labcorp/client';
import { CharmToHealthieMigration } from '../services/migration/charmToHealthie';
import { LabsService } from '../services/labs/labsService';
import { AutomationDispatcher } from '../services/automation/automationDispatcher';

const HOURLY = 60 * 60 * 1000;

async function runCharmSync(): Promise<void> {
  const pool = getPool();
  // In production we would iterate over every organisation with an
  // active integration. For the PoC we look up the first one.
  const { rows } = await pool.query(
    `SELECT id, slug FROM organisations WHERE deleted_at IS NULL LIMIT 1`
  );
  if (rows.length === 0) {
    logger.info('worker: no organisations, skipping charm sync');
    return;
  }
  const orgId = rows[0].id as string;
  const charm = new CharmClient();
  const healthie = new HealthieClient();
  const migration = new CharmToHealthieMigration({
    organisationId: orgId,
    triggeredBy: null as unknown as string, // system run
    charm,
    healthie,
    pool,
  });
  const summary = await migration.run();
  logger.info({ summary }, 'worker: charm sync done');
}

async function runLabPoller(): Promise<void> {
  const pool = getPool();
  const labcorp = new LabCorpClient();
  const labs = new LabsService(pool, labcorp);
  // Find orders that have been in 'ordered' state for > 24 hours
  const { rows } = await pool.query(
    `SELECT id, labcorp_order_id FROM lab_orders
     WHERE status IN ('ordered','collected','in_transit')
       AND updated_at < now() - interval '24 hours'
     LIMIT 100`
  );
  for (const o of rows) {
    try {
      const result = await labcorp.fetchResult(o.labcorp_order_id);
      await labs.ingestResult(result);
    } catch (err) {
      logger.warn({ err, labcorpOrderId: o.labcorp_order_id }, 'lab poller: skip');
    }
  }
}

async function tick(): Promise<void> {
  try {
    await runCharmSync();
  } catch (err) {
    logger.error({ err }, 'worker: charm sync failed');
  }
  try {
    await runLabPoller();
  } catch (err) {
    logger.error({ err }, 'worker: lab poller failed');
  }
  // Fire-and-forget automation triggers for downstream consumers
  try {
    const dispatcher = new AutomationDispatcher();
    await dispatcher.dispatch({
      target: 'keragon',
      workflowId: 'heartbeat',
      event: { type: 'heartbeat', organisationId: 'all', payload: { ts: new Date().toISOString() } },
    });
  } catch (err) {
    logger.warn({ err }, 'worker: automation heartbeat failed');
  }
}

async function main(): Promise<void> {
  logger.info({ env: config.env }, 'worker started');
  // First tick immediately, then hourly
  await tick();
  setInterval(() => {
    void tick();
  }, HOURLY);

  const shutdown = async (): Promise<void> => {
    logger.info('worker shutdown');
    await closePool();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

if (require.main === module) {
  main().catch((err) => {
    logger.error({ err }, 'worker fatal');
    process.exit(1);
  });
}
