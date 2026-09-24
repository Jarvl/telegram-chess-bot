import {
  decodeCallbackData,
  t,
  type GroupSettings,
  type MessageKey,
  type MessageParams,
} from '@group-chess/shared';
import { apiThrottler } from '@grammyjs/transformer-throttler';
import { Bot, type Context } from 'grammy';
import type { Chat, User } from 'grammy/types';
import type { Config } from '../config';
import {
  acceptChallenge,
  cancelChallenge,
  createChallenge,
  createRematch,
  declineChallenge,
  getChallengeByPublicId,
} from '../domain/challenges';
import type { Deps } from '../domain/deps';
import { DomainError } from '../domain/errors';
import { requireGameById, requireGameByPublicId } from '../domain/games';
import { cancelPendingChallengesForGroup } from '../domain/groupLifecycle';
import {
  ensureGroup,
  getGroupByChatId,
  migrateChatId,
  setBotMembership,
  settingsOf,
  type TelegramChatInfo,
} from '../domain/groups';
import { markLeft, touchMember } from '../domain/members';
import { getPendingShare } from '../domain/sharing';
import { ensureUser, setDmAllowed, type TelegramUserInfo } from '../domain/users';
import { enqueue } from '../jobs/queue';
import { miniAppLink } from '../telegram/links';
import { inlineShareResult, loadShareView } from '../telegram/share';
import { RateLimiter } from './rateLimit';
import { alertFor, replyFor } from './replies';

type GroupChat = Chat.GroupChat | Chat.SupergroupChat;

const userInfo = (user: User): TelegramUserInfo => ({
  telegramUserId: user.id,
  firstName: user.first_name,
  username: user.username ?? null,
  languageCode: user.language_code ?? null,
});

const chatInfo = (chat: GroupChat): TelegramChatInfo => ({
  telegramChatId: chat.id,
  title: chat.title,
  type: chat.type,
  isForum: chat.type === 'supergroup' && chat.is_forum === true,
});

/** Cards go to the topic the challenge was made in, or to the configured fixed topic (spec §5.8). */
function cardThread(settings: GroupSettings, originThread: number | null): number | null {
  return settings.cardTopicMode === 'fixed' ? settings.fixedTopicId : originThread;
}

function isGroupChat(chat: Chat): chat is GroupChat {
  return chat.type === 'group' || chat.type === 'supergroup';
}

export async function createBot(deps: Deps, config: Config): Promise<Bot> {
  const bot = new Bot(
    config.BOT_TOKEN,
    config.TELEGRAM_API_ROOT ? { client: { apiRoot: config.TELEGRAM_API_ROOT } } : {},
  );
  bot.api.config.use(apiThrottler());
  await bot.init();
  const linkLimiter = new RateLimiter(1, 60_000);

  const sendLine = (
    chatId: number,
    threadId: number | null,
    key: MessageKey,
    params: MessageParams,
    extra: { replyToMessageId?: number; buttons?: { text: string; url: string }[] } = {},
  ) =>
    enqueue(deps.db, {
      kind: 'send_message',
      payload: { chatId, threadId, text: t(key, params), ...extra },
    });

  const groupOnly = bot.chatType(['group', 'supergroup']);

  groupOnly.command('play', async (ctx) => {
    const from = ctx.from;
    if (!from || from.is_bot || ctx.msg.sender_chat) return;
    const group = await ensureGroup(deps.db, chatInfo(ctx.chat));
    const user = await ensureUser(deps.db, userInfo(from));
    await touchMember(deps.db, group.id, user.id);
    const threadId = ctx.msg.is_topic_message ? (ctx.msg.message_thread_id ?? null) : null;
    const reply = (key: MessageKey, params: MessageParams = {}) =>
      sendLine(ctx.chat.id, threadId, key, params, { replyToMessageId: ctx.msg.message_id });
    const target = ctx.msg.reply_to_message;
    let opponentId: number | null = null;
    if (target) {
      if (target.sender_chat || !target.from) return reply('reply.anonymous');
      if (target.from.is_bot) return reply('reply.bot');
      if (target.from.id === from.id) return reply('reply.self');
      const opponent = await ensureUser(deps.db, userInfo(target.from));
      await touchMember(deps.db, group.id, opponent.id);
      opponentId = opponent.id;
    }
    const settings = settingsOf(group);
    try {
      await createChallenge(deps, {
        groupId: group.id,
        challengerId: user.id,
        opponentId,
        timePerMove: settings.defaultTimePerMove,
        colour: 'random',
        rated: settings.ratedDefault,
        threadId: cardThread(settings, threadId),
      });
    } catch (error) {
      const line = replyFor(error);
      if (!line) throw error;
      await reply(line.key, line.params);
    }
  });

  const linkCommand =
    (kind: 'lobby' | 'settings') =>
    async (ctx: Context & { chat: GroupChat; msg: NonNullable<Context['msg']> }) => {
      if (!ctx.from || ctx.from.is_bot) return;
      // /chess and /settings share one link per group per minute (spec §7.8).
      if (!linkLimiter.allow(`link:${ctx.chat.id}`)) return;
      const group = await ensureGroup(deps.db, chatInfo(ctx.chat));
      const user = await ensureUser(deps.db, userInfo(ctx.from));
      await touchMember(deps.db, group.id, user.id);
      const threadId = ctx.msg.is_topic_message ? (ctx.msg.message_thread_id ?? null) : null;
      await sendLine(
        ctx.chat.id,
        threadId,
        kind === 'lobby' ? 'command.chess' : 'command.settings',
        {},
        {
          buttons: [
            {
              text: t(kind === 'lobby' ? 'button.open_chess' : 'button.open_settings'),
              url: miniAppLink(config, { kind, groupId: group.publicId }),
            },
          ],
        },
      );
    };
  groupOnly.command('chess', linkCommand('lobby'));
  groupOnly.command('settings', linkCommand('settings'));

  bot.chatType('private').command('start', async (ctx) => {
    const user = await ensureUser(deps.db, userInfo(ctx.from));
    await setDmAllowed(deps.db, user.id, true);
    await sendLine(
      ctx.chat.id,
      null,
      'dm.start',
      {},
      {
        buttons: [{ text: t('button.open_chess'), url: miniAppLink(config) }],
      },
    );
  });

  // Spec §7.7: the chat picker the app opened lands here with the bot's username in the input
  // field; offer the position the user staged, whatever they typed after it.
  bot.on('inline_query', async (ctx) => {
    const user = await ensureUser(deps.db, userInfo(ctx.from));
    const pending = await getPendingShare(deps.db, user.id);
    if (!pending) return ctx.answerInlineQuery([], { cache_time: 0, is_personal: true });
    const game = await requireGameById(deps.db, pending.gameId);
    const view = await loadShareView(deps.db, config, game, user.id, pending.ply);
    await ctx.answerInlineQuery([inlineShareResult(config, game, pending.ply, view)], {
      cache_time: 0,
      is_personal: true,
    });
  });

  bot.on('callback_query:data', async (ctx) => {
    const data = decodeCallbackData(ctx.callbackQuery.data);
    if (!data) return ctx.answerCallbackQuery();
    const user = await ensureUser(deps.db, userInfo(ctx.from));
    const chat = ctx.callbackQuery.message?.chat;
    if (chat && isGroupChat(chat)) {
      const group = await getGroupByChatId(deps.db, chat.id);
      if (group) await touchMember(deps.db, group.id, user.id);
    }
    try {
      if (data.action === 'rematch') {
        const game = await requireGameByPublicId(deps.db, data.gameId);
        await createRematch(deps, { gameId: game.id, userId: user.id });
      } else {
        const challenge = await getChallengeByPublicId(deps.db, data.challengeId);
        if (!challenge) throw new DomainError('not_found', 'challenge not found');
        if (data.action === 'accept_challenge') {
          await acceptChallenge(deps, { challengeId: challenge.id, userId: user.id });
        } else if (challenge.challengerId === user.id) {
          await cancelChallenge(deps, { challengeId: challenge.id, userId: user.id });
        } else {
          await declineChallenge(deps, { challengeId: challenge.id, userId: user.id });
        }
      }
      await ctx.answerCallbackQuery();
    } catch (error) {
      const text = await alertFor(deps, error, data.action);
      if (text === null) throw error;
      await ctx.answerCallbackQuery({ text, show_alert: true });
    }
  });

  bot.on('my_chat_member', async (ctx) => {
    const update = ctx.myChatMember;
    const status = update.new_chat_member.status;
    if (update.chat.type === 'private') {
      const user = await ensureUser(deps.db, userInfo(update.from));
      await setDmAllowed(deps.db, user.id, status === 'member');
      return;
    }
    if (!isGroupChat(update.chat)) return;
    const group = await ensureGroup(deps.db, chatInfo(update.chat));
    if (status === 'member' || status === 'administrator') {
      const member = update.new_chat_member;
      const canPin = member.status === 'administrator' && member.can_pin_messages === true;
      await setBotMembership(deps.db, group.id, {
        botStatus: status,
        botIsAdmin: status === 'administrator',
        botCanPin: canPin,
      });
      if (!update.from.is_bot) {
        const adder = await ensureUser(deps.db, userInfo(update.from));
        await touchMember(deps.db, group.id, adder.id);
      }
      const old = update.old_chat_member.status;
      if (old === 'left' || old === 'kicked') {
        await enqueue(deps.db, {
          kind: 'send_welcome',
          payload: { groupId: group.id },
          dedupKey: `welcome:${group.publicId}`,
        });
      }
    } else if (status === 'left' || status === 'kicked') {
      await setBotMembership(deps.db, group.id, {
        botStatus: 'left',
        botIsAdmin: false,
        botCanPin: false,
      });
      await cancelPendingChallengesForGroup(deps, group.id);
    }
  });

  bot.on('chat_member', async (ctx) => {
    const update = ctx.chatMember;
    if (!isGroupChat(update.chat)) return;
    const group = await getGroupByChatId(deps.db, update.chat.id);
    const target = update.new_chat_member.user;
    if (!group || target.is_bot) return;
    const user = await ensureUser(deps.db, userInfo(target));
    const member = update.new_chat_member;
    const present =
      member.status === 'member' ||
      member.status === 'administrator' ||
      member.status === 'creator' ||
      (member.status === 'restricted' && member.is_member);
    if (present) await touchMember(deps.db, group.id, user.id, { verified: true });
    else await markLeft(deps.db, group.id, user.id);
  });

  groupOnly.on('message:new_chat_members', async (ctx) => {
    const group = await ensureGroup(deps.db, chatInfo(ctx.chat));
    for (const joined of ctx.msg.new_chat_members) {
      if (joined.is_bot) continue;
      const user = await ensureUser(deps.db, userInfo(joined));
      await touchMember(deps.db, group.id, user.id);
    }
  });

  groupOnly.on('message:left_chat_member', async (ctx) => {
    const left = ctx.msg.left_chat_member;
    const group = await getGroupByChatId(deps.db, ctx.chat.id);
    if (!group || left.is_bot) return;
    const user = await ensureUser(deps.db, userInfo(left));
    await markLeft(deps.db, group.id, user.id);
  });

  groupOnly.on('message:migrate_to_chat_id', async (ctx) => {
    await migrateChatId(deps.db, ctx.chat.id, ctx.msg.migrate_to_chat_id);
  });

  bot.chatType('private').on('message:write_access_allowed', async (ctx) => {
    const user = await ensureUser(deps.db, userInfo(ctx.from));
    await setDmAllowed(deps.db, user.id, true);
  });

  return bot;
}
