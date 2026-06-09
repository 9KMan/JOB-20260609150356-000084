/* eslint-disable no-console */
import * as fs from 'fs';
import * as path from 'path';
import { getPool, closePool } from '../src/db/pool';
import { logger } from '../src/utils/logger';

async function main(): Promise<void> {
  const dir = path.resolve(__dirname, '..', '..', 'migrations');
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  for (const file of files) {
    const { rows } = await pool.query(
      'SELECT 1 FROM schema_migrations WHERE filename = $1',
      [file]
    );
    if (rows.length > 0) {
      logger.info({ file }, 'migration already applied, skipping');
      continue;
    }
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    logger.info({ file }, 'applying migration');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (filename) VALUES ($1)',
        [file]
      );
      await client.query('COMMIT');
      logger.info({ file }, 'migration applied');
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error({ err, file }, 'migration failed');
      throw err;
    } finally {
      client.release();
    }
  }
  await closePool();
}

if (require.main === module) {
  main().catch((err) => {
    logger.error({ err }, 'migrations aborted');
    process.exit(1);
  });
}
