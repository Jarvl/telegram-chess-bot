import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { games, jobs, moves } from '../../src/db/schema';
import { createEngineGame, getEngineUser } from '../../src/domain/engineGames';
import { getGameDto, playMove, requireGameById, resign } from '../../src/domain/games';
import { touchMember } from '../../src/domain/members';
import { openTestDb, testDeps, truncateAll } from '../helpers/db';
import { insertGame, insertGroup, insertUser, type GameOverrides } from '../helpers/fixtures';

const { db, close } = openTestDb();
const deps = testDeps(db);

beforeEach(() => truncateAll(db));
afterAll(() => close());

let counter = 0;
const move = (gameId: string, userId: number, uci: string, expectedPly: number) =>
  playMove(deps, { gameId, userId, uci, expectedPly, clientMoveId: `c-${(counter += 1)}` });
const jobList = async () =>
  (await db.select().from(jobs).orderBy(jobs.id)).map((job) => [job.kind, job.dedupKey]);

async function setup(overrides: GameOverrides = {}) {
  const group = await insertGroup(db);
  const alice = await insertUser(db, { firstName: 'Alice' });
  const bob = await insertUser(db, { firstName: 'Bob' });
  const carol = await insertUser(db, { firstName: 'Carol' });
  for (const user of [alice, bob, carol]) await touchMember(db, group.id, user.id);
  const game = await insertGame(db, group.id, alice.id, bob.id, overrides);
  return { group, alice, bob, carol, game };
}

describe('premove storage and visibility', () => {
  it('shows the queue to its owner only, and only while it is not their turn', async () => {
    // White (Alice) to move; Black (Bob) owns the queue.
    const { game, alice, bob, carol } = await setup({ premoves: ['e7e5'] });
    expect(
      (await getGameDto(deps, { gameId: game.publicId, viewerUserId: bob.id })).premoves,
    ).toEqual(['e7e5']);
    expect(
      (await getGameDto(deps, { gameId: game.publicId, viewerUserId: alice.id })).premoves,
    ).toEqual([]);
    expect(
      (await getGameDto(deps, { gameId: game.publicId, viewerUserId: carol.id })).premoves,
    ).toEqual([]);
    expect(
      (await getGameDto(deps, { gameId: game.publicId, viewerUserId: null })).premoves,
    ).toEqual([]);
  });

  it('empties the queue when the game ends', async () => {
    const { game, alice } = await setup({ premoves: ['e7e5', 'g8f6'] });
    await resign(deps, { gameId: game.publicId, userId: alice.id });
    expect((await requireGameById(db, game.id)).premoves).toEqual([]);
  });
});

const queue = (id: number, premoves: string[]) =>
  db.update(games).set({ premoves }).where(eq(games.id, id));
const moveRows = (gameId: number) =>
  db.select().from(moves).where(eq(moves.gameId, gameId)).orderBy(moves.ply);

describe('firing premoves', () => {
  it('plays the first premove as soon as the opponent moves, with no turn DM for its owner', async () => {
    const { game, alice } = await setup();
    await queue(game.id, ['e7e5']);
    const dto = await move(game.publicId, alice.id, 'e2e4', 0);
    expect(dto).toMatchObject({ plyCount: 2, version: 2 });
    expect(dto.moves.map((m) => m.san)).toEqual(['e4', 'e5']);
    expect((await moveRows(game.id)).map((m) => m.clientMoveId)[1]).toBe(
      `premove:${game.publicId}:2`,
    );
    expect(await jobList()).toEqual([
      ['edit_card', `card:g:${game.publicId}`],
      ['send_dm', `dm:${alice.id}:g:${game.publicId}:turn:2`],
    ]);
    expect((await requireGameById(db, game.id)).premoves).toEqual([]);
  });

  it('plays one premove per opponent move and keeps the rest for the owner', async () => {
    const { game, alice, bob } = await setup();
    await queue(game.id, ['e7e5', 'g8f6']);
    await move(game.publicId, alice.id, 'e2e4', 0);
    expect(
      (await getGameDto(deps, { gameId: game.publicId, viewerUserId: bob.id })).premoves,
    ).toEqual(['g8f6']);
    const dto = await move(game.publicId, alice.id, 'g1f3', 2);
    expect(dto.moves.map((m) => m.san)).toEqual(['e4', 'e5', 'Nf3', 'Nf6']);
  });

  it('keeps a leftover premove that no longer fits, and cancels it on the owner’s next turn', async () => {
    // White Rb1 takes the queued knight on b8: Rxb8+, check along the empty rank 8. Black's
    // Kd7 fires (escaping the check). The queued Nb8c6 that followed has no knight on b8 to move
    // any more, but it stays queued: cancelling it now, on White's turn, would leave Black's next
    // turn DM without "Your premoves were cancelled." (premoves spec, Firing and Notifications).
    const { game, alice, bob } = await setup({
      fen: '1n2k3/8/8/8/8/8/P7/1R2K3 w - - 0 1',
      plyCount: 10,
    });
    await queue(game.id, ['e8d7', 'b8c6']);
    const dto = await move(game.publicId, alice.id, 'b1b8', 10);
    expect(dto.plyCount).toBe(12);
    expect((await requireGameById(db, game.id)).premoves).toEqual(['b8c6']);
    expect(
      (await getGameDto(deps, { gameId: game.publicId, viewerUserId: bob.id })).premoves,
    ).toEqual(['b8c6']);

    // White's next move reaches the leftover: b8c6 is illegal, so the chain is cancelled and
    // Black's turn DM says so.
    await db.delete(jobs);
    const after = await move(game.publicId, alice.id, 'a2a3', 12);
    expect(after.plyCount).toBe(13);
    expect((await requireGameById(db, game.id)).premoves).toEqual([]);
    const dm = (await db.select().from(jobs)).find((job) => job.kind === 'send_dm');
    expect(dm?.dedupKey).toBe(`dm:${bob.id}:g:${game.publicId}:turn:13`);
    expect(dm?.payload).toEqual({
      userId: bob.id,
      template: 'turn',
      gameId: game.id,
      premovesCancelled: true,
    });
  });

  it('cancels the whole chain when the first premove is illegal, and flags the turn DM', async () => {
    const { game, alice, bob } = await setup();
    await queue(game.id, ['d8h4', 'h4h2']); // the e7 pawn still blocks the queen
    const dto = await move(game.publicId, alice.id, 'e2e4', 0);
    expect(dto.plyCount).toBe(1);
    expect((await requireGameById(db, game.id)).premoves).toEqual([]);
    const dm = (await db.select().from(jobs)).find((job) => job.kind === 'send_dm');
    expect(dm?.dedupKey).toBe(`dm:${bob.id}:g:${game.publicId}:turn:1`);
    expect(dm?.payload).toEqual({
      userId: bob.id,
      template: 'turn',
      gameId: game.id,
      premovesCancelled: true,
    });
  });

  it('cancels when the opponent captured the piece the premove would move', async () => {
    // 1.e4 d5, White to move; Black premoved d5d4, and White takes on d5.
    const { game, alice, bob } = await setup({
      fen: 'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2',
      plyCount: 2,
    });
    await queue(game.id, ['d5d4']);
    const dto = await move(game.publicId, alice.id, 'e4d5', 2);
    expect(dto.plyCount).toBe(3);
    expect((await requireGameById(db, game.id)).premoves).toEqual([]);
    const dm = (await db.select().from(jobs)).find((job) => job.kind === 'send_dm');
    expect(dm?.dedupKey).toBe(`dm:${bob.id}:g:${game.publicId}:turn:3`);
    expect(dm?.payload).toEqual({
      userId: bob.id,
      template: 'turn',
      gameId: game.id,
      premovesCancelled: true,
    });
  });

  it('cancels when the opponent’s check makes the premove leave its own king in check', async () => {
    // 1.e4 d6, White to move; Black premoved Nf6, and White plays Bb5+.
    const { game, alice } = await setup({
      fen: 'rnbqkbnr/ppp1pppp/3p4/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
      plyCount: 2,
    });
    await queue(game.id, ['g8f6']);
    const dto = await move(game.publicId, alice.id, 'f1b5', 2);
    expect(dto.plyCount).toBe(3);
    expect((await requireGameById(db, game.id)).premoves).toEqual([]);
  });

  it('plays a premove that is only legal as en passant', async () => {
    // Black pawn on d4; White plays c2c4 and Black's d4c3 premove takes en passant.
    const { game, alice } = await setup({
      fen: 'rnbqkbnr/ppp1pppp/8/8/3p4/8/PPPPPPPP/RNBQKBNR w KQkq - 0 3',
      plyCount: 4,
    });
    await queue(game.id, ['d4c3']);
    const dto = await move(game.publicId, alice.id, 'c2c4', 4);
    expect(dto.moves.at(-1)?.san).toBe('dxc3');
    expect(dto.fen.split(' ')[0]).toBe('rnbqkbnr/ppp1pppp/8/8/8/2p5/PP1PPPPP/RNBQKBNR');
  });

  it('plays a castling premove', async () => {
    const { game, alice } = await setup({
      fen: 'rnbqk2r/pppp1ppp/5n2/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4',
      plyCount: 6,
    });
    await queue(game.id, ['e8g8']);
    const dto = await move(game.publicId, alice.id, 'e1g1', 6);
    expect(dto.moves.map((m) => m.san)).toEqual(['O-O', 'O-O']);
  });

  it('finishes the game when a premove mates', async () => {
    // 1.f3 e5, White to move; Black premoved Qh4, and 2.g4 walks into it.
    const { game, alice } = await setup({
      fen: 'rnbqkbnr/pppp1ppp/8/4p3/8/5P2/PPPPP1PP/RNBQKBNR w KQkq e6 0 2',
      plyCount: 2,
    });
    await queue(game.id, ['d8h4']);
    const dto = await move(game.publicId, alice.id, 'g2g4', 2);
    expect(dto).toMatchObject({ status: 'finished', result: '0-1', endReason: 'checkmate' });
    expect((await requireGameById(db, game.id)).premoves).toEqual([]);
  });

  it('cancels a bot game premove with no send_dm job, since bot games announce nothing', async () => {
    const group = await insertGroup(db);
    const alice = await insertUser(db, { firstName: 'Alice' });
    await touchMember(db, group.id, alice.id);
    const engine = await getEngineUser(db);
    const game = await createEngineGame(deps, {
      groupId: group.id,
      userId: alice.id,
      level: 'club',
      colour: 'white',
    });
    await move(game.publicId, alice.id, 'e2e4', 0);
    // Alice premoves e4e5 for her next turn; the engine's e7e5 reply blocks that pawn push.
    await queue(game.id, ['e4e5']);
    await move(game.publicId, engine.id, 'e7e5', 1);
    expect((await requireGameById(db, game.id)).premoves).toEqual([]);
    expect((await db.select().from(jobs)).filter((job) => job.kind === 'send_dm')).toEqual([]);
  });

  it('returns the current state for a retried move after its premove reply was played', async () => {
    const { game, alice } = await setup();
    await queue(game.id, ['e7e5']);
    const input = {
      gameId: game.publicId,
      userId: alice.id,
      uci: 'e2e4',
      expectedPly: 0,
      clientMoveId: 'retry-me',
    };
    await playMove(deps, input);
    expect((await playMove(deps, input)).plyCount).toBe(2);
  });
});
