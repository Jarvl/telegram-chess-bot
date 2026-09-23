import type { EngineLevel } from '@group-chess/shared';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MAX_GAMES_PER_PAIR, reminderExpression } from '../../src/domain/limits';
import { challenges, games, jobs, users } from '../../src/db/schema';
import { DomainError } from '../../src/domain/errors';
import { createEngineGame, getEngineUser } from '../../src/domain/engineGames';
import { touchMember } from '../../src/domain/members';
import { openTestDb, testDeps, truncateAll } from '../helpers/db';
import { insertGroup, insertUser } from '../helpers/fixtures';

const { db, close } = openTestDb();
const deps = testDeps(db);

beforeEach(() => truncateAll(db));
afterAll(() => close());

async function setup(userOverrides: Partial<typeof users.$inferInsert> = {}) {
  const group = await insertGroup(db);
  const alice = await insertUser(db, { firstName: 'Alice', ...userOverrides });
  await touchMember(db, group.id, alice.id);
  return { group, alice };
}

describe('createEngineGame', () => {
  it('creates a started, unrated game against the engine with no challenge and no card job', async () => {
    const { group, alice } = await setup();
    const game = await createEngineGame(deps, {
      groupId: group.id,
      userId: alice.id,
      level: 'club',
      colour: 'white',
      timePerMove: 86_400,
    });
    expect(game.status).toBe('active');
    expect(game.rated).toBe(false);
    expect(game.engineLevel).toBe('club');
    expect(game.whiteId).toBe(alice.id);
    expect(game.blackId).toBe((await getEngineUser(db)).id);
    expect(await db.select().from(challenges)).toHaveLength(0);
    const kinds = (await db.select().from(jobs)).map((job) => job.kind);
    expect(kinds).not.toContain('send_challenge_card');
    expect(kinds).not.toContain('edit_card');
  });

  it('forces the game unrated even when the caller asks for rated', async () => {
    const { group, alice } = await setup();
    // `rated` is not part of the input at all, which is the point: it cannot be requested.
    const game = await createEngineGame(deps, {
      groupId: group.id,
      userId: alice.id,
      level: 'club',
      colour: 'random',
      timePerMove: null,
    });
    expect(game.rated).toBe(false);
  });

  it('enqueues an engine move immediately when the engine has white', async () => {
    const { group, alice } = await setup();
    const game = await createEngineGame(deps, {
      groupId: group.id,
      userId: alice.id,
      level: 'club',
      colour: 'black',
      timePerMove: 86_400,
    });
    const engineJobs = (await db.select().from(jobs)).filter((job) => job.kind === 'engine_move');
    expect(engineJobs).toHaveLength(1);
    expect(game.deadlineAt).toBeNull();
  });

  it('refuses a third concurrent engine game with a domain error, not a crash', async () => {
    const { group, alice } = await setup();
    for (let i = 0; i < MAX_GAMES_PER_PAIR; i += 1) {
      await createEngineGame(deps, {
        groupId: group.id,
        userId: alice.id,
        level: 'club',
        colour: 'white',
        timePerMove: 86_400,
      });
    }
    await expect(
      createEngineGame(deps, {
        groupId: group.id,
        userId: alice.id,
        level: 'club',
        colour: 'white',
        timePerMove: 86_400,
      }),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it('refuses an out-of-table engine level and writes no game row', async () => {
    const { group, alice } = await setup();
    await expect(
      createEngineGame(deps, {
        groupId: group.id,
        userId: alice.id,
        // Cast past the compile-time union: the point of this test is the runtime guard.
        level: 'grandmaster' as EngineLevel,
        colour: 'white',
        timePerMove: 86_400,
      }),
    ).rejects.toBeInstanceOf(DomainError);
    expect(await db.select().from(games)).toHaveLength(0);
  });

  it('sets a real deadline only for the human side to move, never for the engine', async () => {
    const { group, alice } = await setup({ dmAllowed: true });

    const engineToMove = await createEngineGame(deps, {
      groupId: group.id,
      userId: alice.id,
      level: 'club',
      colour: 'black',
      timePerMove: 86_400,
    });
    expect(engineToMove.deadlineAt).toBeNull();

    const humanToMove = await createEngineGame(deps, {
      groupId: group.id,
      userId: alice.id,
      level: 'club',
      colour: 'white',
      timePerMove: 86_400,
    });
    expect(humanToMove.deadlineAt).not.toBeNull();
  });

  it('never carries a reminder, even on the human turn a human game would remind about', async () => {
    const { group, alice } = await setup({ dmAllowed: true });

    // Guard against a vacuous pass: these are inputs the production reminder expression genuinely
    // produces a reminder for, so a null below is the bot rule at work rather than a broken
    // reminder path. A fixture that writes reminder_at directly would not prove this.
    expect(reminderExpression(86_400, true)).not.toBeNull();

    for (const colour of ['white', 'black'] as const) {
      const game = await createEngineGame(deps, {
        groupId: group.id,
        userId: alice.id,
        level: 'club',
        colour,
        timePerMove: 86_400,
      });
      expect(game.reminderAt).toBeNull();
    }
  });
});
