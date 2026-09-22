import { createHmac } from 'node:crypto';

/** Signs Mini App init data the way Telegram does, independently of the server's validator. */
export function signInitData(
  botToken: string,
  fields: {
    user: Record<string, unknown>;
    authDate?: number;
    startParam?: string;
    queryId?: string;
  },
): string {
  const params = new URLSearchParams();
  if (fields.queryId) params.set('query_id', fields.queryId);
  params.set('user', JSON.stringify(fields.user));
  params.set('auth_date', String(fields.authDate ?? Math.floor(Date.now() / 1000)));
  if (fields.startParam) params.set('start_param', fields.startParam);
  const dataCheckString = [...params.entries()]
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  params.set('hash', createHmac('sha256', secret).update(dataCheckString).digest('hex'));
  return params.toString();
}
