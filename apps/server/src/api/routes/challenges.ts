import type { Context, Hono } from 'hono';
import {
  acceptChallenge,
  cancelChallenge,
  declineChallenge,
  getChallengeByPublicId,
} from '../../domain/challenges';
import { DomainError } from '../../domain/errors';
import { loadGameDto } from '../../domain/games';
import { requireGroup } from '../../domain/groups';
import { requireMember } from '../access';
import type { ApiContext, ApiEnv } from '../context';
import { publicIdParam } from '../middleware';

export function challengeRoutes(api: Hono<ApiEnv>, ctx: ApiContext): void {
  const { db } = ctx.deps;
  const load = async (c: Context<ApiEnv>) => {
    const challenge = await getChallengeByPublicId(db, publicIdParam(c, 'c'));
    if (!challenge) throw new DomainError('not_found', 'challenge not found');
    await requireMember(ctx, await requireGroup(db, challenge.groupId), c.get('user'));
    return challenge;
  };

  api.post('/challenges/:c/accept', async (c) => {
    const challenge = await load(c);
    const { game } = await acceptChallenge(ctx.deps, {
      challengeId: challenge.id,
      userId: c.get('user').id,
    });
    return c.json(await loadGameDto(db, game, c.get('user').id));
  });

  api.post('/challenges/:c/decline', async (c) => {
    const challenge = await load(c);
    await declineChallenge(ctx.deps, { challengeId: challenge.id, userId: c.get('user').id });
    return c.json({ ok: true });
  });

  api.post('/challenges/:c/cancel', async (c) => {
    const challenge = await load(c);
    await cancelChallenge(ctx.deps, { challengeId: challenge.id, userId: c.get('user').id });
    return c.json({ ok: true });
  });
}
