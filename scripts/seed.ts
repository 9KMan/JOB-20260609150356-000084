/* eslint-disable no-console */
/**
 * Seed script — creates the NRG Clinic organisation, a default
 * provider and front-desk user, plus a couple of sample patients
 * (PHI is encrypted, of course).
 */
import * as bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { getPool, closePool } from '../src/db/pool';
import { encryptPHI, blindIndex } from '../src/utils/encryption';
import { config } from '../src/config';
import { logger } from '../src/utils/logger';

async function main(): Promise<void> {
  const pool = getPool();
  const orgId = uuidv4();
  const providerId = uuidv4();
  const frontDeskId = uuidv4();
  const adminId = uuidv4();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO organisations (id, name, slug, npi, timezone)
       VALUES ($1, 'NRG Clinic', 'nrg-clinic', '1234567890', 'America/New_York')`,
      [orgId]
    );

    const pwHash = await bcrypt.hash('dev-password-change-me', config.auth.bcryptRounds);

    await client.query(
      `INSERT INTO users (id, organisation_id, email, password_hash, first_name, last_name, role)
       VALUES ($1,$2,'doc@nrg.test',$3,'Avery','Provider','provider')`,
      [providerId, orgId, pwHash]
    );
    await client.query(
      `INSERT INTO users (id, organisation_id, email, password_hash, first_name, last_name, role)
       VALUES ($1,$2,'front@nrg.test',$3,'Pat','FrontDesk','front_desk')`,
      [frontDeskId, orgId, pwHash]
    );
    await client.query(
      `INSERT INTO users (id, organisation_id, email, password_hash, first_name, last_name, role)
       VALUES ($1,$2,'admin@nrg.test',$3,'Ada','Admin','admin')`,
      [adminId, orgId, pwHash]
    );

    const samples = [
      { mrn: 'NRG-1001', first: 'Jane', last: 'Doe', dob: '1985-04-12', email: 'jane@example.test' },
      { mrn: 'NRG-1002', first: 'John', last: 'Smith', dob: '1972-09-30', email: 'john@example.test' },
    ];

    for (const s of samples) {
      await client.query(
        `INSERT INTO patients
          (organisation_id, mrn, mrn_idx, first_name_enc, last_name_enc,
           dob_enc, email_enc, status, primary_provider_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8)`,
        [
          orgId,
          s.mrn,
          blindIndex(s.mrn),
          encryptPHI(s.first),
          encryptPHI(s.last),
          encryptPHI(s.dob),
          encryptPHI(s.email),
          providerId,
        ]
      );
    }

    await client.query('COMMIT');
    logger.info({ orgId, providerId, adminId }, 'seed complete');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  await closePool();
}

if (require.main === module) {
  main().catch((err) => {
    logger.error({ err }, 'seed failed');
    process.exit(1);
  });
}
