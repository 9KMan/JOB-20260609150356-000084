/**
 * Labs service — orders tests via LabCorp, ingests results pushed
 * via the LabCorp webhook, and stores everything in encrypted form.
 */
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { LabCorpClient, LabResult } from '../../integrations/labcorp/client';
import { encryptPHI } from '../../utils/encryption';
import { getAuditLogger } from '../../db/audit';
import { logger } from '../../utils/logger';

export interface OrderLabTestInput {
  organisationId: string;
  patientId: string;
  providerId: string;
  patient: {
    firstName: string;
    lastName: string;
    dob: string;
    mrn: string;
    gender: 'M' | 'F' | 'O' | 'U';
  };
  provider: { npi: string };
  test: { loinc: string; code: string; name: string };
  priority: 'routine' | 'urgent' | 'stat';
}

export class LabsService {
  constructor(
    private pool: Pool,
    private labcorp: LabCorpClient
  ) {}

  async orderTest(input: OrderLabTestInput): Promise<{ id: string; labcorpOrderId: string; status: string }> {
    const localId = uuidv4();
    const res = await this.labcorp.placeOrder({
      patient: input.patient,
      provider: input.provider,
      tests: [input.test],
      priority: input.priority,
    });

    await this.pool.query(
      `INSERT INTO lab_orders
        (id, organisation_id, patient_id, provider_id, labcorp_order_id,
         test_code, test_name_enc, status, ordered_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())`,
      [
        localId,
        input.organisationId,
        input.patientId,
        input.providerId,
        res.labcorpOrderId,
        input.test.code,
        encryptPHI(input.test.name),
        res.status === 'received' ? 'ordered' : 'cancelled',
      ]
    );

    await getAuditLogger().record({
      action: 'integration.labcorp.order.create',
      userId: input.providerId,
      resourceType: 'lab_order',
      resourceId: res.labcorpOrderId,
      outcome: 'success',
      metadata: { localId, loinc: input.test.loinc },
    });

    return { id: localId, labcorpOrderId: res.labcorpOrderId, status: res.status };
  }

  async ingestResult(result: LabResult): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: orderRows } = await client.query(
        `SELECT id, provider_id FROM lab_orders
         WHERE labcorp_order_id = $1 FOR UPDATE`,
        [result.labcorpOrderId]
      );
      if (orderRows.length === 0) {
        // Unknown order — likely we missed the original create call.
        // Record and skip to avoid orphans.
        logger.warn(
          { labcorpOrderId: result.labcorpOrderId },
          'labs: result for unknown order, skipping'
        );
        await client.query('ROLLBACK');
        return;
      }
      const orderId = orderRows[0].id;
      await client.query(
        `UPDATE lab_orders SET status = 'resulted', resulted_at = $2, updated_at = now()
         WHERE id = $1`,
        [orderId, result.resultedAt]
      );
      for (const v of result.values) {
        await client.query(
          `INSERT INTO lab_results
            (lab_order_id, test_code, test_name_enc, value_enc, unit,
             reference_range_enc, abnormal_flag, observed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            orderId,
            v.testCode,
            encryptPHI(v.testName),
            encryptPHI(v.value),
            v.unit ?? null,
            v.referenceRange ? encryptPHI(v.referenceRange) : null,
            v.abnormalFlag ?? null,
            v.observedAt,
          ]
        );
      }
      await client.query('COMMIT');

      await getAuditLogger().record({
        action: 'integration.labcorp.result.receive',
        resourceType: 'lab_order',
        resourceId: result.labcorpOrderId,
        outcome: 'success',
        metadata: { valuesCount: result.values.length },
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
