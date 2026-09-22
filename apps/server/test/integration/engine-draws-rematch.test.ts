import { INITIAL_FEN } from '@group-chess/shared';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { challenges, jobs } from '../../src/db/schema';
import { createRematch } from '../../src/domain/challenges';
import { offerDraw } from '../../src/domain/draws';
import { isDomainError } from '../../src/domain/errors';
import { createEngineGame } from '../../src/domain/engineGames';
import { getGameDto, playMove, requireGameByPublicId, resign } from '../../src/domain/games';
import { touchMember } from '../../src/domain/members';
import { Metrics } from '../../src/metrics';
import { testConfig } from '../helpers/config';
import { openTestDb, testDeps, truncateAll } from '../helpers/db';
import { createEngineJobRunner } from '../helpers/engineJob';
import { fakeEngine } from '../helpers/fakeEngine';
import { insertGame, insertGroup, insertUser } from '../helpers/fixtures';

const { db, close } = openTestDb();
const deps = testDeps(db);
const config = testConfig();
let metrics = new Metrics();
let group: Awaited<ReturnType<typeof insertGroup>>;
let alice: Awaited<ReturnType<typeof insertUser>>;
let runEngineJob: ReturnType<typeof createEngineJobRunner>;

beforeEach(async () => {
  await truncateAll(db);
  metrics = new Metrics();
  runEngineJob = createEngineJobRunner(deps, db, metrics, config);
  group = await insertGroup(db);
  alice = await insertUser(db, { firstName: 'Alice' });
  await touchMember(db, group.id, alice.id);
});
afterAll(() => close());

describe('GameDto.engineLevel', () => {
  it('carries the level in the game DTO so the app can label and rematch', async () => {
    const game = await createEngineGame(deps, {
      groupId: group.id,
      userId: alice.id,
      level: 'strong',
      colour: 'white',
      timePerMove: 86_400,
    });
    const dto = await getGameDto(deps, { gameId: game.publicId, viewerUserId: alice.id });
    expect(dto.engineLevel).toBe('strong');
  });

  it('leaves engineLevel null on a human game', async () => {
    const bob = await insertUser(db, { firstName: 'Bob' });
    const game = await insertGame(db, group.id, alice.id, bob.id, { fen: INITIAL_FEN });
    const dto = await getGameDto(deps, { gameId: game.publicId, viewerUserId: alice.id });
    expect(dto.engineLevel).toBeNull();
  });
});

describe('draw offers against the bot', () => {
  it('has the bot decline a draw offer rather than leaving it pending', async () => {
    const engine = fakeEngine({ replies: [{ uci: 'e7e5' }] });
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
    await offerDraw(deps, { gameId: game.publicId, userId: alice.id });
    expect((await requireGameByPublicId(db, game.publicId)).drawOfferBy).not.toBeNull();
    await runEngineJob(engine, game.id);
    const after = await requireGameByPublicId(db, game.publicId);
    expect(after.drawOfferBy).toBeNull();
    expect(after.status).toBe('active');
  });

  it('declines the offer even when it is the human to move, so no offer is left hanging', async () => {
    const engine = fakeEngine({ replies: [{ uci: 'e7e5' }] });
    const game = await createEngineGame(deps, {
      groupId: group.id,
      userId: alice.id,
      level: 'club',
      colour: 'white',
      timePerMove: 86_400,
    });
    await offerDraw(deps, { gameId: game.publicId, userId: alice.id });
    await runEngineJob(engine, game.id);
    const after = await requireGameByPublicId(db, game.publicId);
    expect(after.drawOfferBy).toBeNull();
    expect(after.plyCount).toBe(0);
    expect(engine.calls).toHaveLength(0);
  });
});

describe('rematch against the bot', () => {
  it('refuses a rematch challenge for an engine game, creating no challenge and no card job', async () => {
    const game = await createEngineGame(deps, {
      groupId: group.id,
      userId: alice.id,
      level: 'club',
      colour: 'white',
      timePerMove: 86_400,
    });
    await resign(deps, { gameId: game.publicId, userId: alice.id });
    const error = await createRematch(deps, { gameId: game.id, userId: alice.id }).catch(
      (err) => err,
    );
    expect(isDomainError(error)).toBe(true);
    expect(await db.select().from(challenges)).toHaveLength(0);
    expect((await db.select().from(jobs)).map((job) => job.kind)).not.toContain(
      'send_challenge_card',
    );
  });
});
