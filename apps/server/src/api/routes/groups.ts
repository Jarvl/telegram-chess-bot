import {
  ChallengeRequestSchema,
  FinishedQuerySchema,
  UserIdSchema,
  type PlayersPickerDto,
} from '@group-chess/shared';
import { eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { challenges } from '../../db/schema';
import { createChallenge } from '../../domain/challenges';
import { requireGroupByPublicId, settingsOf } from '../../domain/groups';
import { buildLobby, listFinished, playerPage } from '../../domain/lobby';
import { listKnownPlayers } from '../../domain/members';
import { getLeaderboard } from '../../domain/ratings';
import { challengeDtoRows, challengeToDto } from '../../domain/summaries';
import { requireMember } from '../access';
import type { ApiContext, ApiEnv } from '../context';
import { publicIdParam } from '../middleware';
import { validate } from '../validate';

export function groupsRoutes(api: Hono<ApiEnv>, ctx: ApiContext): void {
  const { db } = ctx.deps;
  const memberGroup = async (c: Context<ApiEnv>) => {
    const group = await requireGroupByPublicId(db, publicIdParam(c, 'g'));
    await requireMember(ctx, group, c.get('user'));
    return group;
  };

  api.get('/groups/:g', async (c) => {
    const group = await memberGroup(c);
    const isAdmin = await ctx.membership.isAdmin(group, c.get('user'));
    return c.json(await buildLobby(ctx.deps, group, c.get('user'), { isAdmin }));
  });

  api.get('/groups/:g/players', async (c) => {
    const group = await memberGroup(c);
    const body: PlayersPickerDto = {
      players: await listKnownPlayers(db, group.id, { excludeUserId: c.get('user').id }),
    };
    return c.json(body);
  });

  api.get('/groups/:g/leaderboard', async (c) => {
    const group = await memberGroup(c);
    return c.json({
      players: await getLeaderboard(db, group.id, settingsOf(group).leaderboardMinGames),
    });
  });

  api.get('/groups/:g/players/:u', async (c) => {
    const group = await memberGroup(c);
    const userId = UserIdSchema.parse(c.req.param('u'));
    return c.json(await playerPage(ctx.deps, group.id, c.get('user').id, Number(userId)));
  });

  api.get('/groups/:g/finished', validate('query', FinishedQuerySchema), async (c) => {
    const group = await memberGroup(c);
    return c.json(
      await listFinished(ctx.deps, group.id, c.get('user').id, c.req.valid('query').cursor ?? null),
    );
  });

  api.post('/groups/:g/challenges', validate('json', ChallengeRequestSchema), async (c) => {
    const group = await memberGroup(c);
    const body = c.req.valid('json');
    const settings = settingsOf(group);
    const challenge = await createChallenge(ctx.deps, {
      groupId: group.id,
      challengerId: c.get('user').id,
      opponentId: body.opponentId === null ? null : Number(body.opponentId),
      timePerMove: body.timePerMove,
      colour: body.colour,
      rated: body.rated,
      threadId: settings.cardTopicMode === 'fixed' ? settings.fixedTopicId : null,
    });
    const [row] = await challengeDtoRows(db, eq(challenges.id, challenge.id), 1);
    return c.json(challengeToDto(row!, c.get('user').id));
  });
}
