import { sign, verify } from 'hono/jwt';
import { DomainError } from '../domain/errors';

export const SESSION_TTL_SECONDS = 86_400;

/** HS256 JWT with `sub`, `iat`, `exp` (spec D12, §12). */
export async function issueSessionToken(
  secret: string,
  userId: number,
  now: Date = new Date(),
): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000);
  return sign({ sub: String(userId), iat, exp: iat + SESSION_TTL_SECONDS }, secret, 'HS256');
}

export async function verifySessionToken(secret: string, token: string): Promise<number> {
  try {
    const payload = await verify(token, secret, 'HS256');
    const userId = typeof payload.sub === 'string' ? Number(payload.sub) : Number.NaN;
    if (!Number.isInteger(userId) || userId <= 0) throw new Error('bad subject');
    return userId;
  } catch {
    throw new DomainError('unauthorized', 'invalid session');
  }
}
