import {
  applyRatedGame,
  freshPlayerState,
  isRatedEndReason,
  replayRatings,
  type LeaderboardEntry,
  type PlayerRatingState,
  type RatingSnapshot,
} from '@group-chess/shared';
import { and, asc, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { games, groupMembers, ratings, users, type GameRow, type RatingRow } from '../db/schema';
import { toPlayerRef } from './players';

const RATED_RESULTS = ['1-0', '0-1', '1/2-1/2'] as const;

type RatedResult = (typeof RATED_RESULTS)[number];

function isRatedResult(result: GameRow['result']): result is RatedResult {
  return result !== null && (RATED_RESULTS as readonly string[]).includes(result);
}

function toState(row: RatingRow): PlayerRatingState {
  return {
    rating: row.rating,
    rd: row.rd,
    volatility: row.volatility,
    gamesPlayed: row.gamesPlayed,
    wins: row.wins,
    draws: row.draws,
    losses: row.losses,
    lastRatedGameAt: row.lastRatedGameAt,
  };
}

function toRow(
  groupId: number,
  userId: number,
  state: PlayerRatingState,
): typeof ratings.$inferInsert {
  return { groupId, userId, ...state };
}

export async function getPlayerRating(
  tx: DbOrTx,
  groupId: number,
  userId: number,
): Promise<Pick<RatingRow, 'rating' | 'rd'> | null> {
  const [row] = await tx
    .select({ rating: ratings.rating, rd: ratings.rd })
    .from(ratings)
    .where(and(eq(ratings.groupId, groupId), eq(ratings.userId, userId)))
    .limit(1);
  return row ?? null;
}

export async function loadRatingState(
  tx: DbOrTx,
  groupId: number,
  userId: number,
): Promise<PlayerRatingState> {
  const [row] = await tx
    .select()
    .from(ratings)
    .where(and(eq(ratings.groupId, groupId), eq(ratings.userId, userId)))
    .limit(1);
  return row ? toState(row) : freshPlayerState();
}

function snapshotColumns(snapshot: RatingSnapshot) {
  return {
    whiteRatingBefore: snapshot.white.before.rating,
    whiteRatingAfter: snapshot.white.after.rating,
    whiteRdBefore: snapshot.white.before.rd,
    whiteRdAfter: snapshot.white.after.rd,
    blackRatingBefore: snapshot.black.before.rating,
    blackRatingAfter: snapshot.black.after.rating,
    blackRdBefore: snapshot.black.before.rd,
    blackRdAfter: snapshot.black.after.rd,
  };
}

async function upsertStates(
  tx: DbOrTx,
  groupId: number,
  states: Map<string, PlayerRatingState>,
): Promise<void> {
  for (const [userId, state] of states) {
    const row = toRow(groupId, Number(userId), state);
    await tx
      .insert(ratings)
      .values(row)
      .onConflictDoUpdate({ target: [ratings.groupId, ratings.userId], set: row });
  }
}

/**
 * Each rated result is its own rating period for both players (spec §7.5). Returns null and
 * touches nothing for casual games and for results that do not change ratings (aborts, voids).
 */
export async function applyGameResultToRatings(
  tx: DbOrTx,
  game: GameRow,
  finishedAt: Date,
): Promise<RatingSnapshot | null> {
  if (!game.rated || !isRatedResult(game.result)) return null;
  if (!game.endReason || !isRatedEndReason(game.endReason)) return null;
  const white = String(game.whiteId);
  const black = String(game.blackId);
  const states = new Map<string, PlayerRatingState>([
    [white, await loadRatingState(tx, game.groupId, game.whiteId)],
    [black, await loadRatingState(tx, game.groupId, game.blackId)],
  ]);
  const snapshot = applyRatedGame(states, { white, black, result: game.result, finishedAt });
  await upsertStates(tx, game.groupId, states);
  await tx.update(games).set(snapshotColumns(snapshot)).where(eq(games.id, game.id));
  return snapshot;
}

const close = (a: number | null, b: number): boolean => a !== null && Math.abs(a - b) < 1e-6;

/** Spec §3.5, §7.5: replay every rated, finished, non-voided game in order; rewrite what changed. */
export async function rebuildGroupRatings(
  tx: DbOrTx,
  groupId: number,
): Promise<{ changedGameIds: number[] }> {
  const rows = await tx
    .select()
    .from(games)
    .where(
      and(
        eq(games.groupId, groupId),
        eq(games.status, 'finished'),
        eq(games.rated, true),
        isNull(games.voidedAt),
        inArray(games.result, [...RATED_RESULTS]),
      ),
    )
    .orderBy(asc(games.finishedAt), asc(games.id));
  const rated = rows.filter(
    (row): row is GameRow & { result: RatedResult; finishedAt: Date } =>
      isRatedResult(row.result) &&
      row.finishedAt !== null &&
      row.endReason !== null &&
      isRatedEndReason(row.endReason),
  );
  const { states, snapshots } = replayRatings(
    rated.map((row) => ({
      white: String(row.whiteId),
      black: String(row.blackId),
      result: row.result,
      finishedAt: row.finishedAt,
    })),
  );
  await tx.delete(ratings).where(eq(ratings.groupId, groupId));
  await upsertStates(tx, groupId, states);
  const changedGameIds: number[] = [];
  rated.forEach((row, index) => {
    const snapshot = snapshots[index]!;
    const columns = snapshotColumns(snapshot);
    const unchanged =
      close(row.whiteRatingBefore, columns.whiteRatingBefore) &&
      close(row.whiteRatingAfter, columns.whiteRatingAfter) &&
      close(row.whiteRdBefore, columns.whiteRdBefore) &&
      close(row.whiteRdAfter, columns.whiteRdAfter) &&
      close(row.blackRatingBefore, columns.blackRatingBefore) &&
      close(row.blackRatingAfter, columns.blackRatingAfter) &&
      close(row.blackRdBefore, columns.blackRdBefore) &&
      close(row.blackRdAfter, columns.blackRdAfter);
    if (!unchanged) changedGameIds.push(row.id);
  });
  for (const id of changedGameIds) {
    const index = rated.findIndex((row) => row.id === id);
    await tx.update(games).set(snapshotColumns(snapshots[index]!)).where(eq(games.id, id));
  }
  return { changedGameIds };
}

/** PRD §7.9: members with enough games, not deleted, not blocked; rating then games played. */
export async function getLeaderboard(
  tx: DbOrTx,
  groupId: number,
  minGames: number,
): Promise<LeaderboardEntry[]> {
  const rows = await tx
    .select({ user: users, rating: ratings, member: groupMembers })
    .from(ratings)
    .innerJoin(users, eq(users.id, ratings.userId))
    .leftJoin(
      groupMembers,
      and(eq(groupMembers.groupId, ratings.groupId), eq(groupMembers.userId, ratings.userId)),
    )
    .where(
      and(
        eq(ratings.groupId, groupId),
        gte(ratings.gamesPlayed, minGames),
        isNull(users.deletedAt),
        sql`${groupMembers.blockedAt} is null`,
      ),
    )
    .orderBy(desc(ratings.rating), desc(ratings.gamesPlayed), asc(users.id));
  return rows.map((row) => ({
    ...toPlayerRef(row.user, row.rating),
    gamesPlayed: row.rating.gamesPlayed,
    record: { wins: row.rating.wins, draws: row.rating.draws, losses: row.rating.losses },
  }));
}
