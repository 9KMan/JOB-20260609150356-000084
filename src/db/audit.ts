/**
 * Audit log — HIPAA Security Rule §164.312(b) requires audit controls
 * for hardware, software, and procedural mechanisms that record and
 * examine activity in information systems containing ePHI.
 *
 * Every PHI access, every auth event, every external integration call
 * touching PHI, and every admin action goes through this logger. The
 * audit table is append-only at the application level (we never expose
 * update/delete).
 */
import { Pool } from 'pg';
import { logger } from '../utils/logger';
import { getPool } from './pool';

export type AuditAction =
  | 'auth.login.success'
  | 'auth.login.failure'
  | 'auth.logout'
  | 'auth.token.refresh'
  | 'phi.read'
  | 'phi.write'
  | 'phi.export'
  | 'migration.charm_to_healthie.patient'
  | 'migration.charm_to_healthie.appointment'
  | 'integration.healthie.request'
  | 'integration.dosespot.prescription.create'
  | 'integration.labcorp.order.create'
  | 'integration.labcorp.result.receive'
  | 'integration.stripe.charge'
  | 'integration.zoho.sync'
  | 'automation.workflow.trigger'
  | 'admin.user.create'
  | 'admin.user.update'
  | 'admin.user.deactivate'
  | 'telehealth.session.create';

export interface AuditEvent {
  action: AuditAction;
  userId?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  outcome: 'success' | 'failure';
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown> | null;
}

export class AuditLogger {
  private pool: Pool;

  constructor(pool?: Pool) {
    this.pool = pool ?? getPool();
  }

  async record(event: AuditEvent): Promise<void> {
    const query = `
      INSERT INTO audit_log
        (action, user_id, resource_type, resource_id, outcome, ip_address, user_agent, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, created_at
    `;
    try {
      await this.pool.query(query, [
        event.action,
        event.userId ?? null,
        event.resourceType ?? null,
        event.resourceId ?? null,
        event.outcome,
        event.ipAddress ?? null,
        event.userAgent ?? null,
        event.metadata ? JSON.stringify(event.metadata) : null,
      ]);
    } catch (err) {
      // Audit failure is itself a security event. We log loudly but do
      // not throw, because blocking the user-facing action on a failed
      // audit write would create a DoS path. The monitoring stack
      // alerts on ERROR-level "AUDIT WRITE FAILED" messages.
      logger.error({ err, event }, 'AUDIT WRITE FAILED');
    }
  }
}

let singleton: AuditLogger | null = null;
export function getAuditLogger(): AuditLogger {
  if (!singleton) singleton = new AuditLogger();
  return singleton;
}
