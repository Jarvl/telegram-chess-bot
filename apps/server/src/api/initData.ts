import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../domain/errors';

export const INIT_DATA_MAX_AGE_SECONDS = 86_400;

const InitDataUserSchema = z.object({
  id: z.number().int().positive(),
  first_name: z.string(),
  last_name: z.string().optional(),
  username: z.string().optional(),
  language_code: z.string().optional(),
  allows_write_to_pm: z.boolean().optional(),
  is_bot: z.boolean().optional(),
});

export type InitDataUser = z.infer<typeof InitDataUserSchema>;

export type ParsedInitData = {
  user: InitDataUser;
  authDate: Date;
  startParam: string | null;
  queryId: string | null;
};

/** Telegram's recipe: sorted `key=value` pairs joined by `\n`, keyed by HMAC-SHA256("WebAppData", token). */
export function initDataHash(params: URLSearchParams, botToken: string): string {
  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== 'hash')
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  return createHmac('sha256', secret).update(dataCheckString).digest('hex');
}

export function validateInitData(
  raw: string,
  botToken: string,
  options: { now?: Date; maxAgeSeconds?: number } = {},
): ParsedInitData {
  const params = new URLSearchParams(raw);
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/.test(hash))
    throw new DomainError('unauthorized', 'init data has no hash');
  const expected = initDataHash(params, botToken);
  if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(hash, 'hex'))) {
    throw new DomainError('unauthorized', 'init data signature mismatch');
  }
  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate))
    throw new DomainError('unauthorized', 'init data has no auth_date');
  const now = options.now ?? new Date();
  if (now.getTime() / 1000 - authDate > (options.maxAgeSeconds ?? INIT_DATA_MAX_AGE_SECONDS)) {
    throw new DomainError('unauthorized', 'init data expired', { reason: 'expired' });
  }
  const rawUser = params.get('user');
  if (!rawUser) throw new DomainError('unauthorized', 'init data has no user');
  const user = InitDataUserSchema.safeParse(
    (() => {
      try {
        return JSON.parse(rawUser) as unknown;
      } catch {
        return null;
      }
    })(),
  );
  if (!user.success) throw new DomainError('unauthorized', 'init data user is malformed');
  return {
    user: user.data,
    authDate: new Date(authDate * 1000),
    startParam: params.get('start_param'),
    queryId: params.get('query_id'),
  };
}
