import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { closeDb, initDb } from './db/index.js';
import { logger } from './lib/logger.js';
import { bootstrapAdminPassword } from './services/auth.js';
import { bootstrapAdmin } from './services/admins.js';
import { countJobs } from './services/jobs.js';
import { registerApiRoutes } from './routes/api.js';
import { registerUiRoutes } from './routes/ui.js';
import { startScheduler, stopScheduler } from './scheduler/worker.js';

async function main(): Promise<void> {
  initDb();
  bootstrapAdminPassword();
  bootstrapAdmin();
  if (config.discordEnabled) {
    logger.info(`discord login enabled (redirect ${config.publicBaseUrl}/auth/discord/callback)`);
    // A mis-pasted secret only surfaces as `invalid_client` at login time, which
    // is far from the cause. Flag the obvious shape problems at boot instead.
    const secret = config.discordClientSecret;
    if (!/^[A-Za-z0-9_-]+$/.test(secret)) {
      logger.warn(
        'DISCORD_CLIENT_SECRET contains unexpected characters — re-run deploy/set-discord-auth.sh',
      );
    } else if (secret.length !== 32) {
      logger.warn(
        `DISCORD_CLIENT_SECRET is ${secret.length} characters; Discord secrets are normally 32. ` +
          'If login fails with invalid_client, re-run deploy/set-discord-auth.sh',
      );
    }
    if (!/^\d{17,20}$/.test(config.discordClientId)) {
      logger.warn(`DISCORD_CLIENT_ID "${config.discordClientId}" does not look like a Discord snowflake`);
    }
  } else {
    logger.info('discord login DISABLED — set DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET to enable it');
  }

  const app = Fastify({
    logger: false,
    // Only cloudflared can reach the bind address, so its forwarded client IP
    // is authoritative for rate limiting and the audit log.
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(cookie, { secret: config.appSecret });
  await app.register(formbody);
  await app.register(fastifyStatic, {
    root: config.publicDir,
    prefix: '/static/',
    cacheControl: true,
    maxAge: '1h',
  });

  app.get('/healthz', async () => ({
    status: 'ok',
    version: '1.0.0',
    queued: countJobs('queued'),
    failed: countJobs('failed'),
    time: new Date().toISOString(),
  }));

  await app.register(registerApiRoutes, { prefix: '/api/v1' });
  await app.register(registerUiRoutes);

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'エンドポイントが存在しません' } });
    }
    return reply.code(404).type('text/html; charset=utf-8').send('<h1>404 Not Found</h1><p><a href="/">トップへ</a></p>');
  });

  app.setErrorHandler((err: Error, req, reply) => {
    logger.error(`unhandled error on ${req.method} ${req.url}: ${err.message}`, err.stack);
    if (req.url.startsWith('/api/')) {
      return reply.code(500).send({ error: { code: 'internal_error', message: 'サーバー内部エラー' } });
    }
    return reply.code(500).type('text/html; charset=utf-8').send('<h1>500 Internal Server Error</h1>');
  });

  startScheduler();

  await app.listen({ host: config.host, port: config.port });
  logger.info(`listening on http://${config.host}:${config.port} (public: ${config.publicBaseUrl})`);

  const shutdown = (signal: string) => {
    logger.info(`${signal} received, shutting down`);
    stopScheduler();
    void app.close().then(() => {
      closeDb();
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  logger.error(`failed to start: ${(err as Error).message}`, (err as Error).stack);
  process.exit(1);
});
