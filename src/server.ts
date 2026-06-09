/**
 * Server entrypoint — wires Apollo Server into Express at /graphql
 * and starts the HTTP listener. Used by `npm start` and Docker.
 */
import express from 'express';
import http from 'http';
import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@apollo/server/express4';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { config } from './config';
import { logger } from './utils/logger';
import { getPool, closePool } from './db/pool';
import { typeDefs } from './graphql/schema/typeDefs';
import { resolvers, buildContext, GraphQLContext } from './graphql/resolvers';
import { buildApp } from './api/app';
import { verifyToken } from './auth/jwt';

async function main(): Promise<void> {
  const pool = getPool();
  const app = buildApp(pool, (p, auth) => buildContext(p, auth as never));
  const schema = makeExecutableSchema({ typeDefs, resolvers });

  const apollo = new ApolloServer<GraphQLContext>({
    schema,
    introspection: config.env !== 'production',
    // CSRF prevention: require a non-default content-type for mutations.
    plugins: [
      {
        async requestDidStart() {
          return {
            async didEncounterErrors(ctx) {
              for (const e of ctx.errors) {
                logger.warn(
                  { err: e.message, op: ctx.operationName },
                  'graphql error'
                );
              }
            },
          };
        },
      },
    ],
  });
  await apollo.start();

  app.use(
    '/graphql',
    express.json({ limit: '1mb' }),
    expressMiddleware(apollo, {
      context: async ({ req }) => {
        const h = req.header('authorization');
        let auth;
        if (h && h.toLowerCase().startsWith('bearer ')) {
          try {
            auth = verifyToken(h.slice(7).trim());
          } catch {
            // unauthenticated request — context.auth is undefined
          }
        }
        return buildContext(pool, auth);
      },
    })
  );

  const server = http.createServer(app);
  server.listen(config.port, () => {
    logger.info(
      { port: config.port, env: config.env },
      'NRG Clinic integration service listening'
    );
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutdown initiated');
    server.close();
    await apollo.stop();
    await closePool();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'fatal startup error');
  process.exit(1);
});
