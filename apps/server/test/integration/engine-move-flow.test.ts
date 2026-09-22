import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { jobs, ratings } from '../../src/db/schema';
import { createEngineGame, getEngineUser } from '../../src/domain/engineGames';
import { playMove, requireGameByPublicId, resign } from '../../src/domain/games';
import { forfeitOverdueGames } from '../../src/clock/scanners';
import { touchMember } from '../../src/domain/members';
import { openTestDb, testDeps, truncateAll } from '../helpers/db';
import { insertGame, insertGroup, insertUser } from '../helpers/fixtures';

const { db, close } = openTestDb();
const deps = testDeps(db);

beforeEach(() => truncateAll(db));
afterAll(() => close());

async function setup() {
  const group = await insertGroup(db);
  const alice = await insertUser(db, { firstName: 'Alice' });
  await touchMember(db, group.id, alice.id);
  return { group, alice };
}

describe('playMove and finishGame with an engine opponent', () => {
  it('leaves no deadline for the engine and enqueues its move, with no card or DM job', async () => {
    const { group, alice } = await setup();
    const game = await createEngineGame(deps, {
      groupId: group.id,
      userId: alice.id,
      level: 'club',
      colour: 'white',
      timePerMove: 86_400,
    });
    await playMove(deps, {
      gameId: game.publicId,
      userId: alice.id,
      uci: 'e2e4',
      expectedPly: 0,
      clientMoveId: 'c1',
    });
    const after = await requireGameByPublicId(db, game.publicId);
    expect(after.deadlineAt).toBeNull();
    expect(after.reminderAt).toBeNull();
    const kinds = (await db.select().from(jobs)).map((job) => job.kind);
    expect(kinds).toContain('engine_move');
    expect(kinds).not.toContain('edit_card');
    expect(kinds).not.toContain('send_dm');
  });

  it('gives the human a deadline again once the engine has moved', async () => {
    const { group, alice } = await setup();
    const game = await createEngineGame(deps, {
      groupId: group.id,
      userId: alice.id,
      level: 'club',
      colour: 'white',
      timePerMove: 86_400,
    });
    await playMove(deps, {
      gameId: game.publicId,
      userId: alice.id,
      uci: 'e2e4',
      expectedPly: 0,
      clientMoveId: 'c1',
    });
    const engine = await getEngineUser(db);
    await playMove(deps, {
      gameId: game.publicId,
      userId: engine.id,
      uci: 'e7e5',
      expectedPly: 1,
      clientMoveId: 'e1',
    });
    const after = await requireGameByPublicId(db, game.publicId);
    expect(after.deadlineAt).not.toBeNull();
  });

  it('keeps a clockless engine game clockless for both sides', async () => {
    const { group, alice } = await setup();
    const game = await createEngineGame(deps, {
      groupId: group.id,
      userId: alice.id,
      level: 'club',
      colour: 'white',
      timePerMove: null,
    });
    await playMove(deps, {
      gameId: game.publicId,
      userId: alice.id,
      uci: 'e2e4',
      expectedPly: 0,
      clientMoveId: 'c1',
    });
    const engine = await getEngineUser(db);
    await playMove(deps, {
      gameId: game.publicId,
      userId: engine.id,
      uci: 'e7e5',
      expectedPly: 1,
      clientMoveId: 'e1',
    });
    const after = await requireGameByPublicId(db, game.publicId);
    expect(after.deadlineAt).toBeNull();
  });

  // Correction to the brief: the original test forged a past deadline onto an engine game and
  // expected it to survive. But forfeitOverdueGames has no engine awareness at all (by design —
  // teaching the scanner to parse side-to-move out of a FEN was rejected). The real mechanism is
  // that an engine game's deadline is NEVER set in the first place, so the scanner never picks it
  // up. This test exercises that real mechanism instead, with a human control game proving the
  // scanner actually ran.
  it('is never forfeited because it is never given a deadline, unlike a human game', async () => {
    const { group, alice } = await setup();
    const engineGame = await createEngineGame(deps, {
      groupId: group.id,
      userId: alice.id,
      level: 'club',
      colour: 'black',
      timePerMove: 86_400,
    });
    expect(engineGame.deadlineAt).toBeNull();

    const bob = await insertUser(db, { firstName: 'Bob' });
    const carol = await insertUser(db, { firstName: 'Carol' });
    await touchMember(db, group.id, bob.id);
    await touchMember(db, group.id, carol.id);
    const humanGame = await insertGame(db, group.id, bob.id, carol.id, {
      deadlineInSeconds: -86_400,
    });

    await forfeitOverdueGames(deps);

    expect((await requireGameByPublicId(db, engineGame.publicId)).status).toBe('active');
    expect((await requireGameByPublicId(db, humanGame.publicId)).status).toBe('finished');
  });

  it('writes no rating row and no Lichess import job when an engine game ends', async () => {
    const { group, alice } = await setup();
    const game = await createEngineGame(deps, {
      groupId: group.id,
      userId: alice.id,
      level: 'club',
      colour: 'white',
      timePerMove: 86_400,
    });
    await resign(deps, { gameId: game.publicId, userId: alice.id });
    const finished = await requireGameByPublicId(db, game.publicId);
    expect(finished.status).toBe('finished');
    expect(finished.lichessImportStatus).toBeNull();
    expect(await db.select().from(ratings)).toHaveLength(0);
    expect((await db.select().from(jobs)).map((job) => job.kind)).not.toContain('lichess_import');
  });
});
