import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { games, ratings, type GameRow } from '../../src/db/schema';
import { touchMember } from '../../src/domain/members';
import {
  applyGameResultToRatings,
  getLeaderboard,
  rebuildGroupRatings,
} from '../../src/domain/ratings';
import { openTestDb, truncateAll } from '../helpers/db';
import { insertGame, insertGroup, insertUser } from '../helpers/fixtures';

const { db, close } = openTestDb();

beforeEach(() => truncateAll(db));
afterAll(() => close());

const finishedAt = (day: number) => new Date(Date.UTC(2026, 8, day, 12));

async function finished(
  groupId: number,
  whiteId: number,
  blackId: number,
  result: '1-0' | '0-1' | '1/2-1/2' | '*',
  endReason: GameRow['endReason'],
  day: number,
  rated = true,
): Promise<GameRow> {
  const game = await insertGame(db, groupId, whiteId, blackId, {
    rated,
    status: 'finished',
    result,
    endReason,
    finishedAt: finishedAt(day),
    plyCount: 30,
  });
  return game;
}

const reload = async (id: number) => (await db.select().from(games).where(eq(games.id, id)))[0]!;

describe('applyGameResultToRatings', () => {
  it('rates a decisive rated game and stores the snapshots on the game', async () => {
    const group = await insertGroup(db);
    const alice = await insertUser(db);
    const bob = await insertUser(db);
    const game = await finished(group.id, alice.id, bob.id, '1-0', 'resignation', 1);

    const snapshot = await applyGameResultToRatings(db, game, finishedAt(1));

    expect(snapshot?.white.after.rating).toBeGreaterThan(1500);
    const rows = await db.select().from(ratings).orderBy(ratings.userId);
    expect(rows.map((r) => [r.userId, r.gamesPlayed, r.wins, r.losses])).toEqual([
      [alice.id, 1, 1, 0],
      [bob.id, 1, 0, 1],
    ]);
    const stored = await reload(game.id);
    expect(stored.whiteRatingBefore).toBe(1500);
    expect(stored.whiteRdBefore).toBe(350);
    expect(stored.whiteRatingAfter).toBeCloseTo(rows[0]!.rating, 9);
    expect(stored.blackRatingAfter).toBeCloseTo(rows[1]!.rating, 9);
  });

  it('does nothing for a casual game', async () => {
    const group = await insertGroup(db);
    const alice = await insertUser(db);
    const bob = await insertUser(db);
    const game = await finished(group.id, alice.id, bob.id, '1-0', 'resignation', 1, false);
    expect(await applyGameResultToRatings(db, game, finishedAt(1))).toBeNull();
    expect(await db.select().from(ratings)).toHaveLength(0);
    expect((await reload(game.id)).whiteRatingAfter).toBeNull();
  });

  it('does nothing for an aborted rated game', async () => {
    const group = await insertGroup(db);
    const alice = await insertUser(db);
    const bob = await insertUser(db);
    const game = await finished(group.id, alice.id, bob.id, '*', 'abort', 1);
    expect(await applyGameResultToRatings(db, game, finishedAt(1))).toBeNull();
    expect(await db.select().from(ratings)).toHaveLength(0);
  });
});

describe('rebuildGroupRatings', () => {
  it('rewrites later games’ snapshots after a void', async () => {
    const group = await insertGroup(db);
    const alice = await insertUser(db);
    const bob = await insertUser(db);
    const carol = await insertUser(db);
    const a = await finished(group.id, alice.id, bob.id, '1-0', 'checkmate', 1);
    const b = await finished(group.id, bob.id, carol.id, '1-0', 'resignation', 2);
    const c = await finished(group.id, carol.id, alice.id, '1/2-1/2', 'draw_agreement', 3);
    for (const game of [a, b, c]) await applyGameResultToRatings(db, game, game.finishedAt!);
    const carolBeforeVoid = (await reload(c.id)).whiteRatingBefore;
    const aliceAfterA = (await reload(a.id)).whiteRatingAfter;
    expect(carolBeforeVoid).toBeLessThan(1500);

    await db
      .update(games)
      .set({ voidedAt: sql`now()`, voidedBy: alice.id })
      .where(eq(games.id, b.id));
    const { changedGameIds } = await rebuildGroupRatings(db, group.id);

    expect(changedGameIds).toEqual([c.id]);
    expect((await reload(c.id)).whiteRatingBefore).toBe(1500);
    expect((await reload(a.id)).whiteRatingAfter).toBeCloseTo(aliceAfterA ?? 0, 9);
    const rows = await db.select().from(ratings).orderBy(ratings.userId);
    expect(rows.map((r) => [r.userId, r.gamesPlayed])).toEqual([
      [alice.id, 2],
      [bob.id, 1],
      [carol.id, 1],
    ]);
  });

  it('removes rating rows for players whose games were all voided', async () => {
    const group = await insertGroup(db);
    const alice = await insertUser(db);
    const bob = await insertUser(db);
    const a = await finished(group.id, alice.id, bob.id, '1-0', 'checkmate', 1);
    await applyGameResultToRatings(db, a, finishedAt(1));
    await db
      .update(games)
      .set({ voidedAt: sql`now()` })
      .where(eq(games.id, a.id));
    await rebuildGroupRatings(db, group.id);
    expect(await db.select().from(ratings)).toHaveLength(0);
  });
});

describe('getLeaderboard', () => {
  it('orders by rating, applies the minimum games and hides blocked and deleted players', async () => {
    const group = await insertGroup(db);
    const alice = await insertUser(db, { firstName: 'Alice' });
    const bob = await insertUser(db, { firstName: 'Bob' });
    const carol = await insertUser(db, { firstName: 'Carol' });
    const dave = await insertUser(db, { firstName: 'Dave', deletedAt: new Date() });
    for (const user of [alice, bob, carol, dave]) await touchMember(db, group.id, user.id);
    await db.insert(ratings).values([
      {
        groupId: group.id,
        userId: alice.id,
        rating: 1550,
        rd: 80,
        volatility: 0.06,
        gamesPlayed: 6,
        wins: 4,
        draws: 1,
        losses: 1,
      },
      {
        groupId: group.id,
        userId: bob.id,
        rating: 1600,
        rd: 90,
        volatility: 0.06,
        gamesPlayed: 5,
        wins: 5,
        draws: 0,
        losses: 0,
      },
      {
        groupId: group.id,
        userId: carol.id,
        rating: 1700,
        rd: 200,
        volatility: 0.06,
        gamesPlayed: 2,
        wins: 2,
        draws: 0,
        losses: 0,
      },
      {
        groupId: group.id,
        userId: dave.id,
        rating: 1800,
        rd: 50,
        volatility: 0.06,
        gamesPlayed: 9,
        wins: 9,
        draws: 0,
        losses: 0,
      },
    ]);
    const board = await getLeaderboard(db, group.id, 5);
    expect(board.map((e) => [e.name, e.rating, e.gamesPlayed])).toEqual([
      ['Bob', 1600, 5],
      ['Alice', 1550, 6],
    ]);
    expect(board[1]?.record).toEqual({ wins: 4, draws: 1, losses: 1 });
  });
});
