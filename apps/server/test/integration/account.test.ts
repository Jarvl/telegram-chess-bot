import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { dmMessages, jobs } from '../../src/db/schema';
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
});
