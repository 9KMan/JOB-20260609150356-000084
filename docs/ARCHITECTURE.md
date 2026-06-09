# Architecture notes — NRG Clinic Healthcare Integration

## 1. Goals & non-goals

**Goal**: ship a working PoC that demonstrates the integration fabric
required to migrate NRG Clinic from Charm Health to Healthie and run
the practice day-to-day on the new platform.

**Non-goals** (out of PoC scope):
- Production-grade IaC / multi-region deployment
- Full FHIR interop layer (we model the proprietary surface that
  Charm and Healthie document; a future phase could swap to a FHIR
  facade)
- A clinician-facing UI (a thin operator console is included in
  `api/index.html` to demonstrate the GraphQL surface)

## 2. System decomposition

The PoC is one Node.js process that exposes:
- GraphQL at `POST /graphql` (the clinician / integration consumer
  surface)
- REST at `/healthz`, `/webhooks/stripe`, `/webhooks/labcorp`,
  `/api/v1/...` (operations surface)

A second process (`npm run worker` / `dist/src/workers/scheduler.js`)
runs scheduled jobs: daily Charm sync, lab poller, automation
heartbeat. In production these would be separate deployments.

## 3. Data model

11 tables; all UUID PKs; all `created_at` / `updated_at`; soft delete
on most. PHI columns are suffixed `_enc` (the AES-256-GCM envelope)
and paired with an `_idx` column for searchable encrypted lookups.

| Table | Purpose |
| --- | --- |
| `organisations` | Single-tenant for NRG Clinic; multi-org ready. |
| `users` | Staff (provider, front_desk, biller, admin) and patients. |
| `patients` | Master patient record; external IDs encrypted + indexed. |
| `appointments` | Schedule; telehealth URL lives here. |
| `prescriptions` | E-Rx records, mirrored to DoseSpot. |
| `lab_orders` | LabCorp orders. |
| `lab_results` | Per-analyte results. |
| `payments` | Stripe charges. |
| `audit_log` | Append-only audit trail. |
| `migration_runs` | One row per Charm→Healthie run. |
| `migration_failures` | Per-record failure with error. |

## 4. Security model

- **Auth**: JWT HS256, 8h expiry, jti session id. Roles enforced in
  GraphQL resolvers and REST middleware.
- **Encryption**: PHI columns are AES-256-GCM. The `v1:` envelope
  embeds version, IV, auth tag, ciphertext. Tampering fails
  authentication and decrypts to `null`.
- **Searchable encryption**: HMAC-SHA256 blind index on MRN and
  external vendor IDs.
- **Audit**: every PHI access, integration call, migration step is
  written to `audit_log`. The codebase has no UPDATE or DELETE
  statement against `audit_log` — append-only by construction.
- **Logging redaction**: pino redaction paths cover auth headers,
  passwords, secrets, and PHI keys.
- **TLS**: required for Postgres in production; the pool enables
  `rejectUnauthorized: true` when `NODE_ENV=production`.

## 5. Integration boundaries

Each vendor has a dedicated `src/integrations/<vendor>/client.ts`
that:
1. Exposes a typed, hand-written client (no generated code).
2. Manages auth (token caching for OAuth / session for DoseSpot /
   Basic for Charm & Healthie).
3. Translates vendor responses into our domain types.
4. Never throws raw HTTP errors — wraps them with vendor + status
   context.

A service in `src/services/<domain>/` orchestrates the client plus
the database, owns the audit logging, and exposes a domain-specific
API that the GraphQL resolvers consume.

## 6. Migration choreography

The Charm→Healthie migration is the most complex piece. The
`CharmToHealthieMigration` class:
1. Creates a `migration_runs` row.
2. Pages through Charm patients, creating each in Healthie via
   `createPatient` (with `external_id` set to the Charm id).
3. Writes an encrypted local row keyed on a blind index of the
   Charm id, so re-runs find the existing patient instead of
   creating a duplicate.
4. Pages through the last 90 days of appointments, creates them in
   Healthie, and writes a local row with both `charm_appointment_id`
   and `healthie_appointment_id`.
5. Records per-resource failures in `migration_failures` and never
   aborts on a single bad record unless the failure rate crosses
   50% (configurable).

Idempotency: the blind index on `charm_patient_id` is the
deduplication key. Re-running the same migration never creates a
duplicate patient.

## 7. Why TypeScript + Express + Apollo + raw SQL

- TypeScript keeps the data shapes (PHI envelopes, Healthie
  responses, DoseSpot session objects) under compiler control.
- Apollo Server v4 is the most boring, well-supported GraphQL
  server on Node 20.
- Raw SQL with hand-written migrations keeps the schema obvious
  and migration audit-trail complete — no hidden ORM behaviors
  around column types or constraints.

## 8. What's wired up

- All 6 vendor clients: Charm, Healthie, DoseSpot, LabCorp, Stripe, Zoho
- PHI encryption + blind index + audit log
- Migration service: idempotent patient + appointment transfer
- 5 workflows (3 n8n, 2 Keragon)
- REST: health, Stripe webhook, LabCorp webhook
- GraphQL: 8 queries, 6 mutations
- Background worker: scheduled sync + lab poller
- Docker compose: postgres, redis, api, worker, n8n
- Unit tests: encryption, auth, all 6 vendor clients, automation

## 9. Open items for production

- A FHIR facade layer in front of Healthie (defer)
- KMS-managed PHI key with auto-rotation (AWS KMS / GCP KMS)
- WAF + rate limiting at the edge
- BullMQ queue for the background worker (Redis is wired but the
  worker is currently a setInterval — fine for PoC, swap for
  BullMQ in production)
- A clinician-facing React/Vue SPA (the included `api/index.html`
  is a one-page operator console for ops, not a clinical UI)
- Pen test + SOC 2 / HITREST readiness work
