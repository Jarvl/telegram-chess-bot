import { GameDtoSchema } from '@group-chess/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { games } from '../../src/db/schema';
import { touchMember } from '../../src/domain/members';
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
  api.ctx.membership.clearCaches();
  api.ctx.rateLimiter.reset();
});
afterAll(async () => {
  await api.stop();
  await close();
});

async function world() {
  const group = await insertGroup(db, { telegramChatId: -1001000000004 });
  const alice = await insertUser(db, { telegramUserId: 11, firstName: 'Alice' });
  const bob = await insertUser(db, { telegramUserId: 22, firstName: 'Bob' });
  const carol = await insertUser(db, { telegramUserId: 33, firstName: 'Carol' });
  for (const user of [alice, bob, carol])
    await touchMember(db, group.id, user.id, { verified: true });
  // Alice is White and to move; Bob premoves.
  const game = await insertGame(db, group.id, alice.id, bob.id);
  const tokens = {
    alice: await api.sessionFor(alice),
    bob: await api.sessionFor(bob),
    carol: await api.sessionFor(carol),
  };
  return { group, alice, bob, carol, game, tokens };
}

const put = (token: string, gameId: string, body: unknown) =>
  api.request('PUT', `/api/games/${gameId}/premoves`, { token, body });
const errorCode = async (res: Response) =>
  ((await res.json()) as { error: { code: string } }).error.code;
const stored = async (id: number) => (await db.select().from(games).where(eq(games.id, id)))[0]!;

describe('PUT /api/games/:id/premoves', () => {
  it('queues, extends, truncates and clears the chain without bumping the version', async () => {
    const { game, tokens } = await world();
    let res = await put(tokens.bob, game.publicId, {
      base: [],
      premoves: ['e7e5'],
      expectedPly: 0,
    });
    expect(res.status).toBe(200);
    expect(GameDtoSchema.parse(await res.json()).premoves).toEqual(['e7e5']);
    res = await put(tokens.bob, game.publicId, {
      base: ['e7e5'],
      premoves: ['e7e5', 'g8f6'],
      expectedPly: 0,
    });
    expect(GameDtoSchema.parse(await res.json()).premoves).toEqual(['e7e5', 'g8f6']);
    await put(tokens.bob, game.publicId, {
      base: ['e7e5', 'g8f6'],
      premoves: ['e7e5'],
      expectedPly: 0,
    });
    expect((await stored(game.id)).premoves).toEqual(['e7e5']);
    res = await put(tokens.bob, game.publicId, { base: ['e7e5'], premoves: [], expectedPly: 0 });
    expect(res.status).toBe(200);
    expect(await stored(game.id)).toMatchObject({ premoves: [], version: 0 });
  });

  it('accepts a long chain', async () => {
    const { game, tokens } = await world();
    const shuffle = Array.from({ length: 50 }, (_, i) => (i % 2 === 0 ? 'g8f6' : 'f6g8'));
    const res = await put(tokens.bob, game.publicId, {
      base: [],
      premoves: shuffle,
      expectedPly: 0,
    });
    expect(res.status).toBe(200);
    expect((await stored(game.id)).premoves).toHaveLength(50);
  });

  it('refuses the player to move, a stale ply, a stale base and an off-pattern premove', async () => {
    const { game, tokens } = await world();
    expect(
      await errorCode(
        await put(tokens.alice, game.publicId, { base: [], premoves: ['e2e4'], expectedPly: 0 }),
      ),
    ).toBe('not_your_turn');
    expect(
      await errorCode(
        await put(tokens.bob, game.publicId, { base: [], premoves: ['e7e5'], expectedPly: 3 }),
      ),
    ).toBe('stale_state');
    await put(tokens.bob, game.publicId, { base: [], premoves: ['e7e5'], expectedPly: 0 });
    // Another device already queued e5; this one still shows an empty chain.
    const stale = await put(tokens.bob, game.publicId, {
      base: [],
      premoves: ['d7d5'],
      expectedPly: 0,
    });
    expect(stale.status).toBe(409);
    expect(await errorCode(stale)).toBe('stale_state');
    expect((await stored(game.id)).premoves).toEqual(['e7e5']);
    const bad = await put(tokens.bob, game.publicId, {
      base: ['e7e5'],
      premoves: ['e7e5', 'e7e6'],
      expectedPly: 0,
    });
    expect(await errorCode(bad)).toBe('illegal_move');
  });

  it('checks an edit only from where it changes the stored chain', async () => {
    const { game, tokens } = await world();
    // A stored entry the position has since outgrown (here: never on the pattern at all). It is
    // cancelled when it comes up; until then it must not block the edits made after it.
    await db
      .update(games)
      .set({ premoves: ['e7e4'] })
      .where(eq(games.id, game.id));
    const appended = await put(tokens.bob, game.publicId, {
      base: ['e7e4'],
      premoves: ['e7e4', 'g8f6'],
      expectedPly: 0,
    });
    expect(appended.status).toBe(200);
    expect((await stored(game.id)).premoves).toEqual(['e7e4', 'g8f6']);
    const truncated = await put(tokens.bob, game.publicId, {
      base: ['e7e4', 'g8f6'],
      premoves: ['e7e4'],
      expectedPly: 0,
    });
    expect(truncated.status).toBe(200);
    expect((await stored(game.id)).premoves).toEqual(['e7e4']);
    // An appended entry is still checked, on the board the unchecked ones left.
    const badAppend = await put(tokens.bob, game.publicId, {
      base: ['e7e4'],
      premoves: ['e7e4', 'e4e2'],
      expectedPly: 0,
    });
    expect(await errorCode(badAppend)).toBe('illegal_move');
    // So is an early entry the edit changes, and everything after it.
    const badEdit = await put(tokens.bob, game.publicId, {
      base: ['e7e4'],
      premoves: ['e7e3'],
      expectedPly: 0,
    });
    expect(await errorCode(badEdit)).toBe('illegal_move');
    const removed = await put(tokens.bob, game.publicId, {
      base: ['e7e4'],
      premoves: [],
      expectedPly: 0,
    });
    expect(removed.status).toBe(200);
    expect(await stored(game.id)).toMatchObject({ premoves: [], version: 0 });
  });

  it('refuses spectators and finished games', async () => {
    const { game, tokens } = await world();
    expect(
      (await put(tokens.carol, game.publicId, { base: [], premoves: ['e7e5'], expectedPly: 0 }))
        .status,
    ).toBe(403);
    await api.request('POST', `/api/games/${game.publicId}/resign`, { token: tokens.alice });
    expect(
      await errorCode(
        await put(tokens.bob, game.publicId, { base: [], premoves: ['e7e5'], expectedPly: 0 }),
      ),
    ).toBe('stale_state');
  });

  it('pushes an edit to the owner’s streams only, and publishes nothing for a no-op', async () => {
    const { game, bob, tokens } = await world();
    const heard: unknown[] = [];
    api.deps.bus.subscribe(game.publicId, (audience) => heard.push(audience));
    await put(tokens.bob, game.publicId, { base: [], premoves: ['e7e5'], expectedPly: 0 });
    await put(tokens.bob, game.publicId, { base: ['e7e5'], premoves: ['e7e5'], expectedPly: 0 });
    expect(heard).toEqual([{ userId: bob.id }]);
  });

  it('gives a reconnecting device the current chain even with a current Last-Event-ID', async () => {
    const { game, tokens } = await world();
    const firstState = async (headers: Record<string, string> = {}) => {
      const controller = new AbortController();
      const res = await api.request(
        'GET',
        `/api/games/${game.publicId}/events?token=${tokens.bob}`,
        {
          signal: controller.signal,
          headers,
        },
      );
      const reader = res.body!.getReader();
      const chunk = new TextDecoder().decode((await reader.read()).value);
      controller.abort();
      return chunk;
    };
    await put(tokens.bob, game.publicId, { base: [], premoves: ['e7e5'], expectedPly: 0 });
    expect(await firstState({ 'last-event-id': '0' })).toContain('"premoves":["e7e5"]');
  });

  it('delivers an owner-only push that lands while the first snapshot is being read', async () => {
    const { game, bob, tokens } = await world();
    // Fire the push at the exact moment the stream first reaches for the database after opening:
    // the snapshot's DTO read. Arming on the stream gauge keeps the auth and access reads out of it.
    const realDb = api.deps.db;
    let armed = false;
    const gauge = api.ctx.metrics.sseStreams;
    const inc = gauge.inc.bind(gauge);
    const spy = vi.spyOn(gauge, 'inc').mockImplementation((...args) => {
      armed = true;
      inc(...args);
    });
    Object.defineProperty(api.deps, 'db', {
      configurable: true,
      get: () => {
        if (armed) {
          armed = false;
          api.deps.bus.publish(game.publicId, { userId: bob.id });
        }
        return realDb;
      },
    });
    const controller = new AbortController();
    try {
      const res = await api.request(
        'GET',
        `/api/games/${game.publicId}/events?token=${tokens.bob}`,
        { signal: controller.signal },
      );
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let received = '';
      // A lost push leaves this waiting for a second state that never comes (the test times out).
      while (received.split('event: state').length - 1 < 2)
        received += decoder.decode((await reader.read()).value);
      expect(armed).toBe(false);
      expect(received.split('event: state').length - 1).toBe(2);
    } finally {
      controller.abort();
      spy.mockRestore();
      Object.defineProperty(api.deps, 'db', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: realDb,
      });
    }
  }, 3_000);
});
