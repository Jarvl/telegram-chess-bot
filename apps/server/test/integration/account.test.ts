import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { dmMessages, games, jobs } from '../../src/db/schema';
import { recordDm } from '../../src/domain/dms';
import { deleteMyData } from '../../src/domain/account';
import { openTestDb, testDeps, truncateAll } from '../helpers/db';
import { insertChallenge, insertGame, insertGroup, insertUser } from '../helpers/fixtures';

const { db, close } = openTestDb();
const deps = testDeps(db);

beforeEach(() => truncateAll(db));
afterAll(() => close());

describe('deleteMyData DMs', () => {
  it('retires every live DM of a deleted user', async () => {
    const group = await insertGroup(db);
    const alice = await insertUser(db, { telegramUserId: 11, firstName: 'Alice', dmAllowed: true });
    const bob = await insertUser(db, { firstName: 'Bob' });
    const first = await insertGame(db, group.id, alice.id, bob.id);
    const second = await insertGame(db, group.id, bob.id, alice.id);
    const challenge = await insertChallenge(db, group.id, bob.id, alice.id);
    const live = {
      userId: alice.id,
      chatId: 11,
      kind: 'turn' as const,
      stub: 'x',
      sentAt: new Date(),
    };
    await db.insert(dmMessages).values([
      { ...live, gameId: first.id, telegramMessageId: 101 },
      { ...live, gameId: second.id, telegramMessageId: 102 },
      { ...live, kind: 'challenge', challengeId: challenge.id, telegramMessageId: 103 },
    ]);

    await deleteMyData(deps, alice.id);

    expect(await db.select().from(dmMessages)).toEqual([]);
    const all = await db.select().from(jobs).orderBy(jobs.id);
    const retires = all.filter((job) => job.kind === 'retire_dm');
    expect(
      retires.map((job) => [job.payload.chatId, job.payload.telegramMessageId, job.payload.text]),
    ).toEqual([
      [11, 101, 'Game ended'],
      [11, 102, 'Game ended'],
      [11, 103, 'Game ended'],
    ]);
    const results = all.filter(
      (job) => job.kind === 'send_dm' && job.payload.template === 'result',
    );
    expect(results.map((job) => job.payload.userId)).toEqual([bob.id, bob.id]);
  });

  it("names the deleted player anonymously in the opponent's stubs", async () => {
    const group = await insertGroup(db);
    const alice = await insertUser(db, {
      telegramUserId: 11,
      firstName: 'Alice',
      username: 'alice',
      flairWorn: ['rank_under_1200'],
    });
    const bob = await insertUser(db, { telegramUserId: 22, firstName: 'Bob' });
    const game = await insertGame(db, group.id, alice.id, bob.id);
    const challenge = await insertChallenge(db, group.id, alice.id, bob.id);
    const live = { userId: bob.id, chatId: 22, stub: 'x', sentAt: new Date() };
    await db.insert(dmMessages).values([
      { ...live, kind: 'turn', gameId: game.id, telegramMessageId: 201 },
      { ...live, kind: 'challenge', challengeId: challenge.id, telegramMessageId: 202 },
    ]);

    await deleteMyData(deps, alice.id);

    const retires = (await db.select().from(jobs).orderBy(jobs.id)).filter(
      (job) => job.kind === 'retire_dm',
    );
    expect(retires.map((job) => [job.payload.telegramMessageId, job.payload.text])).toEqual([
      [201, 'Game vs Deleted player ended'],
      [202, 'Challenge from Deleted player cancelled'],
    ]);
  });

  it('does not deadlock with a DM being recorded for the same game', async () => {
    // send_dm's record step locks the game row, then writes the user's dm_messages row;
    // deleteMyData must take the game lock before touching that user's DM rows.
    const group = await insertGroup(db);
    const alice = await insertUser(db, { telegramUserId: 11, firstName: 'Alice' });
    const bob = await insertUser(db, { firstName: 'Bob' });
    const game = await insertGame(db, group.id, alice.id, bob.id);
    await recordDm(db, {
      userId: alice.id,
      chatId: 11,
      gameId: game.id,
      telegramMessageId: 101,
      kind: 'turn',
      stub: 'x',
    });
    let deleting: Promise<void> | undefined;
    await db.transaction(async (tx) => {
      await tx.select().from(games).where(eq(games.id, game.id)).for('update');
      deleting = deleteMyData(deps, alice.id);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await recordDm(tx, {
        userId: alice.id,
        chatId: 11,
        gameId: game.id,
        telegramMessageId: 102,
        kind: 'turn',
        stub: 'x',
      });
    });
    await expect(deleting).resolves.toBeUndefined();
    expect(await db.select().from(dmMessages)).toEqual([]);
  });
});
