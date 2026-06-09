/**
 * GraphQL schema — built with the schema-first approach using
 * `graphql-tag`. Exposed via Apollo Server mounted at /graphql.
 *
 * The schema intentionally exposes the data our clinicians and
 * integration consumers need; PHI is returned only behind
 * authentication, and the resolvers enforce row-level access via
 * the auth context.
 */
import gql from 'graphql-tag';

export const typeDefs = gql`
  scalar DateTime
  scalar JSON

  enum UserRole {
    provider
    front_desk
    biller
    admin
    patient
    integration
  }

  enum PatientStatus {
    active
    inactive
    archived
    deceased
  }

  enum PrescriptionStatus {
    draft
    pending
    sent
    filled
    cancelled
    error
  }

  enum LabOrderStatus {
    ordered
    collected
    in_transit
    resulted
    cancelled
    corrected
  }

  enum MigrationStatus {
    pending
    running
    completed
    failed
    partial
  }

  type Patient {
    id: ID!
    mrn: String
    firstName: String
    lastName: String
    status: PatientStatus!
    healthiePatientId: String
    charmPatientId: String
  }

  type Appointment {
    id: ID!
    patient: Patient!
    providerId: ID!
    startAt: DateTime!
    endAt: DateTime!
    status: String!
    telehealthUrl: String
  }

  type Prescription {
    id: ID!
    patientId: ID!
    providerId: ID!
    status: PrescriptionStatus!
    drugName: String
    dose: String
    frequency: String
    refills: Int!
    dosespotPrescriptionId: String
    prescribedAt: DateTime
  }

  type LabOrder {
    id: ID!
    patientId: ID!
    providerId: ID!
    labcorpOrderId: String
    testCode: String!
    testName: String
    status: LabOrderStatus!
    orderedAt: DateTime!
    resultedAt: DateTime
  }

  type MigrationRun {
    id: ID!
    status: MigrationStatus!
    patientsTotal: Int!
    patientsMigrated: Int!
    patientsFailed: Int!
    appointmentsTotal: Int!
    appointmentsMigrated: Int!
    appointmentsFailed: Int!
    startedAt: DateTime!
    finishedAt: DateTime
  }

  type TelehealthSession {
    sessionId: String!
    url: String!
  }

  type Payment {
    id: ID!
    status: String!
    amountCents: Int!
    currency: String!
    receiptUrl: String
  }

  type Query {
    me: JSON
    patient(id: ID!): Patient
    patients(status: PatientStatus, limit: Int = 50, offset: Int = 0): [Patient!]!
    appointment(id: ID!): Appointment
    appointments(patientId: ID, from: DateTime, to: DateTime): [Appointment!]!
    prescriptions(patientId: ID, limit: Int = 50): [Prescription!]!
    labOrders(patientId: ID, status: LabOrderStatus): [LabOrder!]!
    migrationRun(id: ID!): MigrationRun
  }

  input PrescribeDrugInput {
    name: String!
    ndc: String
    dose: String!
    route: String!
    frequency: String!
    durationDays: Int!
    refills: Int!
    genericAllowed: Boolean!
  }

  input PharmacyInput {
    ncpdpId: String!
  }

  input OrderLabTestInput {
    loinc: String!
    code: String!
    name: String!
  }

  type Mutation {
    prescribe(
      patientId: ID!
      drug: PrescribeDrugInput!
      pharmacy: PharmacyInput!
      notes: String
    ): Prescription!
    orderLabTest(
      patientId: ID!
      test: OrderLabTestInput!
      priority: String!
    ): LabOrder!
    chargePatient(
      patientId: ID!
      amountCents: Int!
      currency: String!
      description: String!
    ): Payment!
    createTelehealthSession(
      appointmentId: ID!
      provider: String!
    ): TelehealthSession!
    runCharmToHealthieMigration: MigrationRun!
    syncPatientToCrm(patientId: ID!): JSON!
  }
`;
