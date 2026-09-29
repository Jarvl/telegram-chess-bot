import { FLAIR } from '@group-chess/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { flairIntroductions, games, users } from '../../src/db/schema';
import { isCountedGame, loadCountedGames } from '../../src/flair/history';
import { loadIntroductions, recordFlairIntroductions } from '../../src/flair/introductions';
import { openTestDb, truncateAll } from '../helpers/db';
import { insertGame, insertGroup, insertUser, type GameOverrides } from '../helpers/fixtures';

const { db, close } = openTestDb();

beforeEach(() => truncateAll(db));
afterAll(() => close());

const day = (n: number) => new Date(Date.UTC(2026, 1, n, 12));

describe('recordFlairIntroductions', () => {
  it('records every catalog flair once and keeps the first date', async () => {
    await recordFlairIntroductions(db);
    expect([...(await loadIntroductions(db)).keys()].sort()).toEqual(FLAIR.map((f) => f.id).sort());
    await db
      .update(flairIntroductions)
      .set({ introducedAt: day(1) })
      .where(eq(flairIntroductions.flairId, 'draws_10'));
    await recordFlairIntroductions(db);
    expect((await loadIntroductions(db)).get('draws_10')).toEqual(day(1));
  });
});

describe('isCountedGame', () => {
  const decided = { status: 'finished', voidedAt: null, result: '1-0', engineLevel: null } as const;
  it('counts a finished, decided game against a person', () => {
    expect(isCountedGame(decided)).toBe(true);
    expect(isCountedGame({ ...decided, result: '1/2-1/2' })).toBe(true);
  });
  it('leaves out aborts, voids, bot games and running games', () => {
    expect(isCountedGame({ ...decided, result: '*' })).toBe(false);
    expect(isCountedGame({ ...decided, voidedAt: day(2) })).toBe(false);
    expect(isCountedGame({ ...decided, engineLevel: 'beginner' })).toBe(false);
    expect(isCountedGame({ ...decided, status: 'active', result: null })).toBe(false);
  });
});

describe('loadCountedGames', () => {
  it('lists a player’s counted games in the window, oldest first, from their side', async () => {
    const group = await insertGroup(db);
    const alice = await insertUser(db);
    const bob = await insertUser(db);
    const [engine] = await db.select().from(users).where(eq(users.isEngine, true));
    const end = (whiteId: number, blackId: number, d: number, over: GameOverrides = {}) =>
      insertGame(db, group.id, whiteId, blackId, {
        status: 'finished',
        result: '1-0',
        endReason: 'resignation',
        finishedAt: day(d),
        plyCount: 20,
        ...over,
      });
    await end(alice.id, bob.id, 1);
    const win = await end(alice.id, bob.id, 2, { whiteRatingAfter: 1612.4 });
    const draw = await end(bob.id, alice.id, 3, { rated: false, result: '1/2-1/2' });
    await end(alice.id, bob.id, 4, { result: '*', endReason: 'abort' });
    await end(alice.id, bob.id, 5, { voidedAt: day(6) });
    await end(alice.id, engine!.id, 5, { rated: false, engineLevel: 'beginner' });
    const loss = await end(bob.id, alice.id, 7, { blackRatingAfter: 1590.2 });
    await end(alice.id, bob.id, 9);
    const rows = await loadCountedGames(db, alice.id, { from: day(2), through: loss });
    expect(rows.map((r) => [r.id, r.result, r.rated, r.ratingAfter])).toEqual([
      [win.id, 'win', true, 1612.4],
      [draw.id, 'draw', false, null],
      [loss.id, 'loss', true, 1590.2],
    ]);
  });

  it('orders by finish time, breaks a tie by id and cuts through at the same pair', async () => {
    const group = await insertGroup(db);
    const alice = await insertUser(db);
    const bob = await insertUser(db);
    const carol = await insertUser(db);
    const end = (whiteId: number, blackId: number, d: number) =>
      insertGame(db, group.id, whiteId, blackId, {
        status: 'finished',
        result: '1-0',
        endReason: 'resignation',
        finishedAt: day(d),
        plyCount: 20,
      });
    // The game started first finishes last. The rest finish at the same instant, and one of them is
    // between two other players.
    const last = await end(alice.id, bob.id, 4);
    const first = await end(alice.id, bob.id, 3);
    await end(bob.id, carol.id, 3);
    const second = await end(bob.id, alice.id, 3);
    const third = await end(alice.id, bob.id, 3);
    // Rewrite `first` so the table holds it behind the others: a tie not broken by id would then
    // come back out of order. `black_id` is indexed, so this is not a heap-only update, which index
    // and bitmap scans would still read in `first`'s old place.
    await db.update(games).set({ blackId: carol.id }).where(eq(games.id, first.id));
    const idsThrough = async (through: typeof last) =>
      (await loadCountedGames(db, alice.id, { from: day(1), through })).map((r) => r.id);
    expect(await idsThrough(last)).toEqual([first.id, second.id, third.id, last.id]);
    expect(await idsThrough(second)).toEqual([first.id, second.id]);
  });

  it('refuses a through game that has no finish time', async () => {
    await expect(
      loadCountedGames(db, 1, { from: day(1), through: { id: 1, finishedAt: null } }),
    ).rejects.toThrow('game 1 has no finish time');
  });
});
