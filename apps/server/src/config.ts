import { z } from 'zod';

export const ROLES = ['api', 'bot', 'jobs', 'clock'] as const;

export type Role = (typeof ROLES)[number];

const RolesSchema = z
  .string()
  .default('api,bot,jobs,clock')
  .transform((raw) =>
    raw
      .split(',')
      .map((role) => role.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.enum(ROLES)).min(1));

/** Environment variables (spec §4.4). Validated once at startup; the process refuses to boot otherwise. */
export const ConfigSchema = z.object({
  BOT_TOKEN: z.string().min(1),
  BOT_USERNAME: z.string().min(1),
  MINI_APP_SHORT_NAME: z.string().min(1),
  PUBLIC_URL: z.url(),
  WEBHOOK_SECRET: z.string().min(16),
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  LICHESS_TOKEN: z.string().min(1).optional(),
  ROLES: RolesSchema,
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /** Bot API base for tests and local fakes; unset means api.telegram.org. */
  TELEGRAM_API_ROOT: z.url().optional(),
  /** `true` runs long polling (dev); otherwise updates arrive on the webhook (spec §4.4). */
  TELEGRAM_POLLING: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  LICHESS_API_URL: z.url().default('https://lichess.org'),
  /** Directory of the built Mini App to serve under /app/; unset means not served. */
  MINI_APP_DIR: z.string().min(1).optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (parsed.success) return parsed.data;
  const problems = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
  throw new Error(`Invalid configuration — ${problems}`);
}
