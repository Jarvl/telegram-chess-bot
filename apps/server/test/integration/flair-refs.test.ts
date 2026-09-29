import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { games } from '../../src/db/schema';
import { getGameDto } from '../../src/domain/games';
import { playerPage } from '../../src/domain/lobby';
import { applyGameResultToRatings, getLeaderboard } from '../../src/domain/ratings';
import { gameSummaryRows, toGameSummary } from '../../src/domain/summaries';
import { openTestDb, testDeps, truncateAll } from '../helpers/db';
import { insertGame, insertGroup, insertUser } from '../helpers/fixtures';

const { db, close } = openTestDb();
const deps = testDeps(db);

beforeEach(() => truncateAll(db));
afterAll(() => close());

describe('worn flair on player refs', () => {
  it('travels with the players of games, summaries, the leaderboard and the player page', async () => {
    const worn = ['en_passant_win', 'rank_1500'];
    const group = await insertGroup(db);
    const alice = await insertUser(db, { flairWorn: worn });
    const bob = await insertUser(db);
    const game = await insertGame(db, group.id, alice.id, bob.id, {
      status: 'finished',
      result: '1-0',
      endReason: 'resignation',
      finishedAt: new Date(),
      plyCount: 20,
    });
    await applyGameResultToRatings(db, game, game.finishedAt!);
    const dto = await getGameDto(deps, { gameId: game.publicId, viewerUserId: bob.id });
    expect([dto.white.flair, dto.black.flair]).toEqual([worn, []]);
    const [row] = await gameSummaryRows(db, eq(games.id, game.id), [asc(games.id)], 1);
    expect(toGameSummary(row!, bob.id).white.flair).toEqual(worn);
    expect(
      (await getLeaderboard(db, group.id)).find((e) => e.id === String(alice.id))?.flair,
    ).toEqual(worn);
    expect((await playerPage(deps, group.id, bob.id, alice.id)).player.flair).toEqual(worn);
  });
});
