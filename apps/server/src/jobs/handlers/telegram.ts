import {
  analysisUrl,
  endReasonLabel,
  formatTimeLeft,
  isProvisional,
  ratedLabel,
  ratingLabel,
  resultLabel,
  sideToMove,
  t,
  timePerMoveLabel,
  type TimePerMove,
} from '@group-chess/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { InlineKeyboardButton } from 'grammy/types';
import { z } from 'zod';
import type { Config } from '../../config';
import { dbNow } from '../../db/client';
import { games, groups, type GameRow, type UserRow } from '../../db/schema';
import { getChallengeById, setChallengeMessage } from '../../domain/challenges';
import type { Deps } from '../../domain/deps';
import { listMoves, requireGameById } from '../../domain/games';
import { markBotLeft } from '../../domain/groupLifecycle';
import { migrateChatId, requireGroup } from '../../domain/groups';
import { getUserById, requireUser, setDmAllowed, wantsDms } from '../../domain/users';
import {
  renderChallengeCard,
  renderGameCard,
  renderWelcomeCard,
  type RenderedMessage,
} from '../../telegram/cards';
import {
  classifyTelegramError,
  type TelegramApi,
  type TelegramFailure,
} from '../../telegram/client';
import { groupMessageLink, miniAppLink } from '../../telegram/links';
import { challengeCardView, gameCardView } from '../../telegram/views';
import { enqueue } from '../queue';
import type { JobHandler, JobHandlers, JobResult } from '../types';

export type TelegramHandlerContext = { deps: Deps; api: TelegramApi; config: Config };

type CallResult<T> = { ok: true; value: T } | { ok: false; failure: TelegramFailure };

/** Runs one Bot API call and applies the chat-level consequences of spec §11. */
export async function call<T>(
  ctx: TelegramHandlerContext,
  chatId: number | null,
  fn: () => Promise<T>,
): Promise<CallResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    const failure = classifyTelegramError(error);
    if (!failure) throw error;
    if (chatId !== null && failure.kind === 'chat_gone') await markBotLeft(ctx.deps, chatId);
    if (chatId !== null && failure.kind === 'migrated')
      await migrateChatId(ctx.deps.db, chatId, failure.newChatId);
    return { ok: false, failure };
  }
}

/** Job outcome for a failure; `'throw'` means count an attempt and back off. */
export function telegramFailureOutcome(failure: TelegramFailure): JobResult | 'throw' {
  switch (failure.kind) {
    case 'retry_after':
      return {
        outcome: 'retry',
        delayMs: failure.seconds * 1000,
        error: `telegram 429: retry after ${failure.seconds}s`,
      };
    case 'migrated':
      return { outcome: 'retry', delayMs: 1000, error: 'chat migrated' };
    case 'not_modified':
    case 'message_gone':
    case 'blocked':
    case 'chat_gone':
      return { outcome: 'done' };
    case 'other':
      return 'throw';
  }
}

export function settle(result: CallResult<unknown>): JobResult {
  if (result.ok) return { outcome: 'done' };
  const outcome = telegramFailureOutcome(result.failure);
  if (outcome === 'throw')
    throw new Error(`telegram: ${(result.failure as { description: string }).description}`);
  return outcome;
}

const gameCardPayload = z.object({ gameId: z.number().int() });
const challengePayload = z.object({ challengeId: z.number().int() });
const cardPayload = z.union([gameCardPayload, challengePayload]);
const dmPayload = z.object({
  userId: z.number().int(),
  template: z.enum(['turn', 'challenge', 'reminder', 'game_end']),
  gameId: z.number().int().optional(),
  challengeId: z.number().int().optional(),
});
const messagePayload = z.object({
  chatId: z.number().int(),
  threadId: z.number().int().nullable().optional(),
  text: z.string().min(1),
  replyToMessageId: z.number().int().optional(),
  buttons: z.array(z.object({ text: z.string(), url: z.string() })).optional(),
});

function editGameCardJob(game: Pick<GameRow, 'id' | 'publicId'>) {
  return {
    kind: 'edit_card' as const,
    payload: { gameId: game.id },
    dedupKey: `card:g:${game.publicId}`,
  };
}

async function editMessage(
  ctx: TelegramHandlerContext,
  chatId: number,
  messageId: number,
  rendered: RenderedMessage,
) {
  return call(ctx, chatId, () =>
    ctx.api.editMessageText(chatId, messageId, rendered.text, {
      entities: rendered.entities,
      reply_markup: rendered.reply_markup,
    }),
  );
}

async function editGameCard(ctx: TelegramHandlerContext, gameId: number): Promise<JobResult> {
  const game = await requireGameById(ctx.deps.db, gameId);
  if (game.cardMissing) return { outcome: 'done' };
  if (game.cardMessageId === null) throw new Error(`game ${game.id} has no message id yet`);
  const group = await requireGroup(ctx.deps.db, game.groupId);
  if (group.botStatus === 'left') return { outcome: 'done' };
  const rendered = renderGameCard(await gameCardView(ctx.deps.db, game, ctx.config));
  const result = await editMessage(ctx, group.telegramChatId, game.cardMessageId, rendered);
  if (!result.ok && result.failure.kind === 'message_gone') {
    await ctx.deps.db.update(games).set({ cardMissing: true }).where(eq(games.id, game.id));
  }
  return settle(result);
}

const sendChallengeCard =
  (ctx: TelegramHandlerContext): JobHandler =>
  async ({ job }) => {
    const { challengeId } = challengePayload.parse(job.payload);
    const challenge = await getChallengeById(ctx.deps.db, challengeId);
    if (!challenge || challenge.messageId !== null) return { outcome: 'done' };
    const group = await requireGroup(ctx.deps.db, challenge.groupId);
    if (group.botStatus === 'left') return { outcome: 'done' };
    const rendered = renderChallengeCard(await challengeCardView(ctx.deps.db, challenge));
    const result = await call(ctx, group.telegramChatId, () =>
      ctx.api.sendMessage(group.telegramChatId, rendered.text, {
        entities: rendered.entities,
        reply_markup: rendered.reply_markup,
        message_thread_id: challenge.threadId ?? undefined,
      }),
    );
    if (!result.ok) return settle(result);
    const messageId = result.value.message_id;
    await ctx.deps.db.transaction(async (tx) => {
      await setChallengeMessage(tx, challenge.id, messageId);
      if (challenge.gameId !== null) {
        await tx
          .update(games)
          .set({ cardMessageId: messageId, cardThreadId: challenge.threadId })
          .where(and(eq(games.id, challenge.gameId), isNull(games.cardMessageId)));
        const [game] = await tx
          .select({ id: games.id, publicId: games.publicId })
          .from(games)
          .where(eq(games.id, challenge.gameId));
        if (game) await enqueue(tx, editGameCardJob(game));
      } else if (challenge.status !== 'pending') {
        await enqueue(tx, {
          kind: 'edit_card',
          payload: { challengeId: challenge.id },
          dedupKey: `card:ch:${challenge.publicId}`,
        });
      }
    });
    return { outcome: 'done' };
  };

const editCard =
  (ctx: TelegramHandlerContext): JobHandler =>
  async ({ job }) => {
    const payload = cardPayload.parse(job.payload);
    if ('gameId' in payload) return editGameCard(ctx, payload.gameId);
    const challenge = await getChallengeById(ctx.deps.db, payload.challengeId);
    if (!challenge) return { outcome: 'done' };
    if (challenge.gameId !== null) return editGameCard(ctx, challenge.gameId);
    if (challenge.messageId === null)
      throw new Error(`challenge ${challenge.id} has no message id yet`);
    const group = await requireGroup(ctx.deps.db, challenge.groupId);
    if (group.botStatus === 'left') return { outcome: 'done' };
    const rendered = renderChallengeCard(await challengeCardView(ctx.deps.db, challenge));
    return settle(await editMessage(ctx, group.telegramChatId, challenge.messageId, rendered));
  };

function moveLabel(ply: number, san: string): string {
  const number = Math.ceil(ply / 2);
  return ply % 2 === 1 ? `${number}. ${san}` : `${number}... ${san}`;
}

async function dmContent(
  ctx: TelegramHandlerContext,
  user: UserRow,
  payload: z.infer<typeof dmPayload>,
): Promise<{ text: string; buttons: InlineKeyboardButton[][] } | null> {
  const { config, deps } = ctx;
  if (payload.template === 'challenge') {
    if (payload.challengeId === undefined) return null;
    const challenge = await getChallengeById(deps.db, payload.challengeId);
    if (!challenge || challenge.status !== 'pending') return null;
    const challenger = await requireUser(deps.db, challenge.challengerId);
    const group = await requireGroup(deps.db, challenge.groupId);
    return {
      text: t('dm.challenge', {
        challenger: challenger.firstName,
        timePerMove: timePerMoveLabel(challenge.timePerMove as TimePerMove),
        rated: ratedLabel(challenge.rated),
      }),
      buttons: [
        [
          {
            text: t('button.open'),
            url: miniAppLink(config, { kind: 'lobby', groupId: group.publicId }),
          },
        ],
      ],
    };
  }
  if (payload.gameId === undefined) return null;
  const game = await requireGameById(deps.db, payload.gameId);
  const opponentId = game.whiteId === user.id ? game.blackId : game.whiteId;
  const opponent = await requireUser(deps.db, opponentId);
  const group = await requireGroup(deps.db, game.groupId);
  const openGame: InlineKeyboardButton = {
    text: t('button.open_game'),
    url: miniAppLink(config, { kind: 'game', gameId: game.publicId }),
  };
  const groupLink =
    game.cardMessageId !== null ? groupMessageLink(group.telegramChatId, game.cardMessageId) : null;
  const goToGroup: InlineKeyboardButton[] = groupLink
    ? [{ text: t('button.go_to_group'), url: groupLink }]
    : [];

  if (payload.template === 'game_end') {
    if (game.status !== 'finished' || !game.result || !game.endReason) return null;
    const isWhite = game.whiteId === user.id;
    const before = isWhite ? game.whiteRatingBefore : game.blackRatingBefore;
    const after = isWhite ? game.whiteRatingAfter : game.blackRatingAfter;
    const rdBefore = isWhite ? game.whiteRdBefore : game.blackRdBefore;
    const rdAfter = isWhite ? game.whiteRdAfter : game.blackRdAfter;
    const params = {
      result: resultLabel(game.result),
      opponent: opponent.firstName,
      endReason: endReasonLabel(game.endReason),
    };
    const text =
      game.rated && before !== null && after !== null && rdBefore !== null && rdAfter !== null
        ? t('dm.game_end.rating', {
            ...params,
            before: ratingLabel(before, isProvisional(rdBefore)),
            after: ratingLabel(after, isProvisional(rdAfter)),
          })
        : t('dm.game_end', params);
    const moves = game.plyCount > 0 ? await listMoves(deps.db, game.id) : [];
    const analysis =
      game.lichessUrl ?? (moves.length > 0 ? analysisUrl(moves.map((m) => m.san)) : null);
    const buttons: InlineKeyboardButton[][] = [[openGame]];
    if (analysis && analysis.length <= 2000)
      buttons.push([{ text: t('button.analyse'), url: analysis }]);
    return { text, buttons };
  }

  if (game.status !== 'active') return null;
  const toMove = sideToMove(game.fen) === 'white' ? game.whiteId : game.blackId;
  if (toMove !== user.id) return null;
  const now = await dbNow(deps.db);
  const timeLeft = game.deadlineAt
    ? formatTimeLeft(game.deadlineAt.getTime() - now.getTime())
    : null;
  if (payload.template === 'reminder') {
    if (!timeLeft) return null;
    return {
      text: t('dm.reminder', { timeLeft, opponent: opponent.firstName }),
      buttons: [[openGame], goToGroup],
    };
  }
  const last = (await listMoves(deps.db, game.id)).at(-1);
  const lastMove = last ? moveLabel(last.ply, last.san) : null;
  const key = lastMove
    ? timeLeft
      ? 'dm.turn'
      : 'dm.turn.no_clock'
    : timeLeft
      ? 'dm.turn.first'
      : 'dm.turn.first_no_clock';
  return {
    text: t(key, {
      opponent: opponent.firstName,
      lastMove: lastMove ?? '',
      timeLeft: timeLeft ?? '',
    }),
    buttons: [[openGame], goToGroup],
  };
}

const sendDm =
  (ctx: TelegramHandlerContext): JobHandler =>
  async ({ job }) => {
    const payload = dmPayload.parse(job.payload);
    const user = await getUserById(ctx.deps.db, payload.userId);
    if (!user || !wantsDms(user) || user.telegramUserId === null) return { outcome: 'done' };
    const content = await dmContent(ctx, user, payload);
    if (!content) return { outcome: 'done' };
    const chatId = user.telegramUserId;
    const result = await call(ctx, null, () =>
      ctx.api.sendMessage(chatId, content.text, {
        reply_markup: { inline_keyboard: content.buttons.filter((row) => row.length > 0) },
      }),
    );
    if (!result.ok && result.failure.kind === 'blocked')
      await setDmAllowed(ctx.deps.db, user.id, false);
    return settle(result);
  };

const sendWelcome =
  (ctx: TelegramHandlerContext): JobHandler =>
  async ({ job }) => {
    const { groupId } = z.object({ groupId: z.number().int() }).parse(job.payload);
    const group = await requireGroup(ctx.deps.db, groupId);
    if (group.botStatus === 'left') return { outcome: 'done' };
    const rendered = renderWelcomeCard(
      miniAppLink(ctx.config, { kind: 'lobby', groupId: group.publicId }),
    );
    const result = await call(ctx, group.telegramChatId, () =>
      ctx.api.sendMessage(group.telegramChatId, rendered.text, {
        reply_markup: rendered.reply_markup,
      }),
    );
    if (!result.ok) return settle(result);
    await ctx.deps.db
      .update(groups)
      .set({ welcomeMessageId: result.value.message_id })
      .where(eq(groups.id, group.id));
    if (group.botCanPin) {
      await call(ctx, group.telegramChatId, () =>
        ctx.api.pinChatMessage(group.telegramChatId, result.value.message_id, {
          disable_notification: true,
        }),
      );
    }
    return { outcome: 'done' };
  };

const sendMessage =
  (ctx: TelegramHandlerContext): JobHandler =>
  async ({ job }) => {
    const payload = messagePayload.parse(job.payload);
    const result = await call(ctx, payload.chatId, () =>
      ctx.api.sendMessage(payload.chatId, payload.text, {
        message_thread_id: payload.threadId ?? undefined,
        reply_parameters: payload.replyToMessageId
          ? { message_id: payload.replyToMessageId, allow_sending_without_reply: true }
          : undefined,
        reply_markup: payload.buttons ? { inline_keyboard: [payload.buttons] } : undefined,
      }),
    );
    return settle(result);
  };

export function telegramJobHandlers(ctx: TelegramHandlerContext): JobHandlers {
  return {
    send_challenge_card: sendChallengeCard(ctx),
    edit_card: editCard(ctx),
    send_dm: sendDm(ctx),
    send_welcome: sendWelcome(ctx),
    send_message: sendMessage(ctx),
  };
}
