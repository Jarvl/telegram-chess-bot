import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ratings, users } from '../../src/db/schema';
import {
  ensureGroup,
  getGroupByChatId,
  migrateChatId,
  settingsOf,
  updateGroupSettings,
} from '../../src/domain/groups';
import {
  blockUser,
  isBlocked,
  listKnownPlayers,
  markLeft,
  touchMember,
  unblockUser,
} from '../../src/domain/members';
import { ensureUser, prefsOf, recordWriteAccess, updatePrefs } from '../../src/domain/users';
import { openTestDb, truncateAll } from '../helpers/db';
import { insertGroup, insertUser } from '../helpers/fixtures';

const { db, close } = openTestDb();

beforeEach(() => truncateAll(db));
afterAll(() => close());

describe('users', () => {
  it('creates a user once and refreshes the name on later sightings', async () => {
    const first = await ensureUser(db, {
      telegramUserId: 42,
      firstName: 'Alice',
      username: 'alice',
    });
    const second = await ensureUser(db, {
      telegramUserId: 42,
      firstName: 'Alicia',
      username: null,
    });
    expect(second.id).toBe(first.id);
    expect(second.firstName).toBe('Alicia');
    expect(second.username).toBeNull();
    expect(prefsOf(second)).toEqual({
      closeAfterMove: true,
      notifications: true,
      moveConfirmations: 'people',
      boardTheme: null,
      pieceSet: null,
    });
  });

  it('merges preference updates over the defaults', async () => {
    const user = await ensureUser(db, { telegramUserId: 42, firstName: 'Alice' });
    await updatePrefs(db, user.id, { closeAfterMove: false });
    const prefs = await updatePrefs(db, user.id, { boardTheme: 'wood' });
    expect(prefs).toMatchObject({ closeAfterMove: false, notifications: true, boardTheme: 'wood' });
  });

  it('reads a pre-#16 confirmMoves: false as Never and leaves the retired key out', () => {
    const prefs = prefsOf({ prefs: { confirmMoves: false, notifications: false } as never });
    expect(prefs).not.toHaveProperty('confirmMoves');
    expect(prefs.moveConfirmations).toBe('never');
    expect(prefs.notifications).toBe(false);
  });

  it('reads confirmMoves: true, or no stored choice, as the default', () => {
    expect(prefsOf({ prefs: { confirmMoves: true } as never }).moveConfirmations).toBe('people');
    expect(prefsOf({ prefs: {} }).moveConfirmations).toBe('people');
  });

  it('lets a stored move confirmations choice win over the retired key', async () => {
    expect(
      prefsOf({ prefs: { confirmMoves: false, moveConfirmations: 'always' } as never })
        .moveConfirmations,
    ).toBe('always');
    // Turned confirmations off before #16, now picks Only against people.
    const user = await ensureUser(db, { telegramUserId: 42, firstName: 'Alice' });
    await db
      .update(users)
      .set({ prefs: { confirmMoves: false } as never })
      .where(eq(users.id, user.id));
    expect(
      (await updatePrefs(db, user.id, { moveConfirmations: 'people' })).moveConfirmations,
    ).toBe('people');
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(prefsOf(row!).moveConfirmations).toBe('people');
  });

  it('validates preference updates and drops unknown keys', async () => {
    const user = await ensureUser(db, { telegramUserId: 42, firstName: 'Alice' });
    const prefs = await updatePrefs(db, user.id, { pieceSet: 'merida', nope: 1 } as never);
    expect(prefs).not.toHaveProperty('nope');
    expect(prefs.pieceSet).toBe('merida');
    await expect(
      updatePrefs(db, user.id, { closeAfterMove: 'yes' } as never),
    ).rejects.toMatchObject({
      code: 'validation',
    });
  });

  it('records the write-access prompt result', async () => {
    const user = await ensureUser(db, { telegramUserId: 42, firstName: 'Alice' });
    await recordWriteAccess(db, user.id, true);
    const again = await ensureUser(db, { telegramUserId: 42, firstName: 'Alice' });
    expect(again.dmAllowed).toBe(true);
    expect(again.writeAccessAskedAt).not.toBeNull();
  });
});

describe('groups', () => {
  it('creates a group with a public id and updates its title later', async () => {
    const first = await ensureGroup(db, {
      telegramChatId: -100123,
      title: 'Club',
      type: 'supergroup',
    });
    const second = await ensureGroup(db, {
      telegramChatId: -100123,
      title: 'Chess Club',
      type: 'supergroup',
      isForum: true,
    });
    expect(second.id).toBe(first.id);
    expect(second.publicId).toBe(first.publicId);
    expect(second.publicId).toHaveLength(10);
    expect(second.title).toBe('Chess Club');
    expect(second.isForum).toBe(true);
  });

  it('merges settings over the defaults and validates the result', async () => {
    const group = await ensureGroup(db, { telegramChatId: -1, title: 'Club', type: 'group' });
    expect(settingsOf(group).leaderboardMinGames).toBe(5);
    const updated = await updateGroupSettings(db, group.id, { leaderboardMinGames: 3 });
    expect(updated).toMatchObject({ leaderboardMinGames: 3, ratedDefault: true });
    await expect(
      updateGroupSettings(db, group.id, { leaderboardMinGames: -1 }),
    ).rejects.toMatchObject({
      code: 'validation',
    });
  });

  it('follows a group to supergroup migration', async () => {
    const group = await ensureGroup(db, { telegramChatId: -1, title: 'Club', type: 'group' });
    await migrateChatId(db, -1, -1001);
    expect((await getGroupByChatId(db, -1001))?.id).toBe(group.id);
    expect(await getGroupByChatId(db, -1)).toBeNull();
  });
});

describe('members', () => {
  it('lists known players newest-seen first, excluding blocked, left, deleted and the viewer', async () => {
    const group = await insertGroup(db);
    const viewer = await insertUser(db, { firstName: 'Viewer' });
    const alice = await insertUser(db, { firstName: 'Alice' });
    const bob = await insertUser(db, { firstName: 'Bob' });
    const carol = await insertUser(db, { firstName: 'Carol' });
    const dave = await insertUser(db, { firstName: 'Dave' });
    const erin = await insertUser(db, { firstName: 'Erin', deletedAt: new Date() });
    for (const user of [viewer, alice, bob, carol, dave, erin])
      await touchMember(db, group.id, user.id);
    await db
      .insert(ratings)
      .values({ groupId: group.id, userId: alice.id, rating: 1600.4, rd: 60, volatility: 0.06 });
    await blockUser(db, group.id, carol.id, viewer.id);
    await markLeft(db, group.id, dave.id);
    await touchMember(db, group.id, alice.id);

    const players = await listKnownPlayers(db, group.id, { excludeUserId: viewer.id });
    expect(players.map((p) => p.name)).toEqual(['Alice', 'Bob']);
    expect(players[0]).toMatchObject({ id: String(alice.id), rating: 1600, provisional: false });
    expect(players[1]).toMatchObject({ rating: 1500, provisional: true });
  });

  it('blocks and unblocks a user', async () => {
    const group = await insertGroup(db);
    const admin = await insertUser(db);
    const user = await insertUser(db);
    expect(await isBlocked(db, group.id, user.id)).toBe(false);
    await blockUser(db, group.id, user.id, admin.id);
    expect(await isBlocked(db, group.id, user.id)).toBe(true);
    await unblockUser(db, group.id, user.id);
    expect(await isBlocked(db, group.id, user.id)).toBe(false);
  });
});
