import {
  freshPlayerState,
  type FinishedPageDto,
  type LeaderboardEntry,
  type LobbyDto,
  type MeGroupsDto,
  type PlayerPageDto,
  type WinDrawLoss,
} from '@group-chess/shared';
import { and, desc, eq, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import {
  games,
  groupMembers,
  groups,
  ratings,
  users,
  type GroupRow,
  type UserRow,
} from '../db/schema';
import type { Deps } from './deps';
import { settingsOf } from './groups';
import { toPlayerRef } from './players';
import { getLeaderboard } from './ratings';
import { challengeDtoRows, challengeToDto, gameSummaryRows, toGameSummary } from './summaries';
import { challenges } from '../db/schema';

const PAGE_SIZE = 20;

function encodeCursor(finishedAt: Date, id: number): string {
  return Buffer.from(`${finishedAt.toISOString()}|${id}`).toString('base64url');
}

function decodeCursor(cursor: string): { finishedAt: Date; id: number } | null {
  const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const finishedAt = new Date(iso ?? '');
  if (Number.isNaN(finishedAt.getTime()) || !Number.isInteger(Number(id))) return null;
  return { finishedAt, id: Number(id) };
}

/** Active games of a group, the viewer's own turn first, then most recently moved (PRD §8.2). */
export async function activeGames(tx: DbOrTx, groupId: number, viewerId: number) {
  const rows = await gameSummaryRows(
    tx,
    and(eq(games.groupId, groupId), eq(games.status, 'active')),
    [desc(games.lastMoveAt), desc(games.startedAt)],
    200,
  );
  return rows
    .map((row) => toGameSummary(row, viewerId))
    .sort((a, b) => Number(b.yourTurn) - Number(a.yourTurn));
}

export async function listFinished(
  deps: Deps,
  groupId: number,
  viewerId: number,
  cursor: string | null,
): Promise<FinishedPageDto> {
  const after = cursor ? decodeCursor(cursor) : null;
  const conditions = [eq(games.groupId, groupId), eq(games.status, 'finished')];
  if (after) {
    conditions.push(
      or(
        lt(games.finishedAt, after.finishedAt),
        and(eq(games.finishedAt, after.finishedAt), lt(games.id, after.id)),
      )!,
    );
  }
  const rows = await gameSummaryRows(
    deps.db,
    and(...conditions),
    [desc(games.finishedAt), desc(games.id)],
    PAGE_SIZE + 1,
  );
  const page = rows.slice(0, PAGE_SIZE);
  const last = page.at(-1);
  return {
    items: page.map((row) => toGameSummary(row, viewerId)),
    nextCursor:
      rows.length > PAGE_SIZE && last?.game.finishedAt
        ? encodeCursor(last.game.finishedAt, last.game.id)
        : null,
  };
}

export async function pendingChallenges(tx: DbOrTx, groupId: number, viewerId: number) {
  const rows = await challengeDtoRows(
    tx,
    and(eq(challenges.groupId, groupId), eq(challenges.status, 'pending')),
    50,
  );
  return rows.map((row) => challengeToDto(row, viewerId));
}

export async function buildLobby(
  deps: Deps,
  group: GroupRow,
  viewer: UserRow,
  options: { isAdmin: boolean },
): Promise<LobbyDto> {
  const settings = settingsOf(group);
  const [active, finished, pending, players] = await Promise.all([
    activeGames(deps.db, group.id, viewer.id),
    listFinished(deps, group.id, viewer.id, null),
    pendingChallenges(deps.db, group.id, viewer.id),
    getLeaderboard(deps.db, group.id, settings.leaderboardMinGames),
  ]);
  return {
    group: { id: group.publicId, title: group.title },
    isAdmin: options.isAdmin,
    settings: {
      defaultTimePerMove: settings.defaultTimePerMove,
      ratedDefault: settings.ratedDefault,
      allowOpenChallenges: settings.allowOpenChallenges,
    },
    active,
    finished,
    challenges: pending,
    players,
  };
}

/** Groups where the user is a known member and the bot is still present (spec §9 `GET /me/groups`). */
export async function meGroups(deps: Deps, userId: number): Promise<MeGroupsDto> {
  const memberOf = await deps.db
    .select({ group: groups })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .where(
      and(
        eq(groupMembers.userId, userId),
        eq(groupMembers.status, 'member'),
        isNull(groupMembers.blockedAt),
        ne(groups.botStatus, 'left'),
      ),
    )
    .orderBy(groups.title);
  if (memberOf.length === 0) return { groups: [] };
  const active = await deps.db
    .select({
      groupId: games.groupId,
      fen: games.fen,
      whiteId: games.whiteId,
      blackId: games.blackId,
    })
    .from(games)
    .where(
      and(
        eq(games.status, 'active'),
        or(eq(games.whiteId, userId), eq(games.blackId, userId)),
        inArray(
          games.groupId,
          memberOf.map((row) => row.group.id),
        ),
      ),
    );
  return {
    groups: memberOf.map(({ group }) => {
      const mine = active.filter((game) => game.groupId === group.id);
      const yourMove = mine.filter(
        (game) => (game.fen.split(' ')[1] === 'b' ? game.blackId : game.whiteId) === userId,
      ).length;
      return { id: group.publicId, title: group.title, activeGames: mine.length, yourMove };
    }),
  };
}

export async function playerPage(
  deps: Deps,
  groupId: number,
  viewerId: number,
  userId: number,
): Promise<PlayerPageDto> {
  const [user] = await deps.db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new (await import('./errors')).DomainError('not_found', 'player not found');
  const [rating] = await deps.db
    .select()
    .from(ratings)
    .where(and(eq(ratings.groupId, groupId), eq(ratings.userId, userId)))
    .limit(1);
  const state = rating ?? { ...freshPlayerState(), gamesPlayed: 0, wins: 0, draws: 0, losses: 0 };
  const player: LeaderboardEntry = {
    ...toPlayerRef(user, rating ?? null),
    gamesPlayed: state.gamesPlayed,
    record: { wins: state.wins, draws: state.draws, losses: state.losses },
  };
  const between = await deps.db
    .select({ result: games.result, whiteId: games.whiteId })
    .from(games)
    .where(
      and(
        eq(games.groupId, groupId),
        eq(games.status, 'finished'),
        isNull(games.voidedAt),
        or(
          and(eq(games.whiteId, viewerId), eq(games.blackId, userId)),
          and(eq(games.whiteId, userId), eq(games.blackId, viewerId)),
        ),
      ),
    );
  const headToHead: WinDrawLoss = { wins: 0, draws: 0, losses: 0 };
  for (const game of between) {
    if (game.result === '1/2-1/2') headToHead.draws += 1;
    else if (game.result === '1-0' || game.result === '0-1') {
      const viewerWon = (game.result === '1-0') === (game.whiteId === viewerId);
      if (viewerWon) headToHead.wins += 1;
      else headToHead.losses += 1;
    }
  }
  const recent = await gameSummaryRows(
    deps.db,
    and(eq(games.groupId, groupId), or(eq(games.whiteId, userId), eq(games.blackId, userId))),
    [desc(games.startedAt)],
    10,
  );
  return { player, headToHead, recentGames: recent.map((row) => toGameSummary(row, viewerId)) };
}

export const sqlNow = sql`now()`;
