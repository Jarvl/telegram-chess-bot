import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getGameDto, requireGameById, resign } from '../../src/domain/games';
import { touchMember } from '../../src/domain/members';
import { openTestDb, testDeps, truncateAll } from '../helpers/db';
import { insertGame, insertGroup, insertUser, type GameOverrides } from '../helpers/fixtures';

const { db, close } = openTestDb();
const deps = testDeps(db);

beforeEach(() => truncateAll(db));
afterAll(() => close());

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
