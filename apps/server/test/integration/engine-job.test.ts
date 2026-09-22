import type { ColourChoice } from '@group-chess/shared';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { JobRow } from '../../src/db/schema';
import { createEngineGame, getEngineUser } from '../../src/domain/engineGames';
import { playMove, requireGameByPublicId, resign } from '../../src/domain/games';
import type { Engine } from '../../src/engine/engine';
import { engineJobHandlers } from '../../src/jobs/handlers/engine';
import { touchMember } from '../../src/domain/members';
import { Metrics } from '../../src/metrics';
import { testConfig } from '../helpers/config';
import { openTestDb, testDeps, truncateAll } from '../helpers/db';
import { fakeEngine } from '../helpers/fakeEngine';
import { insertGroup, insertUser } from '../helpers/fixtures';

const { db, close } = openTestDb();
const deps = testDeps(db);
const config = testConfig();
let metrics = new Metrics();
let group: Awaited<ReturnType<typeof insertGroup>>;
let alice: Awaited<ReturnType<typeof insertUser>>;

beforeEach(async () => {
  await truncateAll(db);
  metrics = new Metrics();
  group = await insertGroup(db);
  alice = await insertUser(db, { firstName: 'Alice' });
  await touchMember(db, group.id, alice.id);
});
afterAll(() => close());

async function startedEngineGame(colour: ColourChoice) {
  return createEngineGame(deps, {
    groupId: group.id,
    userId: alice.id,
    level: 'club',
    colour,
    timePerMove: 86_400,
  });
}

function buildJob(gameId: number, overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: 1,
    kind: 'engine_move',
    dedupKey: null,
    payload: { gameId },
    runAt: new Date(),
    attempts: 0,
    maxAttempts: 8,
    lockedUntil: null,
    lockedBy: null,
    lastError: null,
    createdAt: new Date(),
    doneAt: null,
    failedAt: null,
    ...overrides,
  };
}

async function runEngineJob(
  engine: Engine,
  gameId: number,
  jobOverrides: Partial<JobRow> = {},
  jobConfig: ReturnType<typeof testConfig> = config,
) {
  const handlers = engineJobHandlers({ deps, engine, config: jobConfig, metrics });
  const job = buildJob(gameId, jobOverrides);
  return handlers.engine_move!({ job, db, log: deps.log });
}

describe('engine_move job handler', () => {
  it('plays the engine reply and hands the turn back', async () => {
    const engine = fakeEngine({ replies: [{ uci: 'e7e5' }] });
    const game = await startedEngineGame('white');
    await playMove(deps, {
      gameId: game.publicId,
      userId: alice.id,
      uci: 'e2e4',
      expectedPly: 0,
      clientMoveId: 'c1',
    });
    await runEngineJob(engine, game.id);
    const after = await requireGameByPublicId(db, game.publicId);
    expect(after.plyCount).toBe(2);
    expect(engine.calls[0]!.level).toBe('club');
  });

  it('substitutes a legal move when the engine returns an illegal one, and counts it', async () => {
    const engine = fakeEngine({ replies: [{ uci: 'a1a8' }] });
    const game = await startedEngineGame('white');
    await playMove(deps, {
      gameId: game.publicId,
      userId: alice.id,
      uci: 'e2e4',
      expectedPly: 0,
      clientMoveId: 'c1',
    });
    await runEngineJob(engine, game.id);
    const after = await requireGameByPublicId(db, game.publicId);
    expect(after.status).toBe('active');
    expect(after.plyCount).toBe(2);
    const counted = await metrics.engineIllegalMoves.get();
    expect(counted.values[0]?.value).toBe(1);
  });

  it('completes without moving when the game already ended', async () => {
    const engine = fakeEngine();
    const game = await startedEngineGame('white');
    await playMove(deps, {
      gameId: game.publicId,
      userId: alice.id,
      uci: 'e2e4',
      expectedPly: 0,
      clientMoveId: 'c1',
    });
    await resign(deps, { gameId: game.publicId, userId: alice.id });
    await expect(runEngineJob(engine, game.id)).resolves.toMatchObject({ outcome: 'done' });
    expect(engine.calls).toHaveLength(0);
    expect((await requireGameByPublicId(db, game.publicId)).plyCount).toBe(1);
  });

  it('completes without moving when the engine reports a terminal position', async () => {
    const engine = fakeEngine({ replies: [{ none: true }] });
    const game = await startedEngineGame('white');
    await playMove(deps, {
      gameId: game.publicId,
      userId: alice.id,
      uci: 'e2e4',
      expectedPly: 0,
      clientMoveId: 'c1',
    });
    await expect(runEngineJob(engine, game.id)).resolves.toMatchObject({ outcome: 'done' });
    expect((await requireGameByPublicId(db, game.publicId)).plyCount).toBe(1);
  });

  it('asks for a retry, not silence, when the engine is unavailable', async () => {
    const engine = fakeEngine({ fail: new Error('spawn stockfish ENOENT') });
    const game = await startedEngineGame('white');
    await playMove(deps, {
      gameId: game.publicId,
      userId: alice.id,
      uci: 'e2e4',
      expectedPly: 0,
      clientMoveId: 'c1',
    });
    const result = await runEngineJob(engine, game.id);
    expect(result).toMatchObject({ outcome: 'retry_attempt' });
    expect((await requireGameByPublicId(db, game.publicId)).status).toBe('active');
  });

  it('aborts the game once the retry ladder is exhausted, even past the player abort deadline', async () => {
    const engine = fakeEngine({ fail: new Error('spawn stockfish ENOENT') });
    const game = await startedEngineGame('white');
    await playMove(deps, {
      gameId: game.publicId,
      userId: alice.id,
      uci: 'e2e4',
      expectedPly: 0,
      clientMoveId: 'c1',
    });
    // Get plyCount to 2 (past the point where a human's abortGame would refuse) so this proves
    // the failure path does not go through abortGame's player-facing guard.
    const engineUser = await getEngineUser(db);
    await playMove(deps, {
      gameId: game.publicId,
      userId: engineUser.id,
      uci: 'e7e5',
      expectedPly: 1,
      clientMoveId: 'e1',
    });
    await playMove(deps, {
      gameId: game.publicId,
      userId: alice.id,
      uci: 'd2d4',
      expectedPly: 2,
      clientMoveId: 'c2',
    });
    const before = await requireGameByPublicId(db, game.publicId);
    expect(before.plyCount).toBeGreaterThanOrEqual(2);
    const result = await runEngineJob(engine, game.id, { attempts: 7, maxAttempts: 8 });
    expect(result).toMatchObject({ outcome: 'fail' });
    const after = await requireGameByPublicId(db, game.publicId);
    expect(after.status).toBe('finished');
    expect(after.endReason).toBe('abort');
  });

  it('asks for a retry, not silence, when the engine is disabled', async () => {
    const engine = fakeEngine();
    const game = await startedEngineGame('white');
    await playMove(deps, {
      gameId: game.publicId,
      userId: alice.id,
      uci: 'e2e4',
      expectedPly: 0,
      clientMoveId: 'c1',
    });
    const result = await runEngineJob(engine, game.id, {}, testConfig({ ENGINE_ENABLED: false }));
    expect(result).toMatchObject({ outcome: 'retry_attempt' });
    expect(engine.calls).toHaveLength(0);
    expect((await requireGameByPublicId(db, game.publicId)).status).toBe('active');
  });

  it('aborts the game once the retry ladder is exhausted while the engine is disabled', async () => {
    const engine = fakeEngine();
    const game = await startedEngineGame('white');
    await playMove(deps, {
      gameId: game.publicId,
      userId: alice.id,
      uci: 'e2e4',
      expectedPly: 0,
      clientMoveId: 'c1',
    });
    // Same past-ply-1 setup as the outage test, so this also proves the disabled path does not
    // go through abortGame's player-facing guard.
    const engineUser = await getEngineUser(db);
    await playMove(deps, {
      gameId: game.publicId,
      userId: engineUser.id,
      uci: 'e7e5',
      expectedPly: 1,
      clientMoveId: 'e1',
    });
    await playMove(deps, {
      gameId: game.publicId,
      userId: alice.id,
      uci: 'd2d4',
      expectedPly: 2,
      clientMoveId: 'c2',
    });
    const before = await requireGameByPublicId(db, game.publicId);
    expect(before.plyCount).toBeGreaterThanOrEqual(2);
    const result = await runEngineJob(
      engine,
      game.id,
      { attempts: 7, maxAttempts: 8 },
      testConfig({ ENGINE_ENABLED: false }),
    );
    expect(result).toMatchObject({ outcome: 'fail' });
    expect(engine.calls).toHaveLength(0);
    const after = await requireGameByPublicId(db, game.publicId);
    expect(after.status).toBe('finished');
    expect(after.endReason).toBe('abort');
  });

  it('plays only once when the same ply is triggered twice', async () => {
    const engine = fakeEngine({ replies: [{ uci: 'e7e5' }, { uci: 'd7d5' }] });
    const game = await startedEngineGame('white');
    await playMove(deps, {
      gameId: game.publicId,
      userId: alice.id,
      uci: 'e2e4',
      expectedPly: 0,
      clientMoveId: 'c1',
    });
    await runEngineJob(engine, game.id);
    await runEngineJob(engine, game.id);
    expect((await requireGameByPublicId(db, game.publicId)).plyCount).toBe(2);
  });
});
