/**
 * Billing service — Stripe payment intents, idempotent, and patient-
 * scoped. Records every charge attempt in the payments table.
 */
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { StripeClient } from '../../integrations/stripe/client';
import { encryptPHI } from '../../utils/encryption';
import { getAuditLogger } from '../../db/audit';
import { logger } from '../../utils/logger';

export interface ChargePatientInput {
  organisationId: string;
  patientId: string;
  amountCents: number;
  currency: string;
  description: string;
  idempotencyKey?: string;
}

export class BillingService {
  constructor(
    private pool: Pool,
    private stripe: StripeClient
  ) {}

  async chargePatient(input: ChargePatientInput): Promise<{ id: string; status: string }> {
    const localId = uuidv4();
    const idempotencyKey =
      input.idempotencyKey ?? `nrg-clinic-${input.patientId}-${localId}`;

    // Record intent in DB
    await this.pool.query(
      `INSERT INTO payments
        (id, organisation_id, patient_id, amount_cents, currency, status, description_enc)
       VALUES ($1,$2,$3,$4,$5,'pending',$6)`,
      [
        localId,
        input.organisationId,
        input.patientId,
        input.amountCents,
        input.currency,
        encryptPHI(input.description),
      ]
    );

    try {
      const intent = await this.stripe.createPaymentIntent({
        amountCents: input.amountCents,
        currency: input.currency,
        patientId: input.patientId,
        description: input.description,
        idempotencyKey,
      });

      await this.pool.query(
        `UPDATE payments
         SET stripe_payment_intent_id = $2, status = $3, receipt_url = $4, updated_at = now()
         WHERE id = $1`,
        [localId, intent.id, intent.status, intent.receiptUrl]
      );

      await getAuditLogger().record({
        action: 'integration.stripe.charge',
        resourceType: 'payment',
        resourceId: intent.id,
        outcome: 'success',
        metadata: { patientId: input.patientId, amountCents: input.amountCents },
      });

      return { id: localId, status: intent.status };
    } catch (err) {
      logger.error({ err }, 'billing: charge failed');
      await this.pool.query(
        `UPDATE payments SET status = 'failed', updated_at = now() WHERE id = $1`,
        [localId]
      );
      await getAuditLogger().record({
        action: 'integration.stripe.charge',
        outcome: 'failure',
        metadata: { reason: (err as Error).message, localId },
      });
      throw err;
    }
  }
}
