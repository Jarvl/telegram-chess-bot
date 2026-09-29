import { FlairDtoSchema } from '@group-chess/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { userFlair, users, type UserRow } from '../../src/db/schema';
import { startTestApi, type TestApi } from '../helpers/api';
import { openTestDb, truncateAll } from '../helpers/db';
import { insertGame, insertGroup, insertUser } from '../helpers/fixtures';

const { db, close } = openTestDb();
let api: TestApi;

beforeAll(async () => {
  api = await startTestApi(db);
});
beforeEach(async () => {
  await truncateAll(db);
  api.fake.reset();
  api.ctx.rateLimiter.reset();
  api.ctx.tipLimiter.reset();
});
afterAll(async () => {
  await api.stop();
  await close();
});

const AUG_12 = new Date('2026-08-12T12:00:00.000Z');
const AUG_13 = new Date('2026-08-13T12:00:00.000Z');

/** Alice earned `ids` in a game against @bob and wears `worn`. */
async function setup(ids = ['rank_1500', 'en_passant_win'], worn = ['en_passant_win']) {
  const group = await insertGroup(db);
  const alice = await insertUser(db, { username: 'alice', flairWorn: worn });
  const bob = await insertUser(db, { username: 'bob' });
  const game = await insertGame(db, group.id, alice.id, bob.id, {
    status: 'finished',
    result: '1-0',
    endReason: 'resignation',
    finishedAt: AUG_12,
    plyCount: 20,
  });
  await db
    .insert(userFlair)
    .values(
      ids.map((flairId) => ({ userId: alice.id, flairId, gameId: game.id, earnedAt: AUG_12 })),
    );
  return { alice, bob, game, token: await api.sessionFor(alice) };
}

const wornOf = async (user: Pick<UserRow, 'id'>) =>
  (await db.select({ worn: users.flairWorn }).from(users).where(eq(users.id, user.id)))[0]!.worn;

/**
 * Resolves once exactly `count` sessions of this database are waiting for a lock.
 * (`pg_stat_activity` covers the whole server, and other test databases share it.) It mirrors the
 * helper in `flair-award.test.ts` without its `for update` filter, because `DELETE /api/me` waits
 * in an `update`.
 */
async function waitForLockWaiters(count: number): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const [row] = await db.execute(sql`
      select count(*)::int as waiting from pg_stat_activity
      where datname = current_database() and state = 'active' and wait_event_type = 'Lock'`);
    if (row?.waiting === count) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${count} session(s) never came to wait for a lock`);
}

/**
 * An award in flight (flair spec §3.2). Like `awardFlairForGame` it takes the player's row lock
 * first and holds it until `commit()` is called, then stores `flairId` as earned in `gameId`,
 * appends it to the worn list it read under the lock, and commits.
 */
async function startAward(userId: number, gameId: number, flairId: string) {
  let commit!: () => void;
  const mayCommit = new Promise<void>((resolve) => (commit = resolve));
  let holding!: () => void;
  const isHolding = new Promise<void>((resolve) => (holding = resolve));
  const done = db.transaction(async (tx) => {
    const [row] = await tx
      .select({ worn: users.flairWorn })
      .from(users)
      .where(eq(users.id, userId))
      .for('update');
    holding();
    await mayCommit;
    await tx.insert(userFlair).values({ userId, flairId, gameId, earnedAt: AUG_12 });
    await tx
      .update(users)
      .set({ flairWorn: [...row!.worn, flairId] })
      .where(eq(users.id, userId));
  });
  await Promise.race([isHolding, done]);
  return { commit, done };
}

/**
 * Sends a request while an award for `userId` holds the player's row, and answers once the award
 * has committed. The award commits only after the request has queued behind its lock, which fixes
 * the order without sleeping. Whatever happens while waiting, the `finally` commits the award and
 * waits for the request, so no lock stays held and no request runs on into the next test.
 */
async function requestBehindAward(
  award: { userId: number; gameId: number; flairId: string },
  send: () => Promise<Response>,
): Promise<Response> {
  const inFlight = await startAward(award.userId, award.gameId, award.flairId);
  let pending: Promise<Response> | undefined;
  try {
    pending = send();
    await waitForLockWaiters(1);
  } finally {
    inFlight.commit();
    await Promise.allSettled([inFlight.done, pending]);
  }
  await inFlight.done;
  return pending;
}

describe('GET /api/me/flair', () => {
  it('lists worn and earned flair in catalog order, with the earning game’s opponent', async () => {
    const { token } = await setup();
    const res = await api.request('GET', '/api/me/flair', { token });
    expect(res.status).toBe(200);
    expect(FlairDtoSchema.parse(await res.json())).toEqual({
      worn: ['en_passant_win'],
      earned: [
        { id: 'rank_1500', earnedAt: AUG_12.toISOString(), opponent: '@bob' },
        { id: 'en_passant_win', earnedAt: AUG_12.toISOString(), opponent: '@bob' },
      ],
    });
  });
  it('names a deleted opponent and leaves out flair the catalog no longer has', async () => {
    const { bob, token } = await setup(
      ['draws_10', 'retired_flair'],
      ['retired_flair', 'draws_10'],
    );
    await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, bob.id));
    expect(
      FlairDtoSchema.parse(await (await api.request('GET', '/api/me/flair', { token })).json()),
    ).toEqual({
      worn: ['draws_10'],
      earned: [{ id: 'draws_10', earnedAt: AUG_12.toISOString(), opponent: 'Deleted player' }],
    });
  });
  it('needs a session', async () =>
    expect((await api.request('GET', '/api/me/flair')).status).toBe(401));
});

describe('PUT /api/me/flair', () => {
  it('saves the worn list in slot order and answers with the flair', async () => {
    const { alice, token } = await setup();
    const res = await api.request('PUT', '/api/me/flair', {
      token,
      body: { worn: ['rank_1500', 'en_passant_win'] },
    });
    expect(res.status).toBe(200);
    expect(FlairDtoSchema.parse(await res.json()).worn).toEqual(['rank_1500', 'en_passant_win']);
    expect(await wornOf(alice)).toEqual(['rank_1500', 'en_passant_win']);
  });
  it('empties the slots for an empty list', async () => {
    const { alice, token } = await setup();
    expect((await api.request('PUT', '/api/me/flair', { token, body: { worn: [] } })).status).toBe(
      200,
    );
    expect(await wornOf(alice)).toEqual([]);
  });
  it.each([
    ['more than three', ['rank_1500', 'en_passant_win', 'draws_10', 'promotion_win']],
    ['a duplicate', ['rank_1500', 'rank_1500']],
    ['an id not in the catalog', ['retired_flair']],
    ['a flair not earned', ['rank_1800']],
  ])('refuses %s and keeps the slots', async (_, worn) => {
    const { alice, token } = await setup([
      'rank_1500',
      'en_passant_win',
      'draws_10',
      'promotion_win',
      'retired_flair',
    ]);
    const res = await api.request('PUT', '/api/me/flair', { token, body: { worn } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'validation' } });
    expect(await wornOf(alice)).toEqual(['en_passant_win']);
  });
});

describe('DELETE /api/me', () => {
  it('deletes earned flair and empties the slots', async () => {
    const { alice, token } = await setup();
    expect((await api.request('DELETE', '/api/me', { token })).status).toBe(200);
    expect(await db.select().from(userFlair).where(eq(userFlair.userId, alice.id))).toEqual([]);
    expect(await wornOf(alice)).toEqual([]);
  });
});

// The two blocks below add what the tests above leave open: the join names the other player for
// either colour, and the order of the row lock and the reads and writes in `setWornFlair` and
// `deleteMyData` (flair spec §3.4, §4 and §6).

describe('GET /api/me/flair for a game played with either colour', () => {
  it('names the other player of each earning game, whichever colour the player had', async () => {
    const group = await insertGroup(db);
    const alice = await insertUser(db, { username: 'alice' });
    const bob = await insertUser(db, { username: 'bob' });
    const carol = await insertUser(db, { username: 'carol' });
    const finished = (whiteId: number, blackId: number, result: '1-0' | '0-1', finishedAt: Date) =>
      insertGame(db, group.id, whiteId, blackId, {
        status: 'finished',
        result,
        endReason: 'resignation',
        finishedAt,
        plyCount: 20,
      });
    // Alice won as Black against Bob, who had White, and as White against Carol, who had Black.
    const asBlack = await finished(bob.id, alice.id, '0-1', AUG_12);
    const asWhite = await finished(alice.id, carol.id, '1-0', AUG_13);
    await db.insert(userFlair).values([
      { userId: alice.id, flairId: 'en_passant_win', gameId: asBlack.id, earnedAt: AUG_12 },
      { userId: alice.id, flairId: 'draws_10', gameId: asWhite.id, earnedAt: AUG_13 },
    ]);
    const res = await api.request('GET', '/api/me/flair', { token: await api.sessionFor(alice) });
    expect(res.status).toBe(200);
    expect(FlairDtoSchema.parse(await res.json()).earned).toEqual([
      { id: 'en_passant_win', earnedAt: AUG_12.toISOString(), opponent: '@bob' },
      { id: 'draws_10', earnedAt: AUG_13.toISOString(), opponent: '@carol' },
    ]);
  });
});

describe('a request that arrives while an award for the player is in flight', () => {
  it('DELETE /api/me waits for the award and then leaves no flair behind', async () => {
    const { alice, game, token } = await setup();
    // The award commits a `user_flair` row after the deletion has queued. Deleting the rows before
    // taking the row lock would miss it, and the deleted player would keep the flair.
    const res = await requestBehindAward(
      { userId: alice.id, gameId: game.id, flairId: 'draws_10' },
      () => api.request('DELETE', '/api/me', { token }),
    );
    expect(res.status).toBe(200);
    expect(await db.select().from(userFlair).where(eq(userFlair.userId, alice.id))).toEqual([]);
    expect(await wornOf(alice)).toEqual([]);
  });

  it('PUT /api/me/flair waits for the award and then wears the flair it committed', async () => {
    const { alice, game, token } = await setup();
    // Reading the earned ids before taking the row lock would miss `draws_10` and refuse it.
    const res = await requestBehindAward(
      { userId: alice.id, gameId: game.id, flairId: 'draws_10' },
      () =>
        api.request('PUT', '/api/me/flair', {
          token,
          body: { worn: ['draws_10', 'en_passant_win'] },
        }),
    );
    expect(res.status).toBe(200);
    const flair = FlairDtoSchema.parse(await res.json());
    expect(flair.worn).toEqual(['draws_10', 'en_passant_win']);
    expect(flair.earned.map(({ id }) => id)).toEqual(['rank_1500', 'en_passant_win', 'draws_10']);
    expect(await wornOf(alice)).toEqual(['draws_10', 'en_passant_win']);
  });
});
