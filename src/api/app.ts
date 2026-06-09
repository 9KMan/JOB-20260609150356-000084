/**
 * REST API — Express + middleware (helmet, cors, rate limit, request
 * logging). The REST surface is intentionally small: it covers the
 * few operations that must be reachable over plain HTTP (webhooks,
 * health check, file upload). The clinician-facing surface is GraphQL.
 */
import express, { Request, Response, NextFunction, Router } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import bodyParser from 'body-parser';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { Pool } from 'pg';
import { verifyToken } from '../auth/jwt';
import { GraphQLContext } from '../graphql/resolvers';
import { logger } from '../utils/logger';
import { getAuditLogger } from '../db/audit';

export function buildApp(pool: Pool, buildContext: (p: Pool, auth?: unknown) => GraphQLContext): express.Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: false })); // lock down by default; explicit allowlist at the edge
  app.use(bodyParser.json({ limit: '1mb' }));
  app.use(bodyParser.urlencoded({ extended: false }));
  app.use(morgan('combined'));
  app.use(
    rateLimit({
      windowMs: 60_000,
      max: 600,
      standardHeaders: true,
      legacyHeaders: false,
    })
  );

  // Health probe (unauthenticated)
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', service: 'nrg-clinic-integration' });
  });

  // Webhooks
  const webhooks = Router();
  webhooks.post(
    '/stripe',
    bodyParser.raw({ type: 'application/json' }),
    async (req: Request, res: Response) => {
      const sig = req.header('stripe-signature');
      if (!sig) {
        res.status(400).send('missing signature');
        return;
      }
      try {
        // Lazy import to avoid loading stripe SDK on every request
        const { StripeClient } = await import('../integrations/stripe/client');
        const stripe = new StripeClient();
        const event = stripe.verifyWebhook(req.body, sig);
        await getAuditLogger().record({
          action: 'integration.stripe.charge',
          resourceType: 'stripe_event',
          resourceId: (event as { id?: string }).id ?? null,
          outcome: 'success',
          metadata: { type: (event as { type?: string }).type ?? null },
        });
        // Hand off to async handler; respond 200 immediately.
        res.json({ received: true });
      } catch (err) {
        logger.error({ err }, 'stripe webhook verification failed');
        res.status(400).send('invalid signature');
      }
    }
  );

  webhooks.post(
    '/labcorp',
    bodyParser.json(),
    async (req: Request, res: Response) => {
      try {
        // Verify shared secret in header
        const secret = req.header('x-labcorp-secret');
        if (!secret || secret !== process.env.LABCORP_WEBHOOK_SECRET) {
          res.status(401).json({ error: 'unauthorized' });
          return;
        }
        const { LabsService } = await import('../services/labs/labsService');
        const { LabCorpClient } = await import('../integrations/labcorp/client');
        const labs = new LabsService(pool, new LabCorpClient());
        await labs.ingestResult(req.body);
        res.json({ received: true });
      } catch (err) {
        logger.error({ err }, 'labcorp webhook failed');
        res.status(500).json({ error: 'internal' });
      }
    }
  );
  app.use('/webhooks', webhooks);

  // Auth-protected REST routes
  const api = Router();
  api.use((req: Request, res: Response, next: NextFunction) => {
    const h = req.header('authorization');
    if (!h || !h.toLowerCase().startsWith('bearer ')) {
      res.status(401).json({ error: 'missing_token' });
      return;
    }
    try {
      const payload = verifyToken(h.slice(7).trim());
      (req as Request & { auth?: unknown }).auth = payload;
      next();
    } catch {
      res.status(401).json({ error: 'invalid_token' });
    }
  });

  // The /graphql endpoint reuses our auth context.
  api.post('/graphql-info', (_req, res) => {
    res.json({
      graphql: '/graphql',
      note: 'Send POST with Authorization: Bearer <jwt>',
    });
  });

  app.use('/api/v1', api);

  // Error handler
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err }, 'unhandled error');
    res.status(500).json({ error: 'internal' });
  });

  return app;
}
