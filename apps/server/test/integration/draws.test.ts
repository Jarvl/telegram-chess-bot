import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ratings } from '../../src/db/schema';
import { acceptDraw, claimDraw, declineDraw, offerDraw } from '../../src/domain/draws';
import { playMove } from '../../src/domain/games';
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
  for (const user of [alice, bob]) await touchMember(db, group.id, user.id);
  const game = await insertGame(db, group.id, alice.id, bob.id, overrides);
  return { group, alice, bob, game };
}

let n = 0;
const play = (gameId: string, userId: number, uci: string, expectedPly: number) =>
  playMove(deps, { gameId, userId, uci, expectedPly, clientMoveId: `draw-test-${(n += 1)}` });

describe('draw offers', () => {
  it('records an offer, refuses a second one while it stands, and lets the opponent decline', async () => {
    const { game, alice, bob } = await setup();
    const offered = await offerDraw(deps, { gameId: game.publicId, userId: alice.id });
    expect(offered.drawOffer).toEqual({ by: 'white', atPly: 0 });
    expect(offered.version).toBe(1);
    await expect(offerDraw(deps, { gameId: game.publicId, userId: bob.id })).rejects.toMatchObject({
      details: { reason: 'draw_offer_unavailable' },
    });
    await expect(
      acceptDraw(deps, { gameId: game.publicId, userId: alice.id }),
    ).rejects.toMatchObject({
      details: { reason: 'no_offer' },
    });
    const declined = await declineDraw(deps, { gameId: game.publicId, userId: bob.id });
    expect(declined.drawOffer).toBeNull();
    expect(declined.status).toBe('active');
  });

  it('allows one offer per own move', async () => {
    const { game, alice, bob } = await setup();
    await offerDraw(deps, { gameId: game.publicId, userId: alice.id });
    await declineDraw(deps, { gameId: game.publicId, userId: bob.id });
    await expect(
      offerDraw(deps, { gameId: game.publicId, userId: alice.id }),
    ).rejects.toMatchObject({
      details: { reason: 'draw_offer_unavailable' },
    });
    await play(game.publicId, alice.id, 'e2e4', 0);
    const again = await offerDraw(deps, { gameId: game.publicId, userId: alice.id });
    expect(again.drawOffer).toEqual({ by: 'white', atPly: 1 });
  });

  it('ends the game by agreement when the opponent accepts', async () => {
    const { game, alice, bob } = await setup();
    await play(game.publicId, alice.id, 'e2e4', 0);
    await play(game.publicId, bob.id, 'e7e5', 1);
    await offerDraw(deps, { gameId: game.publicId, userId: bob.id });
    const dto = await acceptDraw(deps, { gameId: game.publicId, userId: alice.id });
    expect(dto).toMatchObject({
      status: 'finished',
      result: '1/2-1/2',
      endReason: 'draw_agreement',
      drawOffer: null,
    });
    expect(await db.select().from(ratings)).toHaveLength(2);
  });
});

describe('draw claims', () => {
  it('lets a player claim threefold repetition once the arbiter reports it', async () => {
    const { game, alice, bob } = await setup();
    const shuffle = ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8'];
    let ply = 0;
    for (const uci of shuffle) {
      await play(game.publicId, ply % 2 === 0 ? alice.id : bob.id, uci, ply);
      ply += 1;
    }
    await expect(
      claimDraw(deps, { gameId: game.publicId, userId: alice.id }),
    ).resolves.toMatchObject({
      status: 'finished',
      result: '1/2-1/2',
      endReason: 'threefold_claim',
    });
  });

  it('lets a player claim the fifty-move rule at halfmove 100', async () => {
    const { game, bob } = await setup({ fen: '8/8/8/8/8/8/1R6/K6k w - - 100 60', plyCount: 120 });
    const dto = await claimDraw(deps, { gameId: game.publicId, userId: bob.id });
    expect(dto).toMatchObject({ status: 'finished', endReason: 'fifty_move_claim' });
  });

  it('refuses a claim when neither rule applies', async () => {
    const { game, alice } = await setup();
    await expect(
      claimDraw(deps, { gameId: game.publicId, userId: alice.id }),
    ).rejects.toMatchObject({
      code: 'forbidden',
      details: { reason: 'no_claim' },
    });
  });
});
