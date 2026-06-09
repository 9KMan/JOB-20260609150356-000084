import { Request, Response, NextFunction } from 'express';
import { verifyToken, AuthTokenPayload, UserRole } from './jwt';
import { getAuditLogger } from '../db/audit';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthTokenPayload;
    }
  }
}

const ROLE_HIERARCHY: Record<UserRole, number> = {
  integration: 0,
  patient: 1,
  front_desk: 2,
  biller: 3,
  provider: 4,
  admin: 5,
};

export function requireAuth() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.header('authorization');
    if (!header || !header.toLowerCase().startsWith('bearer ')) {
      res.status(401).json({ error: 'missing_token' });
      return;
    }
    const token = header.slice(7).trim();
    try {
      const payload = verifyToken(token);
      req.auth = payload;
      next();
    } catch (err) {
      void getAuditLogger().record({
        action: 'auth.login.failure',
        outcome: 'failure',
        ipAddress: req.ip ?? null,
        userAgent: req.header('user-agent') ?? null,
        metadata: { reason: (err as Error).message },
      });
      res.status(401).json({ error: 'invalid_token' });
    }
  };
}

export function requireRole(min: UserRole) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.auth) {
      res.status(401).json({ error: 'missing_token' });
      return;
    }
    if (ROLE_HIERARCHY[req.auth.role] < ROLE_HIERARCHY[min]) {
      res.status(403).json({ error: 'insufficient_role', required: min });
      return;
    }
    next();
  };
}
