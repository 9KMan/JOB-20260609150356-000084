import pino from 'pino';
import { config } from '../config';

export const logger = pino({
  level: config.logLevel,
  base: { service: 'nrg-clinic-integration' },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-api-key"]',
      '*.password',
      '*.token',
      '*.secret',
      '*.ssn',
      '*.dob',
      '*.date_of_birth',
      'phi',
      'phi_data',
    ],
    censor: '[REDACTED]',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type Logger = typeof logger;
