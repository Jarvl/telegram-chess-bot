import {
  formatTimeLeft,
  ratedLabel,
  sideToMove,
  t,
  timePerMoveLabel,
  type Colour,
  type TimePerMove,
} from '@group-chess/shared';
import { eq } from 'drizzle-orm';
import type { InlineKeyboardButton } from 'grammy/types';
import { z } from 'zod';
import { dbNow, type DbOrTx } from '../../db/client';
import { challenges, type DmKind, type GameRow, type UserRow } from '../../db/schema';
import { requireGroup } from '../../domain/groups';
import { canDelete } from '../../domain/dmRules';
import {
  dropUserDms,
  markWaiting,
  recordDm,
  retireChallengeDms,
  retireDmPayload,
  retireGameDms,
} from '../../domain/dms';
import { isEngineGame } from '../../domain/engineGames';
import { listMoves, requireGameById } from '../../domain/games';
import {
  getUserById,
  nameWithFlair,
  requireUser,
  setDmAllowed,
  wantsDms,
} from '../../domain/users';
import {
  challengeStub,
  drawOfferText,
  gameEndedStub,
  moveLabel,
  reminderText,
  resultText,
  turnText,
  waitingText,
  type ChallengeOutcome,
} from '../../domain/dmText';
import { groupMessageLink, miniAppLink } from '../../telegram/links';
import type { JobHandler } from '../types';
import { call, settle, type CallResult, type TelegramHandlerContext } from './telegramCall';

async function forgetIfBlocked(
  ctx: TelegramHandlerContext,
  userId: number,
  result: CallResult<unknown>,
): Promise<void> {
  if (result.ok || result.failure.kind !== 'blocked') return;
  await ctx.deps.db.transaction(async (tx) => {
    await setDmAllowed(tx, userId, false);
    await dropUserDms(tx, userId);
  });
}

/**
 * DM notifications spec §2.2–2.3: deletes a replaced DM while Telegram still allows it, otherwise
 * leaves its one-line stub; or applies the silent waiting edit after the player moved.
 */
export const retireDm =
  (ctx: TelegramHandlerContext): JobHandler =>
  async ({ job }) => {
    const p = retireDmPayload.parse(job.payload);
    let result: CallResult<unknown>;
    if (p.action === 'wait') {
      const game = await requireGameById(ctx.deps.db, p.gameId!);
      const url = miniAppLink(ctx.config, { kind: 'game', gameId: game.publicId });
      result = await call(ctx, null, () =>
        ctx.api.editMessageText(p.chatId, p.telegramMessageId, p.text, {
          reply_markup: { inline_keyboard: [[{ text: t('button.open_game'), url }]] },
        }),
      );
    } else if (canDelete(new Date(p.sentAt), await dbNow(ctx.deps.db))) {
      result = await call(ctx, null, () => ctx.api.deleteMessage(p.chatId, p.telegramMessageId));
    } else {
      result = await call(ctx, null, () =>
        ctx.api.editMessageText(p.chatId, p.telegramMessageId, p.text, {
          reply_markup: { inline_keyboard: [] },
        }),
      );
    }
    await forgetIfBlocked(ctx, p.userId, result);
    return settle(result);
  };

const dmPayload = z.object({
  userId: z.number().int(),
  template: z.enum(['turn', 'reminder', 'draw_offer', 'result', 'challenge']),
  gameId: z.number().int().optional(),
  challengeId: z.number().int().optional(),
  premovesCancelled: z.boolean().optional(),
});
type DmPayload = z.infer<typeof dmPayload>;

/** A DM to send; `kind` null means a result DM, which is final and gets no live row. */
type Dm = {
  text: string;
  buttons: InlineKeyboardButton[][];
  kind: DmKind | null;
  stub: string;
};

const colourOf = (game: GameRow, userId: number): Colour =>
  game.whiteId === userId ? 'white' : 'black';

function outcomeFor(game: GameRow, colour: Colour): 'win' | 'draw' | 'loss' | null {
  if (game.result === '1/2-1/2') return 'draw';
  if (game.result === '1-0') return colour === 'white' ? 'win' : 'loss';
  if (game.result === '0-1') return colour === 'black' ? 'win' : 'loss';
  return null;
}

function ratingFor(game: GameRow, colour: Colour) {
  if (!game.rated) return null;
  const [before, after, rdAfter] =
    colour === 'white'
      ? [game.whiteRatingBefore, game.whiteRatingAfter, game.whiteRdAfter]
      : [game.blackRatingBefore, game.blackRatingAfter, game.blackRdAfter];
  return before === null || after === null || rdAfter === null ? null : { before, after, rdAfter };
}

async function challengeDm(
  tx: DbOrTx,
  ctx: TelegramHandlerContext,
  challengeId: number,
): Promise<Dm | null> {
  const [challenge] = await tx.select().from(challenges).where(eq(challenges.id, challengeId));
  if (!challenge || challenge.status !== 'pending') return null;
  const challenger = nameWithFlair(await requireUser(tx, challenge.challengerId));
  const group = await requireGroup(tx, challenge.groupId);
  return {
    text: t('dm.challenge', {
      challenger,
      timePerMove: timePerMoveLabel(challenge.timePerMove as TimePerMove),
      rated: ratedLabel(challenge.rated),
    }),
    buttons: [
      [
        {
          text: t('button.open'),
          url: miniAppLink(ctx.config, { kind: 'lobby', groupId: group.publicId }),
        },
      ],
    ],
    kind: 'challenge',
    stub: challengeStub(challenger, 'expired'),
  };
}

/** DM notifications spec §4: what the user's DM for this game says now, or null if none applies. */
async function gameDm(
  tx: DbOrTx,
  ctx: TelegramHandlerContext,
  user: UserRow,
  game: GameRow,
  payload: DmPayload,
): Promise<Dm | null> {
  if (isEngineGame(game)) return null;
  const colour = colourOf(game, user.id);
  const opponentUser = await requireUser(tx, colour === 'white' ? game.blackId : game.whiteId);
  const opponent = nameWithFlair(opponentUser);
  const group = await requireGroup(tx, game.groupId);
  const groupLink =
    game.cardMessageId !== null ? groupMessageLink(group.telegramChatId, game.cardMessageId) : null;
  const buttons: InlineKeyboardButton[][] = [
    [
      {
        text: t('button.open_game'),
        url: miniAppLink(ctx.config, { kind: 'game', gameId: game.publicId }),
      },
    ],
    ...(groupLink ? [[{ text: t('button.go_to_group'), url: groupLink }]] : []),
  ];

  if (payload.template === 'result') {
    const outcome = game.status === 'finished' ? outcomeFor(game, colour) : null;
    if (!outcome || !game.endReason) return null;
    const text = resultText({
      outcome,
      opponent,
      endReason: game.endReason,
      rating: ratingFor(game, colour),
    });
    return { text, buttons, kind: null, stub: text };
  }

  if (game.status !== 'active' || sideToMove(game.fen) !== colour) return null;
  const now = await dbNow(tx);
  const timeLeft = game.deadlineAt
    ? formatTimeLeft(game.deadlineAt.getTime() - now.getTime())
    : null;
  const stub = gameEndedStub(opponent);
  if (payload.template === 'reminder') {
    if (!timeLeft) return null;
    return { text: reminderText({ opponent, timeLeft }), buttons, kind: 'reminder', stub };
  }
  const last = (await listMoves(tx, game.id)).at(-1);
  const lastMove = last ? moveLabel(last.ply, last.san) : null;
  const drawOffered = game.drawOfferBy !== null && game.drawOfferBy !== colour;
  if (payload.template === 'draw_offer' && drawOffered) {
    return {
      text: drawOfferText({ opponent, lastMove, timeLeft }),
      buttons,
      kind: 'draw_offer',
      stub,
    };
  }
  const text = turnText({
    opponent,
    lastMove,
    timeLeft,
    drawOffered,
    premovesCancelled: payload.premovesCancelled === true,
  });
  return { text, buttons, kind: 'turn', stub };
}

async function buildDm(
  tx: DbOrTx,
  ctx: TelegramHandlerContext,
  user: UserRow,
  payload: DmPayload,
): Promise<Dm | null> {
  if (payload.template === 'challenge') {
    return payload.challengeId === undefined ? null : challengeDm(tx, ctx, payload.challengeId);
  }
  if (payload.gameId === undefined) return null;
  return gameDm(tx, ctx, user, await requireGameById(tx, payload.gameId), payload);
}

/** The user's own last move, for the waiting line. */
async function waitingLine(tx: DbOrTx, game: GameRow, user: UserRow): Promise<string> {
  const colour = colourOf(game, user.id);
  const own = (await listMoves(tx, game.id))
    .filter((move) => (move.ply % 2 === 1) === (colour === 'white'))
    .at(-1);
  const opponent = await requireUser(tx, colour === 'white' ? game.blackId : game.whiteId);
  return waitingText({
    move: own ? moveLabel(own.ply, own.san) : '',
    opponent: nameWithFlair(opponent),
  });
}

/**
 * Spec §2.1 step 3: under the game (or challenge) row lock that every trigger takes, makes the
 * sent message the live row — or, when state moved on while it was in flight, the waiting line
 * or a retired message.
 */
async function recordSent(
  ctx: TelegramHandlerContext,
  user: UserRow,
  payload: DmPayload,
  sent: Dm & { kind: DmKind },
  chatId: number,
  telegramMessageId: number,
): Promise<void> {
  await ctx.deps.db.transaction(async (tx) => {
    const base = { userId: user.id, chatId, telegramMessageId, kind: sent.kind, stub: sent.stub };
    if (payload.template === 'challenge') {
      const [challenge] = await tx
        .select()
        .from(challenges)
        .where(eq(challenges.id, payload.challengeId!))
        .for('update');
      if (!challenge) return;
      await recordDm(tx, { ...base, challengeId: challenge.id });
      if (challenge.status !== 'pending') {
        const challenger = nameWithFlair(await requireUser(tx, challenge.challengerId));
        const outcome = challenge.status as ChallengeOutcome;
        await retireChallengeDms(tx, challenge.id, challengeStub(challenger, outcome));
      }
      return;
    }
    const game = await requireGameById(tx, payload.gameId!, { forUpdate: true });
    await recordDm(tx, { ...base, gameId: game.id });
    if (game.status !== 'active') {
      await retireGameDms(tx, game.id);
    } else if (!(await gameDm(tx, ctx, user, game, payload))) {
      await markWaiting(tx, {
        userId: user.id,
        gameId: game.id,
        text: await waitingLine(tx, game, user),
      });
    }
  });
}

export const sendDm =
  (ctx: TelegramHandlerContext): JobHandler =>
  async ({ job }) => {
    const payload = dmPayload.parse(job.payload);
    const user = await getUserById(ctx.deps.db, payload.userId);
    if (!user || !wantsDms(user) || user.telegramUserId === null) return { outcome: 'done' };
    const dm = await buildDm(ctx.deps.db, ctx, user, payload);
    if (!dm) return { outcome: 'done' };
    const chatId = user.telegramUserId;
    const result = await call(ctx, null, () =>
      ctx.api.sendMessage(chatId, dm.text, { reply_markup: { inline_keyboard: dm.buttons } }),
    );
    await forgetIfBlocked(ctx, user.id, result);
    if (!result.ok) return settle(result);
    if (dm.kind !== null) {
      await recordSent(
        ctx,
        user,
        payload,
        { ...dm, kind: dm.kind },
        chatId,
        result.value.message_id,
      );
    }
    return { outcome: 'done' };
  };
