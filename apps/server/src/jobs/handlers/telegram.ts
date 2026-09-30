import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../config';
import { games, groups, type GameRow } from '../../db/schema';
import { getChallengeById, setChallengeMessage } from '../../domain/challenges';
import type { Deps } from '../../domain/deps';
import { requireGameById } from '../../domain/games';
import { markBotLeft } from '../../domain/groupLifecycle';
import { migrateChatId, requireGroup } from '../../domain/groups';
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
import { miniAppLink } from '../../telegram/links';
import { challengeCardView, gameCardView } from '../../telegram/views';
import { enqueue } from '../queue';
import { retireDm, sendDm } from './dm';
import type { JobHandler, JobHandlers, JobResult } from '../types';

export type TelegramHandlerContext = { deps: Deps; api: TelegramApi; config: Config };

export type CallResult<T> = { ok: true; value: T } | { ok: false; failure: TelegramFailure };

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
  const rendered = renderGameCard(await gameCardView(ctx.deps.db, game, group, ctx.config));
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
    const rendered = renderChallengeCard(
      await challengeCardView(ctx.deps.db, challenge, group, ctx.config),
    );
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
    const rendered = renderChallengeCard(
      await challengeCardView(ctx.deps.db, challenge, group, ctx.config),
    );
    return settle(await editMessage(ctx, group.telegramChatId, challenge.messageId, rendered));
  };

const sendWelcome =
  (ctx: TelegramHandlerContext): JobHandler =>
  async ({ job }) => {
    const { groupId } = z.object({ groupId: z.number().int() }).parse(job.payload);
    const group = await requireGroup(ctx.deps.db, groupId);
    if (group.botStatus === 'left') return { outcome: 'done' };
    const rendered = renderWelcomeCard({
      challenge: miniAppLink(ctx.config, { kind: 'newGame', groupId: group.publicId }),
      lobby: miniAppLink(ctx.config, { kind: 'lobby', groupId: group.publicId }),
    });
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
        // One button per row: two side by side would cut their labels short on a phone.
        reply_markup: payload.buttons
          ? { inline_keyboard: payload.buttons.map((button) => [button]) }
          : undefined,
      }),
    );
    return settle(result);
  };

export function telegramJobHandlers(ctx: TelegramHandlerContext): JobHandlers {
  return {
    send_challenge_card: sendChallengeCard(ctx),
    edit_card: editCard(ctx),
    send_dm: sendDm(ctx),
    retire_dm: retireDm(ctx),
    send_welcome: sendWelcome(ctx),
    send_message: sendMessage(ctx),
  };
}
