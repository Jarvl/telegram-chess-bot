import { PublicIdSchema, UserIdSchema } from '@group-chess/shared';
import type { Context, MiddlewareHandler } from 'hono';
import { DomainError } from '../domain/errors';
import { getUserById } from '../domain/users';
import type { ApiContext, ApiEnv } from './context';
import { verifySessionToken } from './session';

/** Bearer token everywhere; the SSE route may pass it as `?token=` (spec §9). */
export function requireSession(ctx: ApiContext): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const header = c.req.header('authorization');
    const bearer = header?.startsWith('Bearer ') ? header.slice(7).trim() : null;
    const queryToken = c.req.path.endsWith('/events') ? (c.req.query('token') ?? null) : null;
    const token = bearer ?? queryToken;
    if (!token) throw new DomainError('unauthorized', 'missing session');
    const userId = await verifySessionToken(ctx.config.SESSION_SECRET, token);
    const user = await getUserById(ctx.deps.db, userId);
    if (!user || user.deletedAt) throw new DomainError('unauthorized', 'unknown session');
    c.set('user', user);
    await next();
  };
}

/** Spec §7.8: 120 API requests per user per minute, counted on the shared limiter. */
export function userRateLimit(ctx: ApiContext): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    if (!ctx.rateLimiter.allow(String(c.get('user').id)))
      throw new DomainError('rate_limited', 'too many requests');
    await next();
  };
}

/** A user id path parameter; a malformed one is an unknown resource, never a 500. */
export function userIdParam(c: Context, name: string): number {
  const parsed = UserIdSchema.safeParse(c.req.param(name));
  if (!parsed.success) throw new DomainError('not_found', `unknown ${name}`);
  return Number(parsed.data);
}

export function publicIdParam(c: Context, name: string): string {
  const value = c.req.param(name);
  const parsed = PublicIdSchema.safeParse(value);
  if (!parsed.success) throw new DomainError('not_found', `unknown ${name}`);
  return parsed.data;
}
