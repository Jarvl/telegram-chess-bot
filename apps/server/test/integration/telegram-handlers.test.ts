import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { challenges, games, groups, jobs, users } from '../../src/db/schema';
import { enqueue } from '../../src/jobs/queue';
import { telegramJobHandlers } from '../../src/jobs/handlers/telegram';
import { JobWorker } from '../../src/jobs/worker';
import { createTelegramApi } from '../../src/telegram/client';
import { testConfig } from '../helpers/config';
import { openTestDb, testDeps, truncateAll } from '../helpers/db';
import { FakeTelegram } from '../helpers/fakeTelegram';
import {
  insertChallenge,
  insertGame,
  insertGroup,
  insertMove,
  insertUser,
} from '../helpers/fixtures';

const { db, close } = openTestDb();
const deps = testDeps(db);
let fake: FakeTelegram;
let worker: JobWorker;
const CHAT = -1001000000002;
const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';

beforeAll(async () => {
  fake = await FakeTelegram.start();
  const config = testConfig({ TELEGRAM_API_ROOT: fake.url });
  const api = createTelegramApi(config, { apiRoot: fake.url });
  worker = new JobWorker({
    db,
    log: deps.log,
    handlers: telegramJobHandlers({ deps, api, config }),
    workerId: 't',
  });
});
beforeEach(async () => {
  await truncateAll(db);
  fake.reset();
});
afterAll(async () => {
  await fake.stop();
  await close();
});

async function people() {
  const group = await insertGroup(db, {
    telegramChatId: CHAT,
    botStatus: 'administrator',
    botIsAdmin: true,
    botCanPin: true,
  });
  const alice = await insertUser(db, {
    telegramUserId: 11,
    firstName: 'Alice',
    username: 'alice',
    dmAllowed: true,
  });
  const bob = await insertUser(db, { telegramUserId: 22, firstName: 'Bob' });
  return { group, alice, bob };
}
const jobRows = () => db.select().from(jobs).orderBy(jobs.id);

describe('send_challenge_card', () => {
  it('posts the card to the topic and stores the message id', async () => {
    const { group, alice, bob } = await people();
    const challenge = await insertChallenge(db, group.id, alice.id, bob.id, { threadId: 5 });
    await enqueue(db, {
      kind: 'send_challenge_card',
      payload: { challengeId: challenge.id },
      dedupKey: `card:send:${challenge.publicId}`,
    });
    await worker.runOnce();
    const [call] = fake.callsTo('sendMessage');
    expect(call?.body).toMatchObject({
      chat_id: CHAT,
      message_thread_id: 5,
      text: '♟ @alice challenges Bob\n1 day per move · Rated',
    });
    // 'Bob' has no handle, so the card mentions him by entity, after '♟ @alice challenges '.
    expect((call?.body.entities as unknown[])[0]).toMatchObject({
      type: 'text_mention',
      offset: 20,
      length: 3,
    });
    expect((await db.select().from(challenges))[0]?.messageId).toBe(101);
    expect(
      (call?.body.reply_markup as { inline_keyboard: { text: string; url?: string }[][] })
        .inline_keyboard[1],
    ).toEqual([
      {
        text: '♟ Group lobby',
        url: `https://t.me/TestChessBot/chess?startapp=l_${group.publicId}`,
      },
    ]);
  });

  it('hands the message id to a game accepted before the card was sent', async () => {
    const { group, alice, bob } = await people();
    const game = await insertGame(db, group.id, alice.id, bob.id);
    const challenge = await insertChallenge(db, group.id, alice.id, bob.id, {
      status: 'accepted',
      gameId: game.id,
    });
    await enqueue(db, { kind: 'send_challenge_card', payload: { challengeId: challenge.id } });
    await worker.runOnce();
    expect((await db.select().from(games))[0]?.cardMessageId).toBe(101);
    expect(
      (await jobRows()).filter((job) => job.doneAt === null).map((job) => job.dedupKey),
    ).toEqual([`card:g:${game.publicId}`]);
  });
});

describe('edit_card', () => {
  it('edits the running card in place', async () => {
    const { group, alice, bob } = await people();
    const game = await insertGame(db, group.id, alice.id, bob.id, {
      cardMessageId: 900,
      cardThreadId: 5,
      fen: AFTER_E4,
      plyCount: 1,
    });
    await enqueue(db, {
      kind: 'edit_card',
      payload: { gameId: game.id },
      dedupKey: `card:g:${game.publicId}`,
    });
    await worker.runOnce();
    const [call] = fake.callsTo('editMessageText');
    expect(call?.body).toMatchObject({
      chat_id: CHAT,
      message_id: 900,
      text: '♟ @alice (1500?) vs Bob (1500?)\n1 day per move · Rated · Move 1 · Bob to move',
    });
    expect(
      (call?.body.reply_markup as { inline_keyboard: { text: string; url?: string }[][] })
        .inline_keyboard[1],
    ).toEqual([
      {
        text: '♟ Group lobby',
        url: `https://t.me/TestChessBot/chess?startapp=l_${group.publicId}`,
      },
    ]);
  });

  it('retries an edit for a card that has no message id yet', async () => {
    const { group, alice, bob } = await people();
    const game = await insertGame(db, group.id, alice.id, bob.id);
    await enqueue(db, {
      kind: 'edit_card',
      payload: { gameId: game.id },
      dedupKey: `card:g:${game.publicId}`,
    });
    await worker.runOnce();
    const [job] = await jobRows();
    expect(job).toMatchObject({ attempts: 1, doneAt: null });
    expect(job?.lastError).toMatch(/no message id/);
    expect(fake.callsTo('editMessageText')).toHaveLength(0);
  });

  it('treats "not modified" as done, marks a vanished card missing and waits out a 429', async () => {
    const { group, alice, bob } = await people();
    const game = await insertGame(db, group.id, alice.id, bob.id, { cardMessageId: 900 });
    const run = async () => {
      await enqueue(db, {
        kind: 'edit_card',
        payload: { gameId: game.id },
        dedupKey: `card:g:${game.publicId}`,
      });
      await worker.runOnce();
      return (await jobRows()).at(-1)!;
    };
    fake.failNext('editMessageText', {
      error_code: 400,
      description: 'Bad Request: message is not modified: same',
    });
    expect((await run()).doneAt).not.toBeNull();
    fake.failNext('editMessageText', {
      error_code: 429,
      description: 'Too Many Requests: retry after 3',
      parameters: { retry_after: 3 },
    });
    const waiting = await run();
    expect(waiting.doneAt).toBeNull();
    expect(waiting.lastError).toMatch(/429/);
    await db.delete(jobs);
    fake.failNext('editMessageText', {
      error_code: 400,
      description: 'Bad Request: message to edit not found',
    });
    expect((await run()).doneAt).not.toBeNull();
    expect((await db.select().from(games))[0]?.cardMissing).toBe(true);
  });

  it('renders the challenge card when the challenge is still pending', async () => {
    const { group, alice, bob } = await people();
    const challenge = await insertChallenge(db, group.id, alice.id, bob.id, {
      messageId: 700,
      status: 'declined',
    });
    await enqueue(db, {
      kind: 'edit_card',
      payload: { challengeId: challenge.id },
      dedupKey: `card:ch:${challenge.publicId}`,
    });
    await worker.runOnce();
    expect(fake.callsTo('editMessageText')[0]?.body).toMatchObject({
      message_id: 700,
      text: '♟ @alice vs Bob · Declined',
    });
  });
});

describe('send_dm', () => {
  it('sends nothing to a user who turned notifications off, whatever the template', async () => {
    const { group, alice, bob } = await people();
    await db
      .update(users)
      .set({ prefs: { notifications: false } })
      .where(eq(users.id, alice.id));
    const game = await insertGame(db, group.id, bob.id, alice.id, { fen: AFTER_E4, plyCount: 1 });
    await insertMove(db, game.id, 1, 'e2e4', 'e4', AFTER_E4);
    for (const template of ['turn', 'reminder', 'game_end'] as const)
      await enqueue(db, {
        kind: 'send_dm',
        payload: { userId: alice.id, template, gameId: game.id },
      });
    await worker.runOnce();
    expect(fake.callsTo('sendMessage')).toHaveLength(0);
    expect((await db.select().from(jobs)).every((job) => job.doneAt !== null)).toBe(true);
  });

  it('sends the turn DM with both buttons and skips users who declined DMs', async () => {
    const { group, alice, bob } = await people();
    // Bob is White and has moved; it is Alice's (Black's) turn, and only Alice allows DMs.
    const game = await insertGame(db, group.id, bob.id, alice.id, {
      cardMessageId: 900,
      fen: AFTER_E4,
      plyCount: 1,
    });
    await insertMove(db, game.id, 1, 'e2e4', 'e4', AFTER_E4);
    await enqueue(db, {
      kind: 'send_dm',
      payload: { userId: bob.id, template: 'turn', gameId: game.id },
    });
    await enqueue(db, {
      kind: 'send_dm',
      payload: { userId: alice.id, template: 'turn', gameId: game.id },
    });
    await worker.runOnce();
    const sent = fake.callsTo('sendMessage');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toMatchObject({
      chat_id: 11,
      text: 'Your move vs Bob · 1. e4 · 23 h left',
    });
    expect(sent[0]?.body.reply_markup).toEqual({
      inline_keyboard: [
        [
          {
            text: '♟ Open game',
            url: `https://t.me/TestChessBot/chess?startapp=g_${game.publicId}`,
          },
        ],
        [{ text: 'Go to group', url: 'https://t.me/c/1000000002/900' }],
      ],
    });
  });

  it('sends the challenge DM and turns DMs off when the user blocked the bot', async () => {
    const { group, alice, bob } = await people();
    const challenge = await insertChallenge(db, group.id, bob.id, alice.id);
    await enqueue(db, {
      kind: 'send_dm',
      payload: { userId: alice.id, template: 'challenge', challengeId: challenge.id },
    });
    await worker.runOnce();
    expect(fake.callsTo('sendMessage')[0]?.body).toMatchObject({
      chat_id: 11,
      text: 'Bob challenges you · 1 day per move · Rated',
    });
    fake.failNext('sendMessage', {
      error_code: 403,
      description: 'Forbidden: bot was blocked by the user',
    });
    await enqueue(db, {
      kind: 'send_dm',
      payload: { userId: alice.id, template: 'challenge', challengeId: challenge.id },
    });
    await worker.runOnce();
    expect((await db.select().from(users).where(eq(users.id, alice.id)))[0]?.dmAllowed).toBe(false);
    expect((await jobRows()).every((job) => job.doneAt !== null)).toBe(true);
  });

  it('sends the game-end DM with the rating change and the analysis link', async () => {
    const { group, alice, bob } = await people();
    const game = await insertGame(db, group.id, alice.id, bob.id, {
      status: 'finished',
      result: '1-0',
      endReason: 'resignation',
      finishedAt: new Date(),
      plyCount: 1,
      fen: AFTER_E4,
      whiteRatingBefore: 1500,
      whiteRatingAfter: 1534.4,
      whiteRdBefore: 350,
      whiteRdAfter: 290,
      blackRatingBefore: 1500,
      blackRatingAfter: 1465.6,
      blackRdBefore: 350,
      blackRdAfter: 290,
    });
    await insertMove(db, game.id, 1, 'e2e4', 'e4', AFTER_E4);
    await enqueue(db, {
      kind: 'send_dm',
      payload: { userId: alice.id, template: 'game_end', gameId: game.id },
    });
    await worker.runOnce();
    const [call] = fake.callsTo('sendMessage');
    expect(call?.body.text).toBe('1-0 vs Bob · Resignation · 1500? → 1534?');
    expect(
      (call?.body.reply_markup as { inline_keyboard: { text: string }[][] }).inline_keyboard
        .flat()
        .map((b) => b.text),
    ).toEqual(['♟ Open game', '🔍 Analyse on Lichess']);
  });

  it('adds the cancelled line to the turn DM when the premoves were cancelled', async () => {
    const { group, alice, bob } = await people();
    const game = await insertGame(db, group.id, bob.id, alice.id, {
      cardMessageId: 900,
      fen: AFTER_E4,
      plyCount: 1,
    });
    await insertMove(db, game.id, 1, 'e2e4', 'e4', AFTER_E4);
    await enqueue(db, {
      kind: 'send_dm',
      payload: { userId: alice.id, template: 'turn', gameId: game.id, premovesCancelled: true },
    });
    await worker.runOnce();
    expect(fake.callsTo('sendMessage')[0]?.body).toMatchObject({
      chat_id: 11,
      text: 'Your move vs Bob · 1. e4 · 23 h left\n\nYour premoves were cancelled.',
    });
  });
});

describe('send_welcome and send_message', () => {
  it('posts and pins the welcome card and stores its id', async () => {
    const { group } = await people();
    await enqueue(db, { kind: 'send_welcome', payload: { groupId: group.id } });
    await worker.runOnce();
    expect(fake.callsTo('sendMessage')[0]?.body.reply_markup).toEqual({
      inline_keyboard: [
        [
          {
            text: '♟ Open Chess',
            url: `https://t.me/TestChessBot/chess?startapp=l_${group.publicId}`,
          },
        ],
      ],
    });
    expect(fake.callsTo('pinChatMessage')[0]?.body).toMatchObject({
      chat_id: CHAT,
      message_id: 101,
      disable_notification: true,
    });
    expect((await db.select().from(groups))[0]?.welcomeMessageId).toBe(101);
  });

  it('sends a one-line reply in the thread and marks the group left when the bot was kicked', async () => {
    await people();
    await enqueue(db, {
      kind: 'send_message',
      payload: { chatId: CHAT, threadId: 5, text: 'Nope.', replyToMessageId: 44 },
    });
    await worker.runOnce();
    expect(fake.callsTo('sendMessage')[0]?.body).toMatchObject({
      chat_id: CHAT,
      message_thread_id: 5,
      text: 'Nope.',
      reply_parameters: { message_id: 44, allow_sending_without_reply: true },
    });
    fake.failNext('sendMessage', {
      error_code: 403,
      description: 'Forbidden: bot was kicked from the supergroup chat',
    });
    await enqueue(db, {
      kind: 'send_message',
      payload: { chatId: CHAT, threadId: null, text: 'Hi' },
    });
    await worker.runOnce();
    expect((await db.select().from(groups))[0]?.botStatus).toBe('left');
  });
});
