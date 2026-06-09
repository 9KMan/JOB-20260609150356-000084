import { Pool, PoolConfig } from 'pg';
import { config } from '../config';
import { logger } from '../utils/logger';

let pool: Pool | null = null;

export function getPool(): Pool {
  if (pool) return pool;
  const poolConfig: PoolConfig = {
    connectionString: config.db.url,
    min: config.db.poolMin,
    max: config.db.poolMax,
    // HIPAA: TLS to the database. Production must provide a CA bundle.
    ssl: config.env === 'production' ? { rejectUnauthorized: true } : false,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  };
  pool = new Pool(poolConfig);
  pool.on('error', (err) => {
    logger.error({ err }, 'pg pool error');
  });
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
