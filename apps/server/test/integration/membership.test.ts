import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { groupMembers } from '../../src/db/schema';
import { touchMember } from '../../src/domain/members';
import { createTelegramApi } from '../../src/telegram/client';
import { Membership } from '../../src/telegram/membership';
import { testConfig } from '../helpers/config';
import { openTestDb, testDeps, truncateAll } from '../helpers/db';
import { FakeTelegram } from '../helpers/fakeTelegram';
import { insertGroup, insertUser } from '../helpers/fixtures';

const { db, close } = openTestDb();
const deps = testDeps(db);
let fake: FakeTelegram;
let membership: Membership;

beforeAll(async () => {
  fake = await FakeTelegram.start();
  membership = new Membership(
    deps,
    createTelegramApi(testConfig(), { apiRoot: fake.url, throttle: false }),
  );
});
beforeEach(async () => {
  await truncateAll(db);
  fake.reset();
  membership.clearCaches();
});
afterAll(async () => {
  await fake.stop();
  await close();
});

describe('Membership.verify', () => {
  it('asks Telegram, records the verdict and serves it from the cache afterwards', async () => {
    const group = await insertGroup(db);
    const user = await insertUser(db, { telegramUserId: 11 });
    fake.members.set(11, 'member');
    expect(await membership.verify(group, user)).toBe(true);
    expect(await membership.verify(group, user)).toBe(true);
    expect(fake.callsTo('getChatMember')).toHaveLength(1);
    expect((await db.select().from(groupMembers))[0]?.verifiedAt).not.toBeNull();
  });

  it('marks a user who left, refuses them and caches the denial for a minute', async () => {
    const group = await insertGroup(db);
    const user = await insertUser(db, { telegramUserId: 11 });
    await touchMember(db, group.id, user.id);
    fake.members.set(11, 'kicked');
    expect(await membership.verify(group, user)).toBe(false);
    expect(await membership.verify(group, user)).toBe(false);
    expect(fake.callsTo('getChatMember')).toHaveLength(1);
    const [row] = await db.select().from(groupMembers);
    expect(row?.status).toBe('left');
    expect(row?.verifiedAt).not.toBeNull();
  });

  it('answers concurrent lookups for many users without pacing them like messages', async () => {
    const group = await insertGroup(db);
    const people = await Promise.all(
      Array.from({ length: 12 }, (_, index) => insertUser(db, { telegramUserId: 100 + index })),
    );
    for (const person of people) fake.members.set(person.telegramUserId!, 'member');
    const started = Date.now();
    const verdicts = await Promise.all(people.map((person) => membership.verify(group, person)));
    expect(verdicts.every(Boolean)).toBe(true);
    expect(fake.callsTo('getChatMember')).toHaveLength(12);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('falls back to the bot’s own evidence when Telegram cannot answer', async () => {
    const group = await insertGroup(db);
    const seen = await insertUser(db, { telegramUserId: 11 });
    const stranger = await insertUser(db, { telegramUserId: 12 });
    await touchMember(db, group.id, seen.id);
    fake.memberError = { error_code: 400, description: 'Bad Request: user not found' };
    expect(await membership.verify(group, seen)).toBe(true);
    expect(await membership.verify(group, stranger)).toBe(false);
  });

  it('accepts restricted members who are still in the group', async () => {
    const group = await insertGroup(db);
    const user = await insertUser(db, { telegramUserId: 11 });
    fake.members.set(11, 'restricted');
    expect(await membership.verify(group, user)).toBe(true);
  });
});

describe('Membership.isAdmin', () => {
  it('uses getChatAdministrators and caches the list for a minute', async () => {
    const group = await insertGroup(db);
    const admin = await insertUser(db, { telegramUserId: 11 });
    const member = await insertUser(db, { telegramUserId: 12 });
    fake.admins = [11];
    expect(await membership.isAdmin(group, admin)).toBe(true);
    expect(await membership.isAdmin(group, member)).toBe(false);
    expect(fake.callsTo('getChatAdministrators')).toHaveLength(1);
    membership.invalidateAdmins(group.id);
    await membership.isAdmin(group, member);
    expect(fake.callsTo('getChatAdministrators')).toHaveLength(2);
  });
});
