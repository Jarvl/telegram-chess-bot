import {
  ChallengeDtoSchema,
  GameDtoSchema,
  LobbyDtoSchema,
  PlayerPageDtoSchema,
} from '@group-chess/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminActions, groupMembers, jobs, shares } from '../../src/db/schema';
import { touchMember } from '../../src/domain/members';
import { startTestApi, type TestApi } from '../helpers/api';
import { openTestDb, truncateAll } from '../helpers/db';
import { insertGame, insertGroup, insertMove, insertUser } from '../helpers/fixtures';

const { db, close } = openTestDb();
let api: TestApi;
const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';

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
  const group = await insertGroup(db, { telegramChatId: -1001000000003 });
  const alice = await insertUser(db, { telegramUserId: 11, firstName: 'Alice' });
  const bob = await insertUser(db, { telegramUserId: 22, firstName: 'Bob' });
  const carol = await insertUser(db, { telegramUserId: 33, firstName: 'Carol' });
  const dave = await insertUser(db, { telegramUserId: 44, firstName: 'Dave' });
  for (const user of [alice, bob, carol])
    await touchMember(db, group.id, user.id, { verified: true });
  const tokens = {
    alice: await api.sessionFor(alice),
    bob: await api.sessionFor(bob),
    carol: await api.sessionFor(carol),
    dave: await api.sessionFor(dave),
  };
  return { group, alice, bob, carol, dave, tokens };
}

const move = (token: string, gameId: string, uci: string, expectedPly: number) =>
  api.request('POST', `/api/games/${gameId}/moves`, {
    token,
    body: {
      uci,
      expectedPly,
      clientMoveId: `m-${uci}-${expectedPly}-${Math.random().toString(36).slice(2)}`,
    },
  });

describe('challenges and lobby', () => {
  it('creates, accepts and lists a game through the API', async () => {
    const { group, alice, bob, tokens } = await world();
    const created = await api.request('POST', `/api/groups/${group.publicId}/challenges`, {
      token: tokens.alice,
      body: { opponentId: String(bob.id), timePerMove: 3600, colour: 'white', rated: true },
    });
    expect(created.status).toBe(200);
    const challenge = ChallengeDtoSchema.parse(await created.json());
    expect(challenge.viewer).toEqual({ canAccept: false, canDecline: false, canCancel: true });
    const accepted = await api.request('POST', `/api/challenges/${challenge.id}/accept`, {
      token: tokens.bob,
    });
    expect(accepted.status).toBe(200);
    const game = GameDtoSchema.parse(await accepted.json());
    expect(game.white.id).toBe(String(alice.id));
    const lobby = LobbyDtoSchema.parse(
      await (
        await api.request('GET', `/api/groups/${group.publicId}`, { token: tokens.alice })
      ).json(),
    );
    expect(lobby.active.map((g) => [g.id, g.yourTurn])).toEqual([[game.id, true]]);
    expect(lobby.challenges).toEqual([]);
  });

  it('refuses the lobby to a non-member and lists known players for the picker', async () => {
    const { group, tokens } = await world();
    expect(
      (await api.request('GET', `/api/groups/${group.publicId}`, { token: tokens.dave })).status,
    ).toBe(403);
    const players = await (
      await api.request('GET', `/api/groups/${group.publicId}/players`, { token: tokens.alice })
    ).json();
    expect((players as { players: { name: string }[] }).players.map((p) => p.name).sort()).toEqual([
      'Bob',
      'Carol',
    ]);
  });

  it('pages finished games and serves a player page', async () => {
    const { group, alice, bob, tokens } = await world();
    for (let i = 0; i < 25; i += 1) {
      await insertGame(db, group.id, alice.id, bob.id, {
        status: 'finished',
        result: '1-0',
        endReason: 'resignation',
        finishedAt: new Date(Date.UTC(2026, 0, 1 + i)),
      });
    }
    const first = (await (
      await api.request('GET', `/api/groups/${group.publicId}/finished`, { token: tokens.alice })
    ).json()) as { items: unknown[]; nextCursor: string | null };
    expect(first.items).toHaveLength(20);
    expect(first.nextCursor).not.toBeNull();
    const second = (await (
      await api.request(
        'GET',
        `/api/groups/${group.publicId}/finished?cursor=${first.nextCursor}`,
        { token: tokens.alice },
      )
    ).json()) as { items: unknown[]; nextCursor: string | null };
    expect(second.items).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
    const page = PlayerPageDtoSchema.parse(
      await (
        await api.request('GET', `/api/groups/${group.publicId}/players/${bob.id}`, {
          token: tokens.alice,
        })
      ).json(),
    );
    expect(page.headToHead).toEqual({ wins: 25, draws: 0, losses: 0 });
    expect(page.recentGames).toHaveLength(10);
  });
});

describe('games', () => {
  it('plays moves and maps domain errors to statuses', async () => {
    const { group, alice, bob, tokens } = await world();
    const game = await insertGame(db, group.id, alice.id, bob.id);
    const ok = await move(tokens.alice, game.publicId, 'e2e4', 0);
    expect(ok.status).toBe(200);
    expect(GameDtoSchema.parse(await ok.json()).plyCount).toBe(1);
    const stale = await move(tokens.bob, game.publicId, 'e7e5', 0);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: 'stale_state' } });
    expect((await move(tokens.bob, game.publicId, 'e7e9', 1)).status).toBe(400);
    expect((await move(tokens.bob, game.publicId, 'e7e6', 1)).status).toBe(200);
    expect((await move(tokens.carol, game.publicId, 'd2d4', 2)).status).toBe(403);
    expect((await move(tokens.alice, game.publicId, 'e4e6', 2)).status).toBe(422);
  });

  it('offers, declines and accepts draws, resigns and aborts', async () => {
    const { group, alice, bob, tokens } = await world();
    const game = await insertGame(db, group.id, alice.id, bob.id);
    expect(
      (await api.request('POST', `/api/games/${game.publicId}/draw/offer`, { token: tokens.alice }))
        .status,
    ).toBe(200);
    expect(
      (await api.request('POST', `/api/games/${game.publicId}/draw/decline`, { token: tokens.bob }))
        .status,
    ).toBe(200);
    expect(
      (await api.request('POST', `/api/games/${game.publicId}/abort`, { token: tokens.bob }))
        .status,
    ).toBe(200);
    const second = await insertGame(db, group.id, alice.id, bob.id, {
      fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2',
      plyCount: 2,
    });
    const resigned = GameDtoSchema.parse(
      await (
        await api.request('POST', `/api/games/${second.publicId}/resign`, { token: tokens.alice })
      ).json(),
    );
    expect(resigned).toMatchObject({ status: 'finished', result: '0-1', endReason: 'resignation' });
    expect(resigned.analysisUrl).toBeUndefined();
  });

  it('shares a position once a minute and serves the PGN', async () => {
    const { group, alice, bob, tokens } = await world();
    const game = await insertGame(db, group.id, alice.id, bob.id, { fen: AFTER_E4, plyCount: 1 });
    await insertMove(db, game.id, 1, 'e2e4', 'e4', AFTER_E4);
    expect(
      (
        await api.request('POST', `/api/games/${game.publicId}/share`, {
          token: tokens.carol,
          body: { ply: 1 },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await api.request('POST', `/api/games/${game.publicId}/share`, {
          token: tokens.carol,
          body: { ply: 0 },
        })
      ).status,
    ).toBe(429);
    expect(
      (
        await api.request('POST', `/api/games/${game.publicId}/share`, {
          token: tokens.alice,
          body: { ply: 5 },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api.request('POST', `/api/games/${game.publicId}/share`, {
          token: tokens.dave,
          body: { ply: 1 },
        })
      ).status,
    ).toBe(403);
    expect(await db.select().from(shares)).toHaveLength(1);
    expect((await db.select().from(jobs)).map((job) => job.kind)).toEqual(['send_share_photo']);
    const pgn = await api.request('GET', `/api/games/${game.publicId}/pgn`, {
      token: tokens.carol,
    });
    expect(pgn.headers.get('content-type')).toContain('application/x-chess-pgn');
    const text = await pgn.text();
    expect(text).toContain('[Event "Group Chess"]');
    expect(text).toContain(`[Site "${group.title}"]`);
    expect(text).toContain('1. e4 *');
    expect(
      (await api.request('GET', `/api/games/${game.publicId}/pgn`, { token: tokens.dave })).status,
    ).toBe(403);
  });

  it('creates a rematch through the API', async () => {
    const { group, alice, bob, tokens } = await world();
    const game = await insertGame(db, group.id, alice.id, bob.id, {
      status: 'finished',
      result: '1-0',
      endReason: 'checkmate',
      finishedAt: new Date(),
    });
    const res = await api.request('POST', `/api/games/${game.publicId}/rematch`, {
      token: tokens.bob,
    });
    expect(res.status).toBe(200);
    expect(ChallengeDtoSchema.parse(await res.json())).toMatchObject({
      challengerColour: 'white',
      challenger: { id: String(bob.id) },
    });
  });
});

describe('GET /api/games/:id/events', () => {
  const readChunk = async (res: Response) => {
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    reader.releaseLock();
    return new TextDecoder().decode(value);
  };

  it('sends the state on connect and again after a move', async () => {
    const { group, alice, bob, carol, tokens } = await world();
    const game = await insertGame(db, group.id, alice.id, bob.id);
    const controller = new AbortController();
    const res = await api.request(
      'GET',
      `/api/games/${game.publicId}/events?token=${tokens.carol}`,
      { signal: controller.signal },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const first = decoder.decode((await reader.read()).value);
    expect(first).toContain('event: state');
    expect(first).toContain('id: 0');
    await move(tokens.alice, game.publicId, 'e2e4', 0);
    let received = '';
    while (!received.includes('id: 1')) received += decoder.decode((await reader.read()).value);
    expect(received).toContain('"plyCount":1');
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.ctx.streams.count(carol.id)).toBe(0);
  });

  it('refuses the stream to a non-member and caps open streams at four per user', async () => {
    const { group, alice, bob, carol, tokens } = await world();
    const game = await insertGame(db, group.id, alice.id, bob.id);
    expect(
      (await api.request('GET', `/api/games/${game.publicId}/events?token=${tokens.dave}`)).status,
    ).toBe(403);
    const controllers = Array.from({ length: 4 }, () => new AbortController());
    for (const controller of controllers) {
      const res = await api.request(
        'GET',
        `/api/games/${game.publicId}/events?token=${tokens.carol}`,
        { signal: controller.signal },
      );
      expect(res.status).toBe(200);
      await readChunk(res);
    }
    const fifth = await api.request(
      'GET',
      `/api/games/${game.publicId}/events?token=${tokens.carol}`,
    );
    expect(fifth.status).toBe(429);
    for (const controller of controllers) controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.ctx.streams.count(carol.id)).toBe(0);
  });
});

describe('admin routes', () => {
  it('guards settings, blocks and voids behind the admin check and audits them', async () => {
    const { group, alice, bob, tokens } = await world();
    expect(
      (await api.request('GET', `/api/groups/${group.publicId}/settings`, { token: tokens.carol }))
        .status,
    ).toBe(403);
    api.fake.admins = [33];
    api.ctx.membership.invalidateAdmins(group.id);
    expect(
      (await api.request('GET', `/api/groups/${group.publicId}/settings`, { token: tokens.carol }))
        .status,
    ).toBe(200);
    const updated = await api.request('PUT', `/api/groups/${group.publicId}/settings`, {
      token: tokens.carol,
      body: { maxActiveGamesPerUser: 3 },
    });
    expect(
      ((await updated.json()) as { settings: { maxActiveGamesPerUser: number } }).settings
        .maxActiveGamesPerUser,
    ).toBe(3);
    expect(
      (
        await api.request('PUT', `/api/groups/${group.publicId}/settings`, {
          token: tokens.carol,
          body: { cardTopicMode: 'fixed' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api.request('POST', `/api/groups/${group.publicId}/blocks`, {
          token: tokens.carol,
          body: { userId: String(bob.id) },
        })
      ).status,
    ).toBe(200);
    expect(
      (await db.select().from(groupMembers).where(eq(groupMembers.userId, bob.id)))[0]?.blockedAt,
    ).not.toBeNull();
    expect(
      (
        await api.request('DELETE', `/api/groups/${group.publicId}/blocks/${bob.id}`, {
          token: tokens.carol,
        })
      ).status,
    ).toBe(200);
    const game = await insertGame(db, group.id, alice.id, bob.id);
    const voided = GameDtoSchema.parse(
      await (
        await api.request('POST', `/api/games/${game.publicId}/void`, { token: tokens.carol })
      ).json(),
    );
    expect(voided).toMatchObject({ voided: true, endReason: 'voided' });
    expect(
      (await db.select().from(adminActions).orderBy(adminActions.id)).map((row) => row.action),
    ).toEqual(['settings', 'block', 'unblock', 'void']);
    expect(
      (await api.request('POST', `/api/games/${game.publicId}/void`, { token: tokens.alice }))
        .status,
    ).toBe(403);
  });
});

describe('unknown ids', () => {
  it('answers 404 for a well-formed unknown id and for a malformed one', async () => {
    const { tokens } = await world();
    expect(
      (await api.request('GET', '/api/games/zzzzzzzzzz', { token: tokens.alice })).status,
    ).toBe(404);
    expect((await api.request('GET', '/api/games/not-an-id', { token: tokens.alice })).status).toBe(
      404,
    );
    const [row] = await db.execute(sql`select 1 as one`);
    expect(row?.one).toBe(1);
  });
});
