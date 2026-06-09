/**
 * JWT + bcrypt auth. Tokens are HS256. The "typ" header includes the
 * role, and we include a session id (jti) so we can revoke on logout.
 */
import * as jwt from 'jsonwebtoken';
import * as bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config';

export type UserRole =
  | 'provider'
  | 'front_desk'
  | 'biller'
  | 'admin'
  | 'patient'
  | 'integration';

export interface AuthTokenPayload {
  sub: string; // user id (uuid)
  email: string;
  role: UserRole;
  orgId: string;
  sessionId: string; // jti
}

export interface SignOptions {
  expiresIn?: string;
  audience?: string;
  issuer?: string;
}

export function signToken(
  payload: Omit<AuthTokenPayload, 'sessionId'>,
  opts: SignOptions = {}
): string {
  const sessionId = uuidv4();
  return jwt.sign(
    { ...payload, sessionId },
    config.auth.jwtSecret,
    {
      algorithm: 'HS256',
      expiresIn: (opts.expiresIn ?? config.auth.jwtExpiresIn) as jwt.SignOptions['expiresIn'],
      audience: opts.audience ?? 'nrg-clinic',
      issuer: opts.issuer ?? 'nrg-clinic-auth',
    }
  );
}

export function verifyToken(token: string): AuthTokenPayload {
  return jwt.verify(token, config.auth.jwtSecret, {
    algorithms: ['HS256'],
    audience: 'nrg-clinic',
    issuer: 'nrg-clinic-auth',
  }) as AuthTokenPayload;
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, config.auth.bcryptRounds);
}

export async function verifyPassword(
  plain: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
