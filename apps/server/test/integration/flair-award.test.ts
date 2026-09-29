import { FLAIR, INITIAL_FEN, type GameResult } from '@group-chess/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  flairIntroductions,
  games,
  jobs,
  userFlair,
  users,
  type GameRow,
} from '../../src/db/schema';
import { abortGame, resign } from '../../src/domain/games';
import { awardFlairForGame } from '../../src/flair/award';
import { coreJobHandlers } from '../../src/jobs/handlers';
import { JobWorker } from '../../src/jobs/worker';
import { LINES, play, PROMOTION_FEN } from '../helpers/chess';
import { openTestDb, testDeps, truncateAll } from '../helpers/db';
import {
  insertGame,
  insertGroup,
  insertMove,
  insertUser,
  type GameOverrides,
} from '../helpers/fixtures';

const { db, close } = openTestDb();
const deps = testDeps(db);
const LAUNCH = new Date(Date.UTC(2026, 0, 1));
const day = (n: number) => new Date(Date.UTC(2026, 1, n, 12));
const AFTER_E4_E5 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2';
/** Every rung of the rank ladder: a rated game's rating is scored against all of them. */
const LADDER = FLAIR.filter((f) => f.category === 'rank').map((f) => f.id);

// The truncate empties `flair_introductions` too: each test introduces only its own flair.
beforeEach(() => truncateAll(db));
afterAll(() => close());

async function players(aliceWears: string[] = []) {
  const group = await insertGroup(db);
  return {
    group,
    alice: await insertUser(db, { flairWorn: aliceWears }),
    bob: await insertUser(db),
  };
}
/** A finished game whose moves are `line` replayed from `start`; `result` is White's point of view. */
async function finished(
  groupId: number,
  whiteId: number,
  blackId: number,
  d: number,
  result: Exclude<GameResult, '*'>,
  options: { line?: readonly string[]; start?: string; over?: GameOverrides } = {},
): Promise<GameRow> {
  const moves = play(options.start ?? INITIAL_FEN, ...(options.line ?? []));
  const game = await insertGame(db, groupId, whiteId, blackId, {
    status: 'finished',
    result,
    endReason: 'resignation',
    finishedAt: day(d),
    plyCount: moves.length,
    ...options.over,
  });
  for (const m of moves) await insertMove(db, game.id, m.ply, m.uci, m.san, m.fenAfter);
  return game;
}
const earned = async (userId: number) =>
  (
    await db.select().from(userFlair).where(eq(userFlair.userId, userId)).orderBy(userFlair.flairId)
  ).map((r) => [r.flairId, r.gameId]);
const worn = async (userId: number) =>
  (await db.select({ worn: users.flairWorn }).from(users).where(eq(users.id, userId)))[0]!.worn;
/**
 * Introduces the flair a test is about, at the launch unless `at` says otherwise (spec §1.5). A
 * flair with no introduction is never a candidate (spec §3.2), so no other flair can be awarded,
 * and a flair added to the catalog later cannot change what these tests expect.
 */
const introduce = (flairIds: readonly string[], at: Date = LAUNCH) =>
  db.insert(flairIntroductions).values(flairIds.map((flairId) => ({ flairId, introducedAt: at })));
/**
 * Resolves once exactly `count` sessions of this database are waiting for a row lock taken by a
 * `select … for update`. (`pg_stat_activity` covers the whole server, and other test databases
 * share it.)
 */
async function waitForLockWaiters(count: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [row] = await db.execute(sql`
      select count(*)::int as waiting from pg_stat_activity
      where datname = current_database() and state = 'active' and wait_event_type = 'Lock'
        and query ilike '%for update%'`);
    if (row?.waiting === count) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${count} session(s) never came to wait for a row lock`);
}
/**
 * A change to a player's worn list in flight, as a `PUT` makes it: it holds the player's row until
 * `commit()` is called, then saves `wearing` with it.
 */
async function startWearing(userId: number, wearing: string[]) {
  let commit!: () => void;
  const mayCommit = new Promise<void>((resolve) => (commit = resolve));
  let holding!: () => void;
  const isHolding = new Promise<void>((resolve) => (holding = resolve));
  const done = db.transaction(async (tx) => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
    holding();
    await mayCommit;
    await tx.update(users).set({ flairWorn: wearing }).where(eq(users.id, userId));
  });
  await Promise.race([isHolding, done]);
  return { commit, done };
}

describe('award_flair', () => {
  it('is enqueued when a game against a person ends, and not for an abort or a bot game', async () => {
    const { group, alice, bob } = await players();
    const game = await insertGame(db, group.id, alice.id, bob.id, {
      fen: AFTER_E4_E5,
      plyCount: 2,
    });
    await resign(deps, { gameId: game.publicId, userId: bob.id });
    const aborted = await insertGame(db, group.id, alice.id, bob.id);
    await abortGame(deps, { gameId: aborted.publicId, userId: alice.id });
    const [engine] = await db.select().from(users).where(eq(users.isEngine, true));
    const botGame = await insertGame(db, group.id, alice.id, engine!.id, {
      engineLevel: 'beginner',
      rated: false,
      timePerMove: null,
      fen: AFTER_E4_E5,
      plyCount: 2,
    });
    await resign(deps, { gameId: botGame.publicId, userId: alice.id });
    const queued = (await db.select().from(jobs)).filter((job) => job.kind === 'award_flair');
    expect(queued.map((job) => [job.dedupKey, job.payload])).toEqual([
      [`flair:g:${game.publicId}`, { gameId: game.id }],
    ]);
  });

  it('runs as the job and gives 👑 to a winner who captured en passant, nothing to the loser', async () => {
    await introduce(['en_passant_win']);
    const { group, alice, bob } = await players();
    const moves = play(INITIAL_FEN, ...LINES.enPassant);
    const game = await insertGame(db, group.id, alice.id, bob.id, {
      rated: false,
      fen: moves.at(-1)!.fenAfter,
      plyCount: moves.length,
    });
    for (const m of moves) await insertMove(db, game.id, m.ply, m.uci, m.san, m.fenAfter);
    await resign(deps, { gameId: game.publicId, userId: bob.id });
    await new JobWorker({
      db,
      log: deps.log,
      handlers: coreJobHandlers(deps),
      workerId: 'w',
    }).runOnce();
    expect(await earned(alice.id)).toEqual([['en_passant_win', game.id]]);
    expect(await earned(bob.id)).toEqual([]);
  });

  it('awards 🏰 for a win with O-O-O and ♟️ for a win with a promotion', async () => {
    await introduce(['queenside_castle_win', 'promotion_win']);
    const { group, alice, bob } = await players();
    const castled = await finished(group.id, alice.id, bob.id, 2, '1-0', {
      line: LINES.bothCastleQueenside,
    });
    const promoted = await finished(group.id, alice.id, bob.id, 3, '1-0', {
      start: PROMOTION_FEN,
      line: ['e7e8q'],
    });
    await awardFlairForGame(db, castled.id);
    await awardFlairForGame(db, promoted.id);
    expect(await earned(alice.id)).toEqual([
      ['promotion_win', promoted.id],
      ['queenside_castle_win', castled.id],
    ]);
    expect(await earned(bob.id)).toEqual([]);
  });

  it('gives 🪤 only to the side that was mated', async () => {
    await introduce(['scholars_mate_loss']);
    const { group, alice, bob } = await players();
    const game = await finished(group.id, alice.id, bob.id, 2, '1-0', {
      line: LINES.scholarsMateQh5,
      over: { endReason: 'checkmate' },
    });
    await awardFlairForGame(db, game.id);
    expect(await earned(bob.id)).toEqual([['scholars_mate_loss', game.id]]);
    expect(await earned(alice.id)).toEqual([]);
  });

  it('awards 🔥 at the fifth rated win in a row, skipping a casual game between', async () => {
    await introduce(['win_streak_5']);
    const { group, alice, bob } = await players();
    const plan = [
      [2, '1-0', true],
      [3, '1-0', true],
      [4, '0-1', false],
      [5, '1-0', true],
      [6, '1-0', true],
      [7, '1-0', true],
    ] as const;
    const played: GameRow[] = [];
    for (const [d, result, rated] of plan)
      played.push(await finished(group.id, alice.id, bob.id, d, result, { over: { rated } }));
    for (const game of played.slice(0, 5)) await awardFlairForGame(db, game.id);
    expect(await earned(alice.id)).toEqual([]);
    await awardFlairForGame(db, played[5]!.id);
    expect(await earned(alice.id)).toEqual([['win_streak_5', played[5]!.id]]);
  });

  it('awards 🤝 at the tenth draw, rated or casual', async () => {
    await introduce(['draws_10']);
    const { group, alice, bob } = await players();
    const draws: GameRow[] = [];
    for (let d = 2; d <= 11; d += 1)
      draws.push(
        await finished(group.id, alice.id, bob.id, d, '1/2-1/2', { over: { rated: d % 2 === 0 } }),
      );
    for (const game of draws.slice(0, 9)) await awardFlairForGame(db, game.id);
    expect(await earned(alice.id)).toEqual([]);
    await awardFlairForGame(db, draws[9]!.id);
    expect(await earned(alice.id)).toEqual([['draws_10', draws[9]!.id]]);
    expect(await earned(bob.id)).toEqual([['draws_10', draws[9]!.id]]);
  });

  it('gives each player the rung of the rating a rated game left them at', async () => {
    await introduce(LADDER);
    const { group, alice, bob } = await players();
    const game = await finished(group.id, alice.id, bob.id, 2, '1-0', {
      over: { whiteRatingAfter: 1612.4, blackRatingAfter: 1449.5 },
    });
    await awardFlairForGame(db, game.id);
    expect(await earned(alice.id)).toEqual([['rank_1600', game.id]]);
    expect(await earned(bob.id)).toEqual([['rank_1400', game.id]]);
    const [row] = await db.select().from(userFlair).where(eq(userFlair.userId, alice.id));
    expect(row!.earnedAt).toEqual(day(2));
    expect(await worn(alice.id)).toEqual(['rank_1600']);
  });

  it('counts only games that finished after a flair was introduced, even toward a streak', async () => {
    const { group, alice, bob } = await players();
    await introduce(['en_passant_win', 'win_streak_5'], day(5));
    const wins: GameRow[] = [];
    for (const d of [2, 3, 4, 6, 7, 8, 9, 10])
      wins.push(
        await finished(group.id, alice.id, bob.id, d, '1-0', {
          line: d === 3 ? LINES.enPassant : [],
        }),
      );
    for (const game of wins.slice(0, 7)) await awardFlairForGame(db, game.id);
    expect(await earned(alice.id)).toEqual([]);
    await awardFlairForGame(db, wins[7]!.id);
    expect(await earned(alice.id)).toEqual([['win_streak_5', wins[7]!.id]]);
  });

  it('stores every new flair but fills only the free slots, picking at random', async () => {
    await introduce(['en_passant_win', 'rank_1600']);
    const { group, alice, bob } = await players(['rank_1500', 'draws_10']);
    const game = await finished(group.id, alice.id, bob.id, 2, '1-0', {
      line: LINES.enPassant,
      over: { whiteRatingAfter: 1650 },
    });
    await awardFlairForGame(db, game.id, () => 0.99);
    expect(await earned(alice.id)).toEqual([
      ['en_passant_win', game.id],
      ['rank_1600', game.id],
    ]);
    expect(await worn(alice.id)).toEqual(['rank_1500', 'draws_10', 'en_passant_win']);
  });

  it('changes nothing when it runs again', async () => {
    await introduce(['en_passant_win']);
    const { group, alice, bob } = await players();
    const game = await finished(group.id, alice.id, bob.id, 2, '1-0', { line: LINES.enPassant });
    await awardFlairForGame(db, game.id);
    await db.update(users).set({ flairWorn: [] }).where(eq(users.id, alice.id));
    await awardFlairForGame(db, game.id);
    expect(await earned(alice.id)).toEqual([['en_passant_win', game.id]]);
    expect(await worn(alice.id)).toEqual([]);
  });

  it('keeps flair when its game is voided later, and awards nothing for a game voided before its job ran', async () => {
    await introduce(['en_passant_win', 'queenside_castle_win']);
    const { group, alice, bob } = await players();
    const kept = await finished(group.id, alice.id, bob.id, 2, '1-0', { line: LINES.enPassant });
    await awardFlairForGame(db, kept.id);
    await db
      .update(games)
      .set({ voidedAt: day(3) })
      .where(eq(games.id, kept.id));
    const voided = await finished(group.id, alice.id, bob.id, 4, '1-0', {
      line: LINES.bothCastleQueenside,
      over: { voidedAt: day(4) },
    });
    await awardFlairForGame(db, voided.id);
    expect(await earned(alice.id)).toEqual([['en_passant_win', kept.id]]);
  });

  it('awards a streak it missed at the player’s next rated win', async () => {
    await introduce(['win_streak_5']);
    const { group, alice, bob } = await players();
    const wins: GameRow[] = [];
    for (let d = 2; d <= 7; d += 1) wins.push(await finished(group.id, alice.id, bob.id, d, '1-0'));
    for (const game of [...wins.slice(0, 4), wins[5]!]) await awardFlairForGame(db, game.id);
    expect(await earned(alice.id)).toEqual([['win_streak_5', wins[5]!.id]]);
  });

  it('skips a player who deleted their data', async () => {
    await introduce(['scholars_mate_loss', ...LADDER]);
    const { group, alice, bob } = await players();
    await db
      .update(users)
      .set({ deletedAt: day(3) })
      .where(eq(users.id, bob.id));
    const game = await finished(group.id, alice.id, bob.id, 2, '1-0', {
      line: LINES.scholarsMateQh5,
      over: { endReason: 'checkmate', whiteRatingAfter: 1612 },
    });
    await awardFlairForGame(db, game.id);
    expect(await earned(bob.id)).toEqual([]);
    expect(await earned(alice.id)).toEqual([['rank_1600', game.id]]);
  });

  // Each flair sees only games from its own introduction (spec §1.5), so these introduce their
  // flair on different days, where the tests above introduce theirs at the launch. A player's games
  // load from the earliest introduction among their candidates (spec §3.2), so each test also has
  // a flair introduced at the launch: the earlier games are then loaded, and only each flair's own
  // window keeps them from it.

  it('awards a flair only for games that finished at or after its introduction', async () => {
    const { group, alice, bob } = await players();
    await introduce(['draws_10']); // at the launch; no win can earn it
    await introduce(['queenside_castle_win'], day(5));
    await introduce(['en_passant_win'], day(10));
    const castle = { line: LINES.bothCastleQueenside };
    const early = await finished(group.id, alice.id, bob.id, 4, '1-0', castle);
    const atIntroduction = await finished(group.id, alice.id, bob.id, 5, '1-0', castle);
    const beforeLater = await finished(group.id, alice.id, bob.id, 6, '1-0', {
      line: LINES.enPassant,
    });
    for (const game of [early, atIntroduction, beforeLater]) await awardFlairForGame(db, game.id);
    // Not from the game the day before 🏰 was introduced, nor from an en passant win before 👑 was.
    expect(await earned(alice.id)).toEqual([['queenside_castle_win', atIntroduction.id]]);
  });

  it('starts a streak at the flair’s own introduction, counting a game at that very instant', async () => {
    const { group, alice, bob } = await players();
    await introduce(['draws_10']); // at the launch; no win can earn it
    await introduce(['win_streak_5'], day(6));
    const wins: GameRow[] = [];
    for (let d = 2; d <= 10; d += 1)
      wins.push(await finished(group.id, alice.id, bob.id, d, '1-0'));
    for (const game of wins.slice(0, 8)) await awardFlairForGame(db, game.id);
    // Eight wins in a row, but only the four from day 6 on are in 🔥's window.
    expect(await earned(alice.id)).toEqual([]);
    await awardFlairForGame(db, wins[8]!.id);
    // Days 6 to 10 are five, the first of them a game that finished when 🔥 was introduced.
    expect(await earned(alice.id)).toEqual([['win_streak_5', wins[8]!.id]]);
  });

  it('gives a flair introduced earlier its whole history when another was introduced later', async () => {
    const { group, alice, bob } = await players();
    await introduce(['draws_10']);
    await introduce(['win_streak_5'], day(9));
    const draws: GameRow[] = [];
    for (let d = 2; d <= 11; d += 1)
      draws.push(await finished(group.id, alice.id, bob.id, d, '1/2-1/2'));
    for (const game of draws) await awardFlairForGame(db, game.id);
    // 🔥 is a candidate at the last three games, but that does not shorten the draws 🤝 counts.
    expect(await earned(alice.id)).toEqual([['draws_10', draws[9]!.id]]);
  });

  it('waits for a change to the worn list in flight, and awards with the colours reversed do not deadlock', async () => {
    await introduce(['queenside_castle_win', 'en_passant_win']);
    const { group, alice, bob } = await players();
    // Alice has White in the first game and Black in the second; Bob the other way round.
    const first = await finished(group.id, alice.id, bob.id, 2, '1-0', {
      line: LINES.bothCastleQueenside,
    });
    const second = await finished(group.id, bob.id, alice.id, 3, '1-0', { line: LINES.enPassant });
    // While Alice's change is in flight, the first award queues for her row. Locking one player at
    // a time, the second would take Bob's row (he has White) and queue behind it for hers, and once
    // the change committed the first would want Bob's row: a deadlock.
    const put = await startWearing(alice.id, ['rank_1500']);
    const awards: Promise<void>[] = [];
    try {
      awards.push(db.transaction((tx) => awardFlairForGame(tx, first.id)));
      await waitForLockWaiters(1);
      awards.push(db.transaction((tx) => awardFlairForGame(tx, second.id)));
      await waitForLockWaiters(2);
    } finally {
      put.commit();
      await Promise.allSettled([put.done, ...awards]);
    }
    await Promise.all([put.done, ...awards]);
    expect(await earned(alice.id)).toEqual([['queenside_castle_win', first.id]]);
    expect(await earned(bob.id)).toEqual([['en_passant_win', second.id]]);
    // The award fills slots from the list the change left (spec §6).
    expect(await worn(alice.id)).toEqual(['rank_1500', 'queenside_castle_win']);
  });
});
