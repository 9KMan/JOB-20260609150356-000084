-- =============================================================
-- 002 — prescriptions (DoseSpot), lab orders/results (LabCorp),
-- payments (Stripe), audit log
-- =============================================================

-- -------------------------------------------------------------
-- prescriptions (e-prescribing)
-- -------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE prescription_status AS ENUM (
    'draft', 'pending', 'sent', 'filled', 'cancelled', 'error'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS prescriptions (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organisation_id     uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  patient_id          uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  provider_id         uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  dosespot_prescription_id text,
  drug_name_enc       text,
  dose_enc            text,
  frequency_enc       text,
  duration_days       integer,
  refills             integer NOT NULL DEFAULT 0,
  status              prescription_status NOT NULL DEFAULT 'draft',
  pharmacy_ncpdp_id   text,
  notes_enc           text,
  prescribed_at       timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz
);

CREATE INDEX IF NOT EXISTS idx_rx_org_patient ON prescriptions (organisation_id, patient_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_rx_provider    ON prescriptions (provider_id, prescribed_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_rx_dosespot    ON prescriptions (dosespot_prescription_id) WHERE dosespot_prescription_id IS NOT NULL;

-- -------------------------------------------------------------
-- lab_orders + lab_results (LabCorp)
-- -------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE lab_order_status AS ENUM (
    'ordered', 'collected', 'in_transit', 'resulted', 'cancelled', 'corrected'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS lab_orders (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organisation_id     uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  patient_id          uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  provider_id         uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  labcorp_order_id    text UNIQUE,
  test_code           text NOT NULL,                    -- LOINC code
  test_name_enc       text,
  status              lab_order_status NOT NULL DEFAULT 'ordered',
  ordered_at          timestamptz NOT NULL DEFAULT now(),
  collected_at        timestamptz,
  resulted_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz
);

CREATE INDEX IF NOT EXISTS idx_lab_orders_patient ON lab_orders (patient_id, ordered_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_lab_orders_status  ON lab_orders (status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_lab_orders_labcorp ON lab_orders (labcorp_order_id) WHERE labcorp_order_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS lab_results (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  lab_order_id        uuid NOT NULL REFERENCES lab_orders(id) ON DELETE CASCADE,
  test_code           text NOT NULL,
  test_name_enc       text,
  value_enc           text,
  unit                text,
  reference_range_enc text,
  abnormal_flag       text,                              -- 'L','H','LL','HH','N','A'
  observed_at         timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lab_results_order ON lab_results (lab_order_id, observed_at DESC);

-- -------------------------------------------------------------
-- payments (Stripe)
-- -------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE payment_status AS ENUM (
    'pending', 'succeeded', 'failed', 'refunded', 'partially_refunded'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS payments (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organisation_id     uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  patient_id          uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  stripe_payment_intent_id text UNIQUE,
  stripe_charge_id    text,
  amount_cents        bigint NOT NULL,
  currency            text NOT NULL DEFAULT 'usd',
  status              payment_status NOT NULL DEFAULT 'pending',
  description_enc     text,
  receipt_url         text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payments_patient  ON payments (patient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_stripe   ON payments (stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;

-- -------------------------------------------------------------
-- audit_log — append-only (no updated_at, no UPDATE/DELETE policy)
-- =============================================================
CREATE TABLE IF NOT EXISTS audit_log (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  action          text NOT NULL,
  user_id         uuid,
  resource_type   text,
  resource_id     text,
  outcome         text NOT NULL CHECK (outcome IN ('success','failure')),
  ip_address      inet,
  user_agent      text,
  metadata        jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_action       ON audit_log (action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_user         ON audit_log (user_id, created_at DESC) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_resource     ON audit_log (resource_type, resource_id, created_at DESC) WHERE resource_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_created_at   ON audit_log (created_at DESC);

-- -------------------------------------------------------------
-- migration_runs — record of one full Charm → Healthie migration
-- -------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE migration_status AS ENUM (
    'pending', 'running', 'completed', 'failed', 'partial'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS migration_runs (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organisation_id     uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  triggered_by        uuid REFERENCES users(id),
  status              migration_status NOT NULL DEFAULT 'pending',
  patients_total      integer NOT NULL DEFAULT 0,
  patients_migrated   integer NOT NULL DEFAULT 0,
  patients_failed     integer NOT NULL DEFAULT 0,
  appointments_total  integer NOT NULL DEFAULT 0,
  appointments_migrated integer NOT NULL DEFAULT 0,
  appointments_failed integer NOT NULL DEFAULT 0,
  started_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz,
  error_message       text
);

CREATE INDEX IF NOT EXISTS idx_migration_runs_org ON migration_runs (organisation_id, started_at DESC);

CREATE TABLE IF NOT EXISTS migration_failures (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  migration_run_id    uuid NOT NULL REFERENCES migration_runs(id) ON DELETE CASCADE,
  resource_type       text NOT NULL,                  -- 'patient' | 'appointment'
  charm_resource_id   text NOT NULL,
  error_message       text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_migration_failures_run ON migration_failures (migration_run_id);

-- -------------------------------------------------------------
-- updated_at triggers for new tables
-- -------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY['prescriptions','lab_orders','payments']) LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_%I_updated_at ON %I; '
      'CREATE TRIGGER trg_%I_updated_at BEFORE UPDATE ON %I '
      'FOR EACH ROW EXECUTE FUNCTION set_updated_at();',
      t, t, t, t
    );
  END LOOP;
END $$;
