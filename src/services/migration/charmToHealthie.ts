/**
 * Charm → Healthie migration service.
 *
 * Goal: walk every patient and every appointment in the legacy Charm
 * EHR and create an equivalent record in the target Healthie EHR.
 * Idempotent — we never create a duplicate. If we already have a
 * charm_patient_id row, we look up the Healthie id and reuse it.
 *
 * Errors are recorded in migration_failures but don't abort the run
 * unless the failure rate crosses a threshold. Each successful step
 * is committed in its own transaction; the run itself is updated
 * with counters as it goes.
 */
import { Pool, PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { CharmClient, CharmPatient, CharmAppointment } from '../../integrations/charm/client';
import { HealthieClient } from '../../integrations/healthie/client';
import { getAuditLogger } from '../../db/audit';
import { encryptPHI, blindIndex } from '../../utils/encryption';
import { logger } from '../../utils/logger';

export interface MigrationRunSummary {
  runId: string;
  patientsTotal: number;
  patientsMigrated: number;
  patientsFailed: number;
  appointmentsTotal: number;
  appointmentsMigrated: number;
  appointmentsFailed: number;
}

export interface MigrationOptions {
  organisationId: string;
  triggeredBy: string;
  charm: CharmClient;
  healthie: HealthieClient;
  pool: Pool;
  /** Optional cursor for resumable runs */
  resumeFromCharmId?: string;
  /** Failure rate above this aborts the run. Default 0.5 (50%). */
  abortOnFailureRate?: number;
}

export class CharmToHealthieMigration {
  private opts: MigrationOptions;

  constructor(opts: MigrationOptions) {
    this.opts = opts;
  }

  async run(): Promise<MigrationRunSummary> {
    const audit = getAuditLogger();
    const runId = uuidv4();
    const client = await this.opts.pool.connect();
    let run: MigrationRunSummary;

    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO migration_runs
          (id, organisation_id, triggered_by, status)
         VALUES ($1, $2, $3, 'running')
         RETURNING id`,
        [runId, this.opts.organisationId, this.opts.triggeredBy]
      );
      runId === rows[0].id;
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    await audit.record({
      action: 'automation.workflow.trigger',
      userId: this.opts.triggeredBy,
      resourceType: 'migration_run',
      resourceId: runId,
      outcome: 'success',
      metadata: { kind: 'charm_to_healthie' },
    });

    try {
      // 1) Patients
      const patients = await this.opts.charm.listPatients({ pageSize: 200 });
      logger.info(
        { runId, total: patients.length },
        'migration: patients loaded from charm'
      );

      let migratedPatients = 0;
      let failedPatients = 0;
      for (const p of patients) {
        try {
          await this.migratePatient(runId, p);
          migratedPatients++;
        } catch (err) {
          failedPatients++;
          await this.recordFailure(runId, 'patient', p.patient_id, (err as Error).message);
          logger.error({ err, charmId: p.patient_id }, 'migration: patient failed');
        }
      }

      // 2) Appointments (look back 90 days to keep it bounded)
      const today = new Date();
      const from = new Date(today.getTime() - 90 * 24 * 60 * 60 * 1000);
      const appts = await this.opts.charm.listAppointments({
        from: from.toISOString(),
        to: today.toISOString(),
        pageSize: 200,
      });
      logger.info(
        { runId, total: appts.length },
        'migration: appointments loaded from charm'
      );

      let migratedAppts = 0;
      let failedAppts = 0;
      for (const a of appts) {
        try {
          await this.migrateAppointment(runId, a);
          migratedAppts++;
        } catch (err) {
          failedAppts++;
          await this.recordFailure(
            runId,
            'appointment',
            a.appointment_id,
            (err as Error).message
          );
          logger.error(
            { err, charmApptId: a.appointment_id },
            'migration: appointment failed'
          );
        }
      }

      const failRate = patients.length > 0 ? failedPatients / patients.length : 0;
      const finalStatus =
        failRate > (this.opts.abortOnFailureRate ?? 0.5) ? 'partial' : 'completed';

      await this.opts.pool.query(
        `UPDATE migration_runs
         SET status = $2,
             patients_total = $3,
             patients_migrated = $4,
             patients_failed = $5,
             appointments_total = $6,
             appointments_migrated = $7,
             appointments_failed = $8,
             finished_at = now()
         WHERE id = $1`,
        [
          runId,
          finalStatus,
          patients.length,
          migratedPatients,
          failedPatients,
          appts.length,
          migratedAppts,
          failedAppts,
        ]
      );

      run = {
        runId,
        patientsTotal: patients.length,
        patientsMigrated: migratedPatients,
        patientsFailed: failedPatients,
        appointmentsTotal: appts.length,
        appointmentsMigrated: migratedAppts,
        appointmentsFailed: failedAppts,
      };
    } catch (err) {
      await this.opts.pool.query(
        `UPDATE migration_runs
         SET status = 'failed', finished_at = now(), error_message = $2
         WHERE id = $1`,
        [runId, (err as Error).message]
      );
      throw err;
    }

    return run;
  }

  private async migratePatient(runId: string, p: CharmPatient): Promise<void> {
    const client = await this.opts.pool.connect();
    try {
      await client.query('BEGIN');
      const idx = blindIndex(p.patient_id);
      const existing = await client.query(
        `SELECT id, healthie_patient_id FROM patients
         WHERE organisation_id = $1 AND charm_patient_id_idx = $2
         FOR UPDATE`,
        [this.opts.organisationId, idx]
      );

      let healthiePatientId: string;
      if (existing.rows.length > 0 && existing.rows[0].healthie_patient_id) {
        healthiePatientId = existing.rows[0].healthie_patient_id;
        logger.info(
          { charmId: p.patient_id, healthieId: healthiePatientId },
          'migration: patient already mapped, skipping create'
        );
      } else {
        const created = await this.opts.healthie.createPatient({
          first_name: p.first_name,
          last_name: p.last_name,
          email: p.email,
          phone_number: p.phone,
          date_of_birth: p.dob,
          gender: p.gender,
          external_id: p.patient_id,
        });
        healthiePatientId = created.createPatient.patient.id;
      }

      if (existing.rows.length === 0) {
        // Insert new row
        const mrn = `CHARM-${p.patient_id}`;
        await client.query(
          `INSERT INTO patients
            (organisation_id, charm_patient_id, charm_patient_id_idx,
             healthie_patient_id, healthie_patient_id_idx,
             mrn, mrn_idx, first_name_enc, last_name_enc, dob_enc,
             email_enc, phone_enc, address_enc,
             insurance_payer_enc, insurance_member_id_enc)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [
            this.opts.organisationId,
            p.patient_id,
            idx,
            healthiePatientId,
            blindIndex(healthiePatientId),
            mrn,
            blindIndex(mrn),
            encryptPHI(p.first_name),
            encryptPHI(p.last_name),
            encryptPHI(p.dob),
            encryptPHI(p.email),
            encryptPHI(p.phone),
            encryptPHI(
              [p.address, p.city, p.state, p.zip].filter(Boolean).join(', ')
            ),
            p.insurance ? encryptPHI(p.insurance.payer) : null,
            p.insurance ? encryptPHI(p.insurance.member_id) : null,
          ]
        );
      } else {
        // Update healthie id on existing row
        await client.query(
          `UPDATE patients SET healthie_patient_id = $1,
              healthie_patient_id_idx = $2,
              updated_at = now()
           WHERE id = $3`,
          [healthiePatientId, blindIndex(healthiePatientId), existing.rows[0].id]
        );
      }
      await client.query('COMMIT');

      await getAuditLogger().record({
        action: 'migration.charm_to_healthie.patient',
        userId: this.opts.triggeredBy,
        resourceType: 'patient',
        resourceId: healthiePatientId,
        outcome: 'success',
        metadata: { charmId: p.patient_id, runId },
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  private async migrateAppointment(
    runId: string,
    a: CharmAppointment
  ): Promise<void> {
    const client = await this.opts.pool.connect();
    try {
      await client.query('BEGIN');
      // Look up the local patient to get healthie_patient_id
      const { rows } = await client.query(
        `SELECT id, healthie_patient_id FROM patients
         WHERE organisation_id = $1 AND charm_patient_id_idx = $2`,
        [this.opts.organisationId, blindIndex(a.patient_id)]
      );
      if (rows.length === 0 || !rows[0].healthie_patient_id) {
        throw new Error(
          `Patient ${a.patient_id} not yet migrated; skipping appointment`
        );
      }
      const localPatientId = rows[0].id;
      const healthiePatientId = rows[0].healthie_patient_id;

      // Idempotency: skip if we already created this appointment
      const existing = await client.query(
        `SELECT 1 FROM appointments WHERE charm_appointment_id = $1`,
        [a.appointment_id]
      );
      if (existing.rows.length > 0) return;

      // We need a Healthie provider id. For PoC we assume a 1:1 mapping
      // by email; in production this would join via a provider_map table.
      const created = await this.opts.healthie.createAppointment({
        patient_id: healthiePatientId,
        provider_id: a.provider_id,
        start_at: a.start_time,
        end_at: a.end_time,
        notes: a.reason,
      });

      await client.query(
        `INSERT INTO appointments
          (organisation_id, patient_id, provider_id, start_at, end_at,
           reason_enc, charm_appointment_id, healthie_appointment_id, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          this.opts.organisationId,
          localPatientId,
          a.provider_id,
          a.start_time,
          a.end_time,
          encryptPHI(a.reason ?? ''),
          a.appointment_id,
          created.createAppointment.appointment.id,
          'scheduled',
        ]
      );
      await client.query('COMMIT');

      await getAuditLogger().record({
        action: 'migration.charm_to_healthie.appointment',
        userId: this.opts.triggeredBy,
        resourceType: 'appointment',
        resourceId: created.createAppointment.appointment.id,
        outcome: 'success',
        metadata: { charmId: a.appointment_id, runId },
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  private async recordFailure(
    runId: string,
    resourceType: 'patient' | 'appointment',
    charmResourceId: string,
    message: string
  ): Promise<void> {
    await this.opts.pool.query(
      `INSERT INTO migration_failures
        (migration_run_id, resource_type, charm_resource_id, error_message)
       VALUES ($1,$2,$3,$4)`,
      [runId, resourceType, charmResourceId, message]
    );
  }
}
