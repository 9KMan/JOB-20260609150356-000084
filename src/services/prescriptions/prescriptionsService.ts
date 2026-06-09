/**
 * Prescriptions service — orchestrates the DoseSpot e-prescribing
 * integration. Encrypts PHI at rest, never logs it, and records an
 * audit event for every create/status change.
 */
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { DoseSpotClient } from '../../integrations/dosespot/client';
import { encryptPHI } from '../../utils/encryption';
import { getAuditLogger } from '../../db/audit';
import { logger } from '../../utils/logger';

export interface PrescribeInput {
  organisationId: string;
  patientId: string;
  providerId: string;
  drug: {
    name: string;
    ndc?: string;
    dose: string;
    route: string;
    frequency: string;
    durationDays: number;
    refills: number;
    genericAllowed: boolean;
  };
  pharmacy: { ncpdpId: string };
  notes?: string;
  ipAddress?: string;
  userAgent?: string;
}

export class PrescriptionsService {
  constructor(
    private pool: Pool,
    private dosespot: DoseSpotClient
  ) {}

  async prescribe(input: PrescribeInput): Promise<{ id: string; status: string }> {
    const audit = getAuditLogger();
    const localId = uuidv4();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Insert in 'pending' state — we update on DoseSpot success.
      const { rows } = await client.query(
        `INSERT INTO prescriptions
          (id, organisation_id, patient_id, provider_id,
           drug_name_enc, dose_enc, frequency_enc, duration_days, refills,
           status, pharmacy_ncpdp_id, notes_enc, prescribed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10,$11, now())
         RETURNING id`,
        [
          localId,
          input.organisationId,
          input.patientId,
          input.providerId,
          encryptPHI(input.drug.name),
          encryptPHI(`${input.drug.dose} ${input.drug.route}`),
          encryptPHI(input.drug.frequency),
          input.drug.durationDays,
          input.drug.refills,
          input.pharmacy.ncpdpId,
          input.notes ? encryptPHI(input.notes) : null,
        ]
      );
      const insertedId = rows[0].id;
      await client.query('COMMIT');

      // Push to DoseSpot
      const result = await this.dosespot.createPrescription({
        patientId: input.patientId,
        providerId: input.providerId,
        drug: input.drug,
        pharmacy: input.pharmacy,
        notes: input.notes,
      });

      // Update with DoseSpot's id and final status
      await this.pool.query(
        `UPDATE prescriptions
         SET dosespot_prescription_id = $2, status = $3, updated_at = now()
         WHERE id = $1`,
        [insertedId, result.prescriptionId, result.status]
      );

      await audit.record({
        action: 'integration.dosespot.prescription.create',
        userId: input.providerId,
        resourceType: 'prescription',
        resourceId: result.prescriptionId,
        outcome: 'success',
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
        metadata: { patientId: input.patientId, localId: insertedId },
      });

      return { id: insertedId, status: result.status };
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error({ err }, 'prescriptions: prescribe failed');
      // Mark as error
      await this.pool.query(
        `UPDATE prescriptions SET status = 'error', updated_at = now()
         WHERE id = $1`,
        [localId]
      ).catch(() => undefined);
      await audit.record({
        action: 'integration.dosespot.prescription.create',
        outcome: 'failure',
        metadata: { reason: (err as Error).message, localId },
      });
      throw err;
    } finally {
      client.release();
    }
  }
}
