import { t } from '@group-chess/shared';
import { serve, type ServerType } from '@hono/node-server';
import type { Bot } from 'grammy';
import type { Hono } from 'hono';
import { createApiApp } from './api/app';
import type { ApiContext, ApiEnv } from './api/context';
import { gameRoutes } from './api/routes/index';
import { staticAppRoutes } from './api/staticApp';
import { StreamGate } from './api/streams';
import { createBot } from './bot/bot';
import { RateLimiter } from './bot/rateLimit';
import { webhookRoutes } from './bot/webhook';
import { LocalBus } from './bus/bus';
import { startScanners } from './clock/scanners';
import type { Config, Role } from './config';
import { createDb } from './db/client';
import { runMigrations } from './db/migrate';
import type { Deps } from './domain/deps';
import {
  coreJobHandlers,
  ensurePruneScheduled,
  lichessJobHandlers,
  sharePhotoJobHandlers,
  telegramJobHandlers,
} from './jobs/handlers';
import { JobWorker } from './jobs/worker';
import { createLogger } from './logger';
import { Metrics } from './metrics';
import { createTelegramApi, instrumentTelegramApi } from './telegram/client';
import { Membership } from './telegram/membership';

/** Spec §5.1 step 4; `chat_member` only arrives where the bot is an administrator. */
export const ALLOWED_UPDATES = [
  'message',
  'callback_query',
  'my_chat_member',
  'chat_member',
] as const;

/** Spec §5.1 step 3: three group commands, one private command, nothing in the default scope. */
export const BOT_COMMANDS = {
  group: [
    { command: 'play', description: t('command.play.description') },
    { command: 'chess', description: t('command.chess.description') },
    { command: 'settings', description: t('command.settings.description') },
  ],
  private: [{ command: 'start', description: t('command.start.description') }],
} as const;

export type RunningServer = {
  port: number;
  app: Hono<ApiEnv>;
  /** Drops every open connection (SSE streams included); clients see a dead socket and reconnect. */
  closeConnections(): void;
  stop(): Promise<void>;
};

function listen(app: Hono<ApiEnv>, port: number): Promise<ServerType> {
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, () => resolve(server));
  });
}

/**
 * Boots the roles in `config.ROLES` (spec §4.2, §4.4): migrations first, then the HTTP app (health,
 * metrics, API when `api`, webhook when `bot`, the Mini App when `MINI_APP_DIR`), the job worker
 * when `jobs`, the scanners when `clock`, and finally the webhook registration or long polling.
 */
export async function startServer(config: Config): Promise<RunningServer> {
  const log = createLogger(config.LOG_LEVEL);
  const has = (role: Role): boolean => config.ROLES.includes(role);
  await runMigrations(config.DATABASE_URL);
  const { db, close } = createDb(config.DATABASE_URL);
  const deps: Deps = { db, bus: new LocalBus(), log };
  const metrics = new Metrics({ db });

  const bot: Bot | null = has('bot') ? await createBot(deps, config) : null;
  const api = bot ? bot.api : createTelegramApi(config, { apiRoot: config.TELEGRAM_API_ROOT });
  instrumentTelegramApi(api, metrics);
  // Membership lookups get their own client without the message throttler (spec §4.3, §5.8).
  const lookupApi = createTelegramApi(config, {
    apiRoot: config.TELEGRAM_API_ROOT,
    throttle: false,
  });
  instrumentTelegramApi(lookupApi, metrics);
  const membership = new Membership(deps, lookupApi);
  const apiCtx: ApiContext = {
    deps,
    config,
    membership,
    metrics,
    streams: new StreamGate(),
    rateLimiter: new RateLimiter(120, 60_000),
  };

  const app = createApiApp(apiCtx, has('api') ? gameRoutes : []);
  if (bot && !config.TELEGRAM_POLLING) app.route('/', webhookRoutes(bot, deps, config, metrics));
  if (config.MINI_APP_DIR) app.route('/app', staticAppRoutes(config.MINI_APP_DIR));
  const server = await listen(app, config.PORT);
  const port = (server.address() as { port: number }).port;

  let worker: JobWorker | null = null;
  if (has('jobs')) {
    await ensurePruneScheduled(db);
    worker = new JobWorker({
      db,
      log,
      handlers: {
        ...coreJobHandlers(deps),
        ...telegramJobHandlers({ deps, api, config }),
        ...sharePhotoJobHandlers({ deps, api, config }),
        ...lichessJobHandlers({ deps, config, metrics }),
      },
      workerId: `${process.pid}`,
      onFailed: (job) => metrics.jobsFailed.inc({ kind: job.kind }),
    });
    worker.start();
  }
  const scanners = has('clock') ? startScanners(deps) : null;

  let polling: Promise<void> | null = null;
  if (bot) {
    await api.setMyCommands(BOT_COMMANDS.group, { scope: { type: 'all_group_chats' } });
    await api.setMyCommands(BOT_COMMANDS.private, { scope: { type: 'all_private_chats' } });
    if (config.TELEGRAM_POLLING) {
      await api.deleteWebhook();
      polling = bot.start({ allowed_updates: [...ALLOWED_UPDATES] });
      polling.catch((error: unknown) => log.error({ err: error }, 'long polling stopped'));
    } else {
      await api.setWebhook(`${config.PUBLIC_URL.replace(/\/$/, '')}/telegram/webhook`, {
        secret_token: config.WEBHOOK_SECRET,
        allowed_updates: [...ALLOWED_UPDATES],
      });
    }
  }
  log.info({ port, roles: config.ROLES, polling: polling !== null }, 'server started');

  return {
    port,
    app,
    closeConnections() {
      if ('closeAllConnections' in server) server.closeAllConnections();
    },
    async stop() {
      if (bot && polling) {
        await bot.stop();
        await polling.catch(() => undefined);
      }
      await scanners?.stop();
      await worker?.stop();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await close();
      log.info('server stopped');
    },
  };
}
