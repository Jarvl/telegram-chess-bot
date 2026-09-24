import type { Hono } from 'hono';
import { createApiApp, type RegisterRoutes } from '../../src/api/app';
import type { ApiContext, ApiEnv } from '../../src/api/context';
import { gameRoutes } from '../../src/api/routes/index';
import { issueSessionToken } from '../../src/api/session';
import { StreamGate } from '../../src/api/streams';
import { RateLimiter } from '../../src/bot/rateLimit';
import type { Config } from '../../src/config';
import type { Db } from '../../src/db/client';
import type { UserRow } from '../../src/db/schema';
import type { Deps } from '../../src/domain/deps';
import { Metrics } from '../../src/metrics';
import { createTelegramApi } from '../../src/telegram/client';
import { Membership } from '../../src/telegram/membership';
import { testConfig } from './config';
import { testDeps } from './db';
import { FakeTelegram } from './fakeTelegram';

export type TestApi = {
  app: Hono<ApiEnv>;
  fake: FakeTelegram;
  config: Config;
  ctx: ApiContext;
  deps: Deps;
  sessionFor(user: Pick<UserRow, 'id'>): Promise<string>;
  request(
    method: string,
    path: string,
    options?: {
      token?: string;
      body?: unknown;
      headers?: Record<string, string>;
      signal?: AbortSignal;
    },
  ): Promise<Response>;
  stop(): Promise<void>;
};

export async function startTestApi(
  db: Db,
  extra: RegisterRoutes[] = gameRoutes,
  configOverrides: Partial<Config> = {},
): Promise<TestApi> {
  const fake = await FakeTelegram.start();
  const config = testConfig({ TELEGRAM_API_ROOT: fake.url, ...configOverrides });
  const deps = testDeps(db);
  const membership = new Membership(deps, createTelegramApi(config, { apiRoot: fake.url }));
  const ctx: ApiContext = {
    deps,
    config,
    membership,
    metrics: new Metrics(),
    streams: new StreamGate(),
    rateLimiter: new RateLimiter(120, 60_000),
    api: createTelegramApi(config, { apiRoot: fake.url, throttle: false }),
    tipLimiter: new RateLimiter(10, 60_000),
  };
  const app = createApiApp(ctx, extra);
  return {
    app,
    fake,
    config,
    ctx,
    deps,
    sessionFor: (user) => issueSessionToken(config.SESSION_SECRET, user.id),
    request: async (method, path, options = {}) =>
      app.request(path, {
        method,
        headers: {
          ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
          ...options.headers,
        },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: options.signal,
      }),
    stop: () => fake.stop(),
  };
}
