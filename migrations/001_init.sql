-- =============================================================
-- 001 — initial schema: organisations, users, patients
-- HIPAA-friendly: UUIDs, audit columns, soft delete, PHI columns
-- identified by their _enc suffix; we use a blind-index column
-- (_idx) for searchable encrypted fields like MRN.
-- =============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- -------------------------------------------------------------
-- Enums
-- -------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE user_role AS ENUM (
    'provider', 'front_desk', 'biller', 'admin', 'patient', 'integration'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE patient_status AS ENUM (
    'active', 'inactive', 'archived', 'deceased'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- -------------------------------------------------------------
-- organisations (single-tenant NRG Clinic; the schema supports
-- multi-org via organisation_id FKs for future expansion)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS organisations (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  name         text NOT NULL,
  slug         text NOT NULL UNIQUE,
  npi          text,                       -- National Provider Identifier
  timezone     text NOT NULL DEFAULT 'America/New_York',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);

-- -------------------------------------------------------------
-- users (staff + patients) — credentials and identity
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  email           text NOT NULL,
  password_hash   text,                         -- null for SSO-only accounts
  first_name      text,
  last_name       text,
  role            user_role NOT NULL,
  is_active       boolean NOT NULL DEFAULT true,
  last_login_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  UNIQUE (organisation_id, email)
);

CREATE INDEX IF NOT EXISTS idx_users_org     ON users (organisation_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_users_email   ON users (lower(email)) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_users_role    ON users (organisation_id, role) WHERE deleted_at IS NULL;

-- -------------------------------------------------------------
-- patients — clinical record holder. PHI columns are encrypted;
-- we also keep a blind index on mrn for search.
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS patients (
  id                   uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organisation_id      uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  -- External identifiers (encrypted)
  charm_patient_id     text,
  charm_patient_id_idx text,                       -- blind index of charm_patient_id
  healthie_patient_id  text,
  healthie_patient_id_idx text,
  -- Demographics (encrypted)
  mrn                  text UNIQUE,
  mrn_idx              text UNIQUE,                -- blind index
  first_name_enc       text,
  last_name_enc        text,
  dob_enc              text,                       -- date of birth
  ssn_last4_enc        text,
  email_enc            text,
  phone_enc            text,
  address_enc          text,
  -- Insurance
  insurance_payer_enc  text,
  insurance_member_id_enc text,
  -- Status
  status               patient_status NOT NULL DEFAULT 'active',
  primary_provider_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz,
  CHECK (mrn IS NULL OR mrn_idx IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_patients_org            ON patients (organisation_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_patients_status         ON patients (organisation_id, status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_patients_charm          ON patients (charm_patient_id_idx) WHERE charm_patient_id_idx IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_patients_healthie       ON patients (healthie_patient_id_idx) WHERE healthie_patient_id_idx IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_patients_primary_prov   ON patients (primary_provider_id) WHERE deleted_at IS NULL;

-- -------------------------------------------------------------
-- appointments — schedule; used by migration + telehealth
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS appointments (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organisation_id     uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  patient_id          uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  provider_id         uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  start_at            timestamptz NOT NULL,
  end_at              timestamptz NOT NULL,
  reason_enc          text,                          -- encrypted free text
  telehealth_url      text,
  charm_appointment_id text,
  healthie_appointment_id text,
  status              text NOT NULL DEFAULT 'scheduled',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,
  CHECK (end_at > start_at)
);

CREATE INDEX IF NOT EXISTS idx_appts_org_patient ON appointments (organisation_id, patient_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_appts_provider    ON appointments (provider_id, start_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_appts_start       ON appointments (start_at) WHERE deleted_at IS NULL;

-- -------------------------------------------------------------
-- updated_at trigger
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY['organisations','users','patients','appointments']) LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_%I_updated_at ON %I; '
      'CREATE TRIGGER trg_%I_updated_at BEFORE UPDATE ON %I '
      'FOR EACH ROW EXECUTE FUNCTION set_updated_at();',
      t, t, t, t
    );
  END LOOP;
END $$;
