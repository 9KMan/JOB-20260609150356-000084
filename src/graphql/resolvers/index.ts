/**
 * GraphQL resolvers — thin layer over the service modules.
 * Every resolver checks `ctx.auth` for the required role.
 */
import { Pool } from 'pg';
import { decryptPHI } from '../../utils/encryption';
import { PrescriptionsService } from '../../services/prescriptions/prescriptionsService';
import { LabsService } from '../../services/labs/labsService';
import { BillingService } from '../../services/billing/billingService';
import { TelehealthService } from '../../services/telehealth/telehealthService';
import { CrmSyncService } from '../../services/crm/crmSyncService';
import { CharmToHealthieMigration } from '../../services/migration/charmToHealthie';
import { CharmClient } from '../../integrations/charm/client';
import { HealthieClient } from '../../integrations/healthie/client';
import { DoseSpotClient } from '../../integrations/dosespot/client';
import { LabCorpClient } from '../../integrations/labcorp/client';
import { StripeClient } from '../../integrations/stripe/client';
import { ZohoClient } from '../../integrations/zoho/client';
import { getAuditLogger } from '../../db/audit';
import { AuthTokenPayload } from '../../auth/jwt';
import { logger } from '../../utils/logger';

export interface GraphQLContext {
  pool: Pool;
  auth?: AuthTokenPayload;
  services: {
    prescriptions: PrescriptionsService;
    labs: LabsService;
    billing: BillingService;
    telehealth: TelehealthService;
    crm: CrmSyncService;
    migration: { run: (orgId: string, userId: string) => Promise<unknown> };
  };
}

function requireAuth(ctx: GraphQLContext): AuthTokenPayload {
  if (!ctx.auth) throw new Error('unauthorized');
  return ctx.auth;
}

export const resolvers = {
  Query: {
    me: (_p: unknown, _a: unknown, ctx: GraphQLContext) => {
      const a = requireAuth(ctx);
      return {
        id: a.sub,
        email: a.email,
        role: a.role,
        organisationId: a.orgId,
        sessionId: a.sessionId,
      };
    },
    patient: async (
      _p: unknown,
      { id }: { id: string },
      ctx: GraphQLContext
    ) => {
      const a = requireAuth(ctx);
      const { rows } = await ctx.pool.query(
        `SELECT id, mrn, status, healthie_patient_id, charm_patient_id,
                first_name_enc, last_name_enc
         FROM patients WHERE id = $1 AND organisation_id = $2 AND deleted_at IS NULL`,
        [id, a.orgId]
      );
      if (rows.length === 0) return null;
      const r = rows[0];
      await getAuditLogger().record({
        action: 'phi.read',
        userId: a.sub,
        resourceType: 'patient',
        resourceId: id,
        outcome: 'success',
      });
      return {
        id: r.id,
        mrn: r.mrn,
        firstName: decryptPHI(r.first_name_enc),
        lastName: decryptPHI(r.last_name_enc),
        status: r.status,
        healthiePatientId: r.healthie_patient_id,
        charmPatientId: r.charm_patient_id,
      };
    },
    patients: async (
      _p: unknown,
      { status, limit, offset }: { status?: string; limit: number; offset: number },
      ctx: GraphQLContext
    ) => {
      const a = requireAuth(ctx);
      const params: unknown[] = [a.orgId];
      let where = 'organisation_id = $1 AND deleted_at IS NULL';
      if (status) {
        params.push(status);
        where += ` AND status = $${params.length}`;
      }
      params.push(limit, offset);
      const { rows } = await ctx.pool.query(
        `SELECT id, mrn, status, healthie_patient_id, charm_patient_id
         FROM patients WHERE ${where}
         ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      );
      return rows.map((r) => ({
        id: r.id,
        mrn: r.mrn,
        status: r.status,
        healthiePatientId: r.healthie_patient_id,
        charmPatientId: r.charm_patient_id,
      }));
    },
    appointments: async (
      _p: unknown,
      args: { patientId?: string; from?: string; to?: string },
      ctx: GraphQLContext
    ) => {
      const a = requireAuth(ctx);
      const params: unknown[] = [a.orgId];
      let where = 'organisation_id = $1 AND deleted_at IS NULL';
      if (args.patientId) {
        params.push(args.patientId);
        where += ` AND patient_id = $${params.length}`;
      }
      if (args.from) {
        params.push(args.from);
        where += ` AND start_at >= $${params.length}`;
      }
      if (args.to) {
        params.push(args.to);
        where += ` AND end_at <= $${params.length}`;
      }
      const { rows } = await ctx.pool.query(
        `SELECT id, patient_id, provider_id, start_at, end_at, status, telehealth_url
         FROM appointments WHERE ${where} ORDER BY start_at DESC LIMIT 200`,
        params
      );
      return rows.map((r) => ({
        id: r.id,
        patientId: r.patient_id,
        providerId: r.provider_id,
        startAt: r.start_at,
        endAt: r.end_at,
        status: r.status,
        telehealthUrl: r.telehealth_url,
      }));
    },
    prescriptions: async (
      _p: unknown,
      { patientId, limit }: { patientId?: string; limit: number },
      ctx: GraphQLContext
    ) => {
      const a = requireAuth(ctx);
      const params: unknown[] = [a.orgId];
      let where = 'organisation_id = $1 AND deleted_at IS NULL';
      if (patientId) {
        params.push(patientId);
        where += ` AND patient_id = $${params.length}`;
      }
      params.push(limit);
      const { rows } = await ctx.pool.query(
        `SELECT id, patient_id, provider_id, status, drug_name_enc, dose_enc,
                frequency_enc, refills, dosespot_prescription_id, prescribed_at
         FROM prescriptions WHERE ${where}
         ORDER BY created_at DESC LIMIT $${params.length}`,
        params
      );
      return rows.map((r) => ({
        id: r.id,
        patientId: r.patient_id,
        providerId: r.provider_id,
        status: r.status,
        drugName: decryptPHI(r.drug_name_enc),
        dose: decryptPHI(r.dose_enc),
        frequency: decryptPHI(r.frequency_enc),
        refills: r.refills,
        dosespotPrescriptionId: r.dosespot_prescription_id,
        prescribedAt: r.prescribed_at,
      }));
    },
    labOrders: async (
      _p: unknown,
      { patientId, status }: { patientId?: string; status?: string },
      ctx: GraphQLContext
    ) => {
      const a = requireAuth(ctx);
      const params: unknown[] = [a.orgId];
      let where = 'organisation_id = $1 AND deleted_at IS NULL';
      if (patientId) {
        params.push(patientId);
        where += ` AND patient_id = $${params.length}`;
      }
      if (status) {
        params.push(status);
        where += ` AND status = $${params.length}`;
      }
      const { rows } = await ctx.pool.query(
        `SELECT id, patient_id, provider_id, labcorp_order_id, test_code,
                test_name_enc, status, ordered_at, resulted_at
         FROM lab_orders WHERE ${where} ORDER BY ordered_at DESC LIMIT 200`,
        params
      );
      return rows.map((r) => ({
        id: r.id,
        patientId: r.patient_id,
        providerId: r.provider_id,
        labcorpOrderId: r.labcorp_order_id,
        testCode: r.test_code,
        testName: decryptPHI(r.test_name_enc),
        status: r.status,
        orderedAt: r.ordered_at,
        resultedAt: r.resulted_at,
      }));
    },
    migrationRun: async (
      _p: unknown,
      { id }: { id: string },
      ctx: GraphQLContext
    ) => {
      const a = requireAuth(ctx);
      const { rows } = await ctx.pool.query(
        `SELECT id, status, patients_total, patients_migrated, patients_failed,
                appointments_total, appointments_migrated, appointments_failed,
                started_at, finished_at
         FROM migration_runs WHERE id = $1 AND organisation_id = $2`,
        [id, a.orgId]
      );
      if (rows.length === 0) return null;
      const r = rows[0];
      return {
        id: r.id,
        status: r.status,
        patientsTotal: r.patients_total,
        patientsMigrated: r.patients_migrated,
        patientsFailed: r.patients_failed,
        appointmentsTotal: r.appointments_total,
        appointmentsMigrated: r.appointments_migrated,
        appointmentsFailed: r.appointments_failed,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
      };
    },
    appointment: async (
      _p: unknown,
      { id }: { id: string },
      ctx: GraphQLContext
    ) => {
      const a = requireAuth(ctx);
      const { rows } = await ctx.pool.query(
        `SELECT id, patient_id, provider_id, start_at, end_at, status, telehealth_url
         FROM appointments WHERE id = $1 AND organisation_id = $2`,
        [id, a.orgId]
      );
      if (rows.length === 0) return null;
      const r = rows[0];
      return {
        id: r.id,
        patientId: r.patient_id,
        providerId: r.provider_id,
        startAt: r.start_at,
        endAt: r.end_at,
        status: r.status,
        telehealthUrl: r.telehealth_url,
      };
    },
  },

  Appointment: {
    patient: async (parent: { patientId: string }, _a: unknown, ctx: GraphQLContext) => {
      const a = requireAuth(ctx);
      const { rows } = await ctx.pool.query(
        `SELECT id, mrn, status FROM patients WHERE id = $1 AND organisation_id = $2`,
        [parent.patientId, a.orgId]
      );
      return rows[0] ?? null;
    },
  },

  Mutation: {
    prescribe: async (
      _p: unknown,
      args: {
        patientId: string;
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
      },
      ctx: GraphQLContext
    ) => {
      const a = requireAuth(ctx);
      if (!['provider', 'admin'].includes(a.role)) throw new Error('forbidden');
      const r = await ctx.services.prescriptions.prescribe({
        organisationId: a.orgId,
        patientId: args.patientId,
        providerId: a.sub,
        drug: args.drug,
        pharmacy: args.pharmacy,
        notes: args.notes,
      });
      return { id: r.id, status: r.status };
    },
    orderLabTest: async (
      _p: unknown,
      args: { patientId: string; test: { loinc: string; code: string; name: string }; priority: string },
      ctx: GraphQLContext
    ) => {
      const a = requireAuth(ctx);
      if (!['provider', 'admin'].includes(a.role)) throw new Error('forbidden');
      // Look up patient MRN for the order
      const { rows } = await ctx.pool.query(
        `SELECT mrn, first_name_enc, last_name_enc, dob_enc, primary_provider_id
         FROM patients WHERE id = $1 AND organisation_id = $2`,
        [args.patientId, a.orgId]
      );
      if (rows.length === 0) throw new Error('patient not found');
      const p = rows[0];
      const r = await ctx.services.labs.orderTest({
        organisationId: a.orgId,
        patientId: args.patientId,
        providerId: a.sub,
        patient: {
          firstName: decryptPHI(p.first_name_enc) ?? '',
          lastName: decryptPHI(p.last_name_enc) ?? '',
          dob: decryptPHI(p.dob_enc) ?? '',
          mrn: p.mrn,
          gender: 'U',
        },
        provider: { npi: process.env.NPI_DEFAULT ?? '0000000000' },
        test: args.test,
        priority: args.priority as 'routine' | 'urgent' | 'stat',
      });
      return { id: r.id, status: r.status };
    },
    chargePatient: async (
      _p: unknown,
      args: { patientId: string; amountCents: number; currency: string; description: string },
      ctx: GraphQLContext
    ) => {
      const a = requireAuth(ctx);
      if (!['biller', 'admin'].includes(a.role)) throw new Error('forbidden');
      const r = await ctx.services.billing.chargePatient({
        organisationId: a.orgId,
        patientId: args.patientId,
        amountCents: args.amountCents,
        currency: args.currency,
        description: args.description,
      });
      return { id: r.id, status: r.status, amountCents: args.amountCents, currency: args.currency };
    },
    createTelehealthSession: async (
      _p: unknown,
      args: { appointmentId: string; provider: string },
      ctx: GraphQLContext
    ) => {
      const a = requireAuth(ctx);
      const { rows } = await ctx.pool.query(
        `SELECT patient_id, provider_id FROM appointments WHERE id = $1 AND organisation_id = $2`,
        [args.appointmentId, a.orgId]
      );
      if (rows.length === 0) throw new Error('appointment not found');
      return ctx.services.telehealth.createSession({
        organisationId: a.orgId,
        appointmentId: args.appointmentId,
        patientId: rows[0].patient_id,
        providerId: rows[0].provider_id,
        provider: args.provider as 'doxy' | 'zoom' | 'custom',
      });
    },
    runCharmToHealthieMigration: async (
      _p: unknown,
      _a: unknown,
      ctx: GraphQLContext
    ) => {
      const a = requireAuth(ctx);
      if (a.role !== 'admin') throw new Error('forbidden');
      const result = (await ctx.services.migration.run(a.orgId, a.sub)) as {
        runId: string;
        patientsTotal: number;
        patientsMigrated: number;
        patientsFailed: number;
        appointmentsTotal: number;
        appointmentsMigrated: number;
        appointmentsFailed: number;
      };
      return {
        id: result.runId,
        status: result.patientsFailed > 0 ? 'partial' : 'completed',
        patientsTotal: result.patientsTotal,
        patientsMigrated: result.patientsMigrated,
        patientsFailed: result.patientsFailed,
        appointmentsTotal: result.appointmentsTotal,
        appointmentsMigrated: result.appointmentsMigrated,
        appointmentsFailed: result.appointmentsFailed,
        startedAt: new Date(),
        finishedAt: new Date(),
      };
    },
    syncPatientToCrm: async (
      _p: unknown,
      { patientId }: { patientId: string },
      ctx: GraphQLContext
    ) => {
      const a = requireAuth(ctx);
      const { rows } = await ctx.pool.query(
        `SELECT id, mrn, first_name_enc, last_name_enc, email_enc, phone_enc
         FROM patients WHERE id = $1 AND organisation_id = $2`,
        [patientId, a.orgId]
      );
      if (rows.length === 0) throw new Error('patient not found');
      const p = rows[0];
      return ctx.services.crm.syncPatient({
        patientId: p.id,
        firstName: decryptPHI(p.first_name_enc) ?? '',
        lastName: decryptPHI(p.last_name_enc) ?? '',
        email: decryptPHI(p.email_enc) ?? '',
        phone: decryptPHI(p.phone_enc) ?? undefined,
        leadSource: 'nrg-clinic',
      });
    },
  },
};

export function buildContext(pool: Pool, auth?: AuthTokenPayload): GraphQLContext {
  const charm = new CharmClient();
  const healthie = new HealthieClient();
  const dosespot = new DoseSpotClient();
  const labcorp = new LabCorpClient();
  const stripe = new StripeClient();
  const zoho = new ZohoClient();
  return {
    pool,
    auth,
    services: {
      prescriptions: new PrescriptionsService(pool, dosespot),
      labs: new LabsService(pool, labcorp),
      billing: new BillingService(pool, stripe),
      telehealth: new TelehealthService(pool),
      crm: new CrmSyncService(zoho),
      migration: {
        run: async (orgId: string, userId: string) => {
          const m = new CharmToHealthieMigration({
            organisationId: orgId,
            triggeredBy: userId,
            charm,
            healthie,
            pool,
          });
          return m.run();
        },
      },
    },
  };
}
