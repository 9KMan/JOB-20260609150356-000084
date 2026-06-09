# NRG Clinic — Healthcare Integration & Automation

Production-grade integration platform for **NRG Clinic** covering:

- **EHR migration** — Charm Health (legacy) → Healthie (target), idempotent, audited
- **GraphQL API** — Apollo Server at `/graphql` over PostgreSQL
- **HIPAA-compliant automation** — AES-256-GCM PHI encryption, HMAC blind indexes for
  searchable encrypted fields, append-only audit log, JWT (HS256) auth, role-based access
- **Telehealth** — Doxy.me / Zoom plug-in, single-use session URLs
- **E-prescribing** — DoseSpot integration, encrypted prescription storage
- **Lab integrations** — LabCorp order + result webhook + poller
- **Billing** — Stripe PaymentIntents with idempotency keys
- **CRM** — Zoho CRM contact upsert and notes
- **Workflow automation** — n8n and Keragon workflow JSON (3 + 2 included)

## Stack

| Layer | Choice |
| --- | --- |
| Language | TypeScript (Node 20) |
| Web framework | Express + Apollo Server v4 |
| Database | PostgreSQL 16 (UUIDs, RLS-ready, encrypted PHI columns) |
| ORM | `pg` driver with hand-written SQL migrations |
| Queue | Redis (BullMQ-ready) |
| Auth | JWT (HS256), bcrypt |
| Containers | Docker / docker-compose |

## Project layout

```
src/
  api/             Express app (REST surface for webhooks, health)
  auth/            JWT + bcrypt + role middleware
  config/          Env-driven config (typed, validated)
  db/              Pool, audit log, migrations runner
  graphql/
    schema/        SDL type definitions
    resolvers/     Resolvers wired to services
  integrations/
    charm/         Charm Health REST client (source EHR)
    healthie/      Healthie GraphQL client (target EHR)
    dosespot/      e-Prescribing client
    labcorp/       Lab order/result client
    stripe/        Payment + webhook client
    zoho/          CRM client
  services/
    automation/    n8n / Keragon dispatch
    billing/       Charge orchestration
    crm/           Patient→contact sync
    labs/          Order + result ingestion
    migration/     Charm→Healthie orchestrator
    prescriptions/ e-Rx orchestration
    telehealth/    Session creation
  workers/         Background scheduler
  utils/           Logger, PHI encryption, blind index
migrations/        Numbered SQL files (run via npm run migrate)
workflows/         n8n + Keragon workflow JSON
tests/             Jest unit + integration
```

## Quickstart (docker-compose)

```bash
cp .env.example .env          # fill in API keys
docker compose up -d          # postgres, redis, api, worker, n8n
docker compose exec api node dist/scripts/run-migrations.js
```

The API listens on `:4000` (Apollo at `/graphql`, REST health at `/healthz`).
The n8n UI is on `:5678` (`admin` / your `N8N_BASIC_AUTH_PASSWORD`).

## Local dev (no Docker)

```bash
npm install
cp .env.example .env          # fill in API keys, point DATABASE_URL at local PG
npm run migrate               # apply SQL migrations
npm run dev                   # ts-node-dev with hot reload
npm test                      # unit tests (Jest)
npm run build && npm start    # production
```

## Security & HIPAA posture

This codebase is built to be HIPAA-friendly out of the box. What it gives you:

- **PHI encryption at rest** — every demographic, identifier, and free-text clinical
  field is stored as `aes-256-gcm(plaintext)` using a key in `PHI_ENCRYPTION_KEY`.
  Tampering with a single byte fails the GCM auth tag and decrypts to `null`.
- **Searchable encrypted fields** — `mrn`, `charm_patient_id`, `healthie_patient_id`
  each have a companion `_idx` column populated with an HMAC-SHA256 blind index.
  This lets us equality-search on encrypted fields without revealing the
  plaintext to the database engine.
- **Append-only audit log** — every PHI access, integration call, auth event,
  migration step, and admin action is recorded in `audit_log`. The application
  never updates or deletes audit rows; retention is 7 years (configurable).
- **Role-based access control** — six roles (provider, front_desk, biller,
  admin, patient, integration) with a small hierarchy enforced in the GraphQL
  resolvers and REST middleware.
- **Secrets** — read from env, never logged. Pino redaction paths cover auth
  headers, password/secret/token fields, and PHI keys.
- **TLS** — Postgres connection string is expected to use `?sslmode=require`
  in production; the pool enables `rejectUnauthorized: true` when
  `NODE_ENV=production`.
- **No PHI in URLs** — all identifiers are opaque UUIDs. External vendor IDs
  (Charm, Healthie, Stripe, LabCorp) are stored encrypted with companion blind
  indexes.

What you must still do for full HIPAA compliance:

- Sign a **BAA** with every third-party (Stripe, LabCorp, DoseSpot, Doxy, n8n,
  Zoho, AWS/GCP) before going live.
- Operate inside a **VPC** with private subnets; terminate TLS at the edge.
- Enforce **least-privilege IAM** for AWS/GCP; encrypt EBS/disks.
- Enable **CloudTrail / Cloud Audit Logs** + ship audit_log to immutable storage.
- Run periodic **vulnerability scans** and **pen tests**; rotate `JWT_SECRET`
  and `PHI_ENCRYPTION_KEY` quarterly.
- Establish a **breach notification process** and document it.

## Architecture

```
                  ┌────────────────────────────────────────┐
                  │  NRG Clinic integration service (Node) │
                  │  Apollo GraphQL  +  Express REST       │
                  └────────────────────────────────────────┘
                          │          │           │
                  encrypts │          │ audits    │ dispatches
                          ▼          ▼           ▼
        ┌──────────┐  ┌──────────┐ ┌────────┐  ┌──────────┐
        │ Postgres │  │  Redis   │ │  n8n   │  │ Keragon  │
        │  (PHI)   │  │  (queue) │ │workflow│  │workflows │
        └──────────┘  └──────────┘ └────────┘  └──────────┘
                                                ▲
                                                │  fires
        ┌──────────┐  ┌──────────┐ ┌────────┐  │   ┌──────────┐
        │  Charm   │  │ Healthie │ │DoseSpot│  │   │ LabCorp  │
        │  (read)  │  │  (write) │ │ (eRx)  │  │   │ (orders) │
        └──────────┘  └──────────┘ └────────┘      └──────────┘
                                                       ▲
                                                       │  webhook
                                                  /webhooks/labcorp
```

## Integrations

| Vendor | Role | Files |
| --- | --- | --- |
| **Charm Health** | Legacy EHR (read-only) | `src/integrations/charm/client.ts` |
| **Healthie** | Target EHR (read/write via GraphQL) | `src/integrations/healthie/client.ts` |
| **DoseSpot** | E-prescribing | `src/integrations/dosespot/client.ts` |
| **LabCorp** | Lab orders + results | `src/integrations/labcorp/client.ts` |
| **Stripe** | Payments + webhooks | `src/integrations/stripe/client.ts` |
| **Zoho CRM** | Patient/lead sync | `src/integrations/zoho/client.ts` |
| **n8n** | Internal workflow automation | `workflows/n8n/*.json` |
| **Keragon** | HIPAA-compliant external automation | `workflows/keragon/*.json` |

## API surface

- **GraphQL** — `POST /graphql` (introspection disabled in production)
  - Queries: `me`, `patient`, `patients`, `appointment`, `appointments`,
    `prescriptions`, `labOrders`, `migrationRun`
  - Mutations: `prescribe`, `orderLabTest`, `chargePatient`,
    `createTelehealthSession`, `runCharmToHealthieMigration`, `syncPatientToCrm`
- **REST**
  - `GET  /healthz` — health probe
  - `POST /webhooks/stripe` — Stripe events (signature verified)
  - `POST /webhooks/labcorp` — LabCorp result ingestion (shared secret)
  - `POST /api/v1/graphql-info` — REST auth-protected hello world

## Workflows

- `workflows/n8n/patient-intake.json` — new patient → Zoho contact
- `workflows/n8n/lab-result-routing.json` — abnormal lab → Slack alert
- `workflows/n8n/prescription-refill-reminder.json` — refill candidates → notifications
- `workflows/keragon/charm-to-healthie-migration.json` — daily delta sync
- `workflows/keragon/billing-reconciliation.json` — nightly Stripe reconcile

## Tests

```bash
npm test               # full suite
npm run test:unit      # unit only
npm run test:integration
```

Unit coverage:
- PHI encryption (round-trip, tamper detection, blind index)
- JWT auth (sign/verify/tamper)
- Healthie GraphQL client (auth header, errors)
- Charm REST client (URL building, error handling)
- DoseSpot (session caching, bearer auth)
- LabCorp (OAuth caching, request shape)
- Stripe (idempotency, receipt URL mapping, webhook verify)
- Zoho (token refresh, contact upsert)
- Automation dispatcher (n8n + Keragon POSTs, error mapping)

## Data model highlights

- `organisations`, `users`, `patients`, `appointments`, `prescriptions`,
  `lab_orders`, `lab_results`, `payments`, `audit_log`, `migration_runs`,
  `migration_failures`
- All tables use UUIDs, `created_at` / `updated_at`, soft-delete (`deleted_at`)
- All clinical PHI columns are suffixed `_enc` and stored as the v1 envelope
- Blind-index columns are suffixed `_idx`
- `audit_log` has no `updated_at` trigger and no `UPDATE`/`DELETE` SQL path
  in the codebase — append-only by construction

## License

Proprietary. (c) NRG Clinic.
