import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

// Only load .env in non-test environments. In tests, .env.test is loaded by tests/setup.ts.
if (process.env.NODE_ENV !== 'test') {
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
  }
}

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function optional(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

function intEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Env ${name} must be an integer`);
  return n;
}

export const config = {
  env: optional('NODE_ENV', 'development'),
  port: intEnv('PORT', 4000),
  logLevel: optional('LOG_LEVEL', 'info'),

  db: {
    url: optional('DATABASE_URL', 'postgres://nrg:dev@localhost:5432/nrg_clinic'),
    poolMin: intEnv('DATABASE_POOL_MIN', 2),
    poolMax: intEnv('DATABASE_POOL_MAX', 10),
  },

  auth: {
    jwtSecret: required('JWT_SECRET', 'dev-only-secret-do-not-use-in-prod-32b'),
    jwtExpiresIn: optional('JWT_EXPIRES_IN', '8h'),
    bcryptRounds: intEnv('BCRYPT_ROUNDS', 12),
  },

  hipaa: {
    phiEncryptionKey: optional('PHI_ENCRYPTION_KEY', ''),
    auditRetentionDays: intEnv('AUDIT_LOG_RETENTION_DAYS', 2555), // 7 years
  },

  charm: {
    baseUrl: optional('CHARM_HEALTH_BASE_URL', 'https://api.charmhealth.com'),
    apiKey: optional('CHARM_HEALTH_API_KEY', ''),
    username: optional('CHARM_HEALTH_USERNAME', ''),
    password: optional('CHARM_HEALTH_PASSWORD', ''),
  },

  healthie: {
    graphqlUrl: optional(
      'HEALTHIE_GRAPHQL_URL',
      'https://api.gethealthie.com/graphql'
    ),
    apiKey: optional('HEALTHIE_API_KEY', ''),
    apiSecret: optional('HEALTHIE_API_SECRET', ''),
  },

  dosespot: {
    baseUrl: optional('DOSESPOT_BASE_URL', 'https://api.dosespot.com/v14'),
    apiKey: optional('DOSESPOT_API_KEY', ''),
    apiSecret: optional('DOSESPOT_API_SECRET', ''),
    clinicId: optional('DOSESPOT_CLINIC_ID', ''),
  },

  labcorp: {
    baseUrl: optional('LABCORP_BASE_URL', 'https://api.labcorp.com'),
    apiKey: optional('LABCORP_API_KEY', ''),
    accountId: optional('LABCORP_ACCOUNT_ID', ''),
  },

  stripe: {
    apiKey: optional('STRIPE_API_KEY', ''),
    webhookSecret: optional('STRIPE_WEBHOOK_SECRET', ''),
  },

  zoho: {
    baseUrl: optional('ZOHO_CRM_BASE_URL', 'https://www.zohoapis.com/crm/v2'),
    clientId: optional('ZOHO_CRM_CLIENT_ID', ''),
    clientSecret: optional('ZOHO_CRM_CLIENT_SECRET', ''),
    refreshToken: optional('ZOHO_CRM_REFRESH_TOKEN', ''),
  },

  n8n: {
    baseUrl: optional('N8N_BASE_URL', 'http://localhost:5678'),
    apiKey: optional('N8N_API_KEY', ''),
    webhookUrl: optional('N8N_WEBHOOK_URL', ''),
  },

  keragon: {
    baseUrl: optional('KERAGON_BASE_URL', 'https://api.keragon.com'),
    apiKey: optional('KERAGON_API_KEY', ''),
    webhookUrl: optional('KERAGON_WEBHOOK_URL', ''),
  },

  telehealth: {
    provider: optional('TELEHEALTH_PROVIDER', 'doxy'),
    username: optional('DOXY_USERNAME', ''),
    password: optional('DOXY_PASSWORD', ''),
  },

  redis: {
    url: optional('REDIS_URL', 'redis://localhost:6379'),
  },
};

export type AppConfig = typeof config;
