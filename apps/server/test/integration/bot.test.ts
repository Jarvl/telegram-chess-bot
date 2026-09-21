import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Bot } from 'grammy';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createBot } from '../../src/bot/bot';
import { webhookRoutes } from '../../src/bot/webhook';
import {
  challenges,
  games,
  groupMembers,
  groups,
  jobs,
  telegramUpdates,
  users,
} from '../../src/db/schema';
import { updateGroupSettings } from '../../src/domain/groups';
import { touchMember } from '../../src/domain/members';
import { testConfig } from '../helpers/config';
import { openTestDb, testDeps, truncateAll } from '../helpers/db';
import { FakeTelegram } from '../helpers/fakeTelegram';
import { insertChallenge, insertGame, insertGroup, insertUser } from '../helpers/fixtures';
import {
  callbackUpdate,
  chatMemberUpdate,
  commandUpdate,
  myChatMemberUpdate,
  privateChat,
  serviceUpdate,
  supergroup,
  tgUser,
} from '../helpers/updates';

const { db, close } = openTestDb();
const deps = testDeps(db);
let fake: FakeTelegram;
let bot: Bot;
let app: Hono;
const config = testConfig();

const chat = supergroup(-1001000000001);
const alice = tgUser(11, 'Alice', 'alice');
const bob = tgUser(22, 'Bob');
const carol = tgUser(33, 'Carol', 'carol');

beforeAll(async () => {
  fake = await FakeTelegram.start();
  bot = await createBot(deps, { ...config, TELEGRAM_API_ROOT: fake.url });
  app = new Hono().route('/', webhookRoutes(bot, deps, config));
});
beforeEach(async () => {
  await truncateAll(db);
  fake.reset();
});
afterAll(async () => {
  await fake.stop();
  await close();
});

const post = (update: unknown, secret: string | null = config.WEBHOOK_SECRET) =>
  app.request('/telegram/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(secret ? { 'x-telegram-bot-api-secret-token': secret } : {}),
    },
    body: JSON.stringify(update),
  });
const jobRows = () => db.select().from(jobs).orderBy(jobs.id);
const messagesSent = async () =>
  (await jobRows()).filter((job) => job.kind === 'send_message').map((job) => job.payload);

describe('webhook', () => {
  it('rejects a missing or wrong secret and records nothing', async () => {
    expect((await post(commandUpdate({ chat, from: alice, text: '/play' }), null)).status).toBe(
      401,
    );
    expect((await post(commandUpdate({ chat, from: alice, text: '/play' }), 'nope')).status).toBe(
      401,
    );
    expect(await db.select().from(telegramUpdates)).toHaveLength(0);
  });

  it('acknowledges a duplicate update without repeating its effects', async () => {
    const update = commandUpdate({ chat, from: alice, text: '/play', replyTo: { from: bob } });
    expect((await post(update)).status).toBe(200);
    expect((await post(update)).status).toBe(200);
    expect(await db.select().from(challenges)).toHaveLength(1);
    expect((await jobRows()).map((job) => job.kind)).toEqual(['send_challenge_card', 'send_dm']);
    expect((await db.select().from(telegramUpdates)).map((row) => row.updateId)).toEqual([
      update.update_id,
    ]);
  });
});

describe('/play', () => {
  it('creates a direct challenge from a reply inside the topic and records both members', async () => {
    await post(
      commandUpdate({
        chat,
        from: alice,
        text: '/play@TestChessBot',
        replyTo: { from: bob },
        threadId: 77,
      }),
    );
    const [challenge] = await db.select().from(challenges);
    const people = await db.select().from(users).orderBy(users.telegramUserId);
    expect(people.map((u) => [u.telegramUserId, u.firstName, u.username])).toEqual([
      [11, 'Alice', 'alice'],
      [22, 'Bob', null],
    ]);
    expect(challenge).toMatchObject({
      challengerId: people[0]!.id,
      opponentId: people[1]!.id,
      threadId: 77,
      timePerMove: 86400,
      rated: true,
      challengerColour: 'random',
    });
    expect(await db.select().from(groupMembers)).toHaveLength(2);
    expect((await db.select().from(groups))[0]?.telegramChatId).toBe(chat.id);
  });

  it('creates an open challenge without a reply, or explains when the group forbids them', async () => {
    await post(commandUpdate({ chat, from: alice, text: '/play' }));
    expect((await db.select().from(challenges))[0]?.opponentId).toBeNull();
    const [group] = await db.select().from(groups);
    await updateGroupSettings(db, group!.id, { allowOpenChallenges: false });
    const update = commandUpdate({ chat, from: alice, text: '/play' });
    await post(update);
    expect(await db.select().from(challenges)).toHaveLength(1);
    expect(await messagesSent()).toEqual([
      expect.objectContaining({
        chatId: chat.id,
        text: 'Open challenges are off in this group.',
        replyToMessageId: update.message!.message_id,
      }),
    ]);
  });

  it('replies with one line for a self-challenge, a bot or an anonymous author', async () => {
    await post(commandUpdate({ chat, from: alice, text: '/play', replyTo: { from: alice } }));
    await post(
      commandUpdate({
        chat,
        from: alice,
        text: '/play',
        replyTo: { from: { ...bob, is_bot: true } },
      }),
    );
    await post(commandUpdate({ chat, from: alice, text: '/play', replyTo: { senderChat: true } }));
    expect((await messagesSent()).map((p) => (p as { text: string }).text)).toEqual([
      "You can't challenge yourself.",
      "Bots don't play here.",
      'Reply to a message from a person to challenge them.',
    ]);
    expect(await db.select().from(challenges)).toHaveLength(0);
  });

  it('ignores commands addressed to another bot', async () => {
    await post(
      commandUpdate({ chat, from: alice, text: '/play@OtherBot', replyTo: { from: bob } }),
    );
    expect(await db.select().from(challenges)).toHaveLength(0);
    expect(await jobRows()).toHaveLength(0);
  });
});

describe('/chess, /settings and /start', () => {
  it('posts an Open Chess button once per group per minute', async () => {
    await post(commandUpdate({ chat, from: alice, text: '/chess' }));
    await post(commandUpdate({ chat, from: bob, text: '/chess' }));
    const [group] = await db.select().from(groups);
    const sent = await messagesSent();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      chatId: chat.id,
      buttons: [
        {
          text: '♟ Open Chess',
          url: `https://t.me/TestChessBot/chess?startapp=l_${group!.publicId}`,
        },
      ],
    });
  });

  it('posts an Open settings button', async () => {
    await post(commandUpdate({ chat, from: alice, text: '/settings' }));
    const [group] = await db.select().from(groups);
    expect((await messagesSent())[0]).toMatchObject({
      buttons: [
        {
          text: 'Open settings',
          url: `https://t.me/TestChessBot/chess?startapp=s_${group!.publicId}`,
        },
      ],
    });
  });

  it('marks DMs allowed on /start in private and sends the Open Chess button there', async () => {
    await post(commandUpdate({ chat: privateChat(alice), from: alice, text: '/start' }));
    const [user] = await db.select().from(users);
    expect(user?.dmAllowed).toBe(true);
    expect((await messagesSent())[0]).toMatchObject({
      chatId: alice.id,
      buttons: [{ text: '♟ Open Chess', url: 'https://t.me/TestChessBot/chess' }],
    });
  });
});

describe('callbacks', () => {
  async function pendingChallenge() {
    const group = await insertGroup(db, { telegramChatId: chat.id });
    const a = await insertUser(db, {
      telegramUserId: alice.id,
      firstName: 'Alice',
      username: 'alice',
    });
    const b = await insertUser(db, { telegramUserId: bob.id, firstName: 'Bob' });
    await touchMember(db, group.id, a.id);
    await touchMember(db, group.id, b.id);
    const challenge = await insertChallenge(db, group.id, a.id, b.id, { messageId: 900 });
    return { group, a, b, challenge };
  }

  it('lets the challenged player accept silently and tells anyone else who may', async () => {
    const { challenge } = await pendingChallenge();
    await post(callbackUpdate({ from: carol, chat, data: `ch/acc/${challenge.publicId}` }));
    expect(fake.callsTo('answerCallbackQuery').at(-1)?.body).toMatchObject({
      text: 'Only Bob can accept this challenge.',
      show_alert: true,
    });
    expect(await db.select().from(games)).toHaveLength(0);
    await post(callbackUpdate({ from: bob, chat, data: `ch/acc/${challenge.publicId}` }));
    expect(fake.callsTo('answerCallbackQuery').at(-1)?.body).not.toHaveProperty('text');
    const [game] = await db.select().from(games);
    expect(game?.cardMessageId).toBe(900);
  });

  it('reports a challenge that someone else already accepted', async () => {
    const { challenge } = await pendingChallenge();
    await db.update(challenges).set({ status: 'accepted' }).where(eq(challenges.id, challenge.id));
    await post(callbackUpdate({ from: bob, chat, data: `ch/acc/${challenge.publicId}` }));
    expect(fake.callsTo('answerCallbackQuery').at(-1)?.body).toMatchObject({
      text: 'Someone accepted first.',
    });
  });

  it('treats Decline as a withdrawal for the challenger and a decline for the opponent', async () => {
    const first = await pendingChallenge();
    await post(callbackUpdate({ from: alice, chat, data: `ch/dec/${first.challenge.publicId}` }));
    expect(
      (await db.select().from(challenges).where(eq(challenges.id, first.challenge.id)))[0]?.status,
    ).toBe('cancelled');
    const second = await insertChallenge(db, first.group.id, first.a.id, first.b.id);
    await post(callbackUpdate({ from: bob, chat, data: `ch/dec/${second.publicId}` }));
    expect(
      (await db.select().from(challenges).where(eq(challenges.id, second.id)))[0]?.status,
    ).toBe('declined');
  });

  it('creates a reversed rematch for a player and refuses a spectator', async () => {
    const { group, a, b } = await pendingChallenge();
    const game = await insertGame(db, group.id, a.id, b.id, {
      status: 'finished',
      result: '1-0',
      endReason: 'checkmate',
      finishedAt: new Date(),
    });
    await post(callbackUpdate({ from: carol, chat, data: `gm/rem/${game.publicId}` }));
    expect(fake.callsTo('answerCallbackQuery').at(-1)?.body).toMatchObject({
      text: 'Only the players can ask for a rematch.',
    });
    await post(callbackUpdate({ from: bob, chat, data: `gm/rem/${game.publicId}` }));
    const rematch = (await db.select().from(challenges)).find((row) => row.challengerId === b.id);
    expect(rematch).toMatchObject({ opponentId: a.id, challengerColour: 'white' });
  });
});

describe('membership events', () => {
  it('welcomes the bot when it is added and marks it admin-capable', async () => {
    await post(
      myChatMemberUpdate({
        chat,
        from: alice,
        oldStatus: 'left',
        newStatus: 'administrator',
        canPin: true,
      }),
    );
    const [group] = await db.select().from(groups);
    expect(group).toMatchObject({ botStatus: 'administrator', botIsAdmin: true, botCanPin: true });
    expect((await jobRows()).map((job) => [job.kind, job.dedupKey])).toEqual([
      ['send_welcome', `welcome:${group!.publicId}`],
    ]);
  });

  it('cancels pending challenges when the bot is removed', async () => {
    const group = await insertGroup(db, { telegramChatId: chat.id });
    const a = await insertUser(db);
    const b = await insertUser(db);
    await insertChallenge(db, group.id, a.id, b.id);
    await post(myChatMemberUpdate({ chat, from: alice, oldStatus: 'member', newStatus: 'kicked' }));
    expect((await db.select().from(groups))[0]?.botStatus).toBe('left');
    expect((await db.select().from(challenges))[0]?.status).toBe('cancelled');
  });

  it('records joins and leaves from chat_member and service messages', async () => {
    await insertGroup(db, { telegramChatId: chat.id });
    await post(chatMemberUpdate({ chat, from: alice, user: bob, newStatus: 'member' }));
    let [member] = await db.select().from(groupMembers);
    expect(member?.status).toBe('member');
    expect(member?.verifiedAt).not.toBeNull();
    await post(serviceUpdate(chat, bob, { left_chat_member: bob }));
    [member] = await db.select().from(groupMembers);
    expect(member?.status).toBe('left');
    await post(serviceUpdate(chat, alice, { new_chat_members: [carol] }));
    expect(await db.select().from(groupMembers)).toHaveLength(2);
  });

  it('follows a supergroup migration and a private write-access grant', async () => {
    const basic = { id: -12345, type: 'group' as const, title: 'Old' };
    await insertGroup(db, { telegramChatId: basic.id, type: 'group' });
    await post(serviceUpdate(basic, alice, { migrate_to_chat_id: -1009999 }));
    expect((await db.select().from(groups))[0]?.telegramChatId).toBe(-1009999);
    await post(
      serviceUpdate(privateChat(bob), bob, { write_access_allowed: { from_request: true } }),
    );
    expect((await db.select().from(users))[0]?.dmAllowed).toBe(true);
  });
});
