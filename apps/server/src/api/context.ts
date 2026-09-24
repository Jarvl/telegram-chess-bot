import type { RateLimiter } from '../bot/rateLimit';
import type { Config } from '../config';
import type { UserRow } from '../db/schema';
import type { Deps } from '../domain/deps';
import type { Metrics } from '../metrics';
import type { Membership } from '../telegram/membership';
import type { StreamGate } from './streams';

export type ApiContext = {
  deps: Deps;
  config: Config;
  membership: Membership;
  metrics: Metrics;
  streams: StreamGate;
  /** Spec §7.8: 120 API requests per user per minute; one instance per process. */
  rateLimiter: RateLimiter;
};

export type ApiEnv = { Variables: { user: UserRow } };
