// Test setup — runs before every test file. Loads .env.test if it
// exists, otherwise falls back to a minimal in-memory configuration.
import * as dotenv from 'dotenv';
import * as path from 'path';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'silent';
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-secret-32-bytes-min-len';
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://test:test@localhost:5432/test';

const envTest = path.resolve(process.cwd(), '.env.test');
dotenv.config({ path: envTest, override: false });
