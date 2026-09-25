import {
  analysisUrl,
  INITIAL_FEN,
  isProvisional,
  ratingLabel,
  t,
  type TimePerMove,
} from '@group-chess/shared';
import { Chess } from 'chess.js';
import { eq } from 'drizzle-orm';
import { InputFile } from 'grammy';
import type { InlineKeyboardButton, Message } from 'grammy/types';
import { z } from 'zod';
import {
  games,
  shares,
  type GameRow,
  type GroupRow,
  type MoveRow,
  type UserRow,
} from '../../db/schema';
import { listMoves, requireGameById } from '../../domain/games';
import { requireGroup } from '../../domain/groups';
import { getPlayerRating } from '../../domain/ratings';
import { displayName, requireUser } from '../../domain/users';
import { getCachedFileId, snapshotImageKey, storeFileId } from '../../images/cache';
import type { SnapshotFonts } from '../../images/fonts';
import { renderSnapshotPng, renderSnapshotSvg } from '../../images/snapshot';
import { buildSnapshotModel, shareMoveNumber, type SnapshotSide } from '../../images/snapshotModel';
import {
  MAX_BUTTON_URL_LENGTH,
  renderResultCaption,
  renderShareCaption,
  type RatingChange,
} from '../../telegram/cards';
import { miniAppLink } from '../../telegram/links';
import type { JobHandler, JobHandlers } from '../types';
import { call, settle, type CallResult, type TelegramHandlerContext } from './telegram';

const sharePayloadSchema = z.object({ shareId: z.number().int() });
const resultPayloadSchema = z.object({ gameId: z.number().int() });

/** The position after `ply` (0 = the initial position) and the move that produced it. */
export function positionAtPly(
  moves: Pick<MoveRow, 'ply' | 'uci' | 'fenAfter'>[],
  ply: number,
): { fen: string; lastMove: string | null } {
  if (ply === 0) return { fen: INITIAL_FEN, lastMove: null };
  const move = moves.find((row) => row.ply === ply);
  if (!move) throw new Error(`no move at ply ${ply}`);
  return { fen: move.fenAfter, lastMove: move.uci };
}

async function side(
  ctx: TelegramHandlerContext,
  game: GameRow,
  user: UserRow,
): Promise<SnapshotSide> {
  return {
    name: displayName(user),
    rating: await getPlayerRating(ctx.deps.db, game.groupId, user.id),
    engineLevel: user.isEngine ? game.engineLevel : null,
  };
}

/**
 * Snapshot spec §3.1: build the card for `ply`, reuse or upload it, and post it to the game's topic.
 * Shares and result photos both come through here, so the same position renders the same image.
 */
async function postSnapshot(
  ctx: TelegramHandlerContext,
  fonts: SnapshotFonts,
  input: {
    game: GameRow;
    group: GroupRow;
    white: UserRow;
    black: UserRow;
    moves: MoveRow[];
    ply: number;
    orientation: 'white' | 'black';
    caption: string;
    buttons: InlineKeyboardButton[][];
  },
): Promise<CallResult<Message.PhotoMessage>> {
  const { game, group, ply } = input;
  const position = positionAtPly(input.moves, ply);
  const model = buildSnapshotModel({
    ply,
    sans: input.moves.filter((move) => move.ply <= ply).map((move) => move.san),
    board: {
      ...position,
      check: new Chess(position.fen).inCheck(),
      orientation: input.orientation,
    },
    white: await side(ctx, game, input.white),
    black: await side(ctx, game, input.black),
    groupTitle: group.title,
    timePerMove: game.timePerMove as TimePerMove,
    rated: game.rated,
    status: game.status,
    result: game.result,
    endReason: game.endReason,
    plyCount: game.plyCount,
    voided: game.voidedAt !== null,
  });
  const svg = await renderSnapshotSvg(model, fonts);
  const key = snapshotImageKey(svg);
  const cached = await getCachedFileId(ctx.deps.db, key);
  const photo = cached ?? new InputFile(renderSnapshotPng(svg), 'snapshot.png');
  const result = await call(ctx, group.telegramChatId, () =>
    ctx.api.sendPhoto(group.telegramChatId, photo, {
      caption: input.caption,
      message_thread_id: game.cardThreadId ?? undefined,
      reply_markup: { inline_keyboard: input.buttons },
    }),
  );
  const largest = result.ok ? result.value.photo.at(-1) : undefined;
  if (!cached && largest) await storeFileId(ctx.deps.db, key, largest.file_id);
  return result;
}

async function players(ctx: TelegramHandlerContext, game: GameRow) {
  const [white, black, moves] = await Promise.all([
    requireUser(ctx.deps.db, game.whiteId),
    requireUser(ctx.deps.db, game.blackId),
    listMoves(ctx.deps.db, game.id),
  ]);
  return { white, black, moves };
}

const sendSharePhoto =
  (ctx: TelegramHandlerContext, fonts: SnapshotFonts): JobHandler =>
  async ({ job }) => {
    const { shareId } = sharePayloadSchema.parse(job.payload);
    const [share] = await ctx.deps.db.select().from(shares).where(eq(shares.id, shareId));
    if (!share || share.messageId !== null) return { outcome: 'done' };
    const game = await requireGameById(ctx.deps.db, share.gameId);
    const group = await requireGroup(ctx.deps.db, game.groupId);
    if (group.botStatus === 'left') return { outcome: 'done' };
    const [sharer, { white, black, moves }] = await Promise.all([
      requireUser(ctx.deps.db, share.userId),
      players(ctx, game),
    ]);
    const result = await postSnapshot(ctx, fonts, {
      game,
      group,
      white,
      black,
      moves,
      ply: share.ply,
      orientation: share.userId === game.blackId ? 'black' : 'white',
      caption: renderShareCaption({
        sharer: displayName(sharer),
        moveNumber: shareMoveNumber(share.ply),
        white: displayName(white),
        black: displayName(black),
      }),
      buttons: [
        [
          {
            text: t('button.open_live_game'),
            url: miniAppLink(ctx.config, { kind: 'game', gameId: game.publicId }),
          },
        ],
        [
          {
            text: t('button.group_lobby'),
            url: miniAppLink(ctx.config, { kind: 'lobby', groupId: group.publicId }),
          },
        ],
      ],
    });
    if (!result.ok) return settle(result);
    await ctx.deps.db
      .update(shares)
      .set({ messageId: result.value.message_id })
      .where(eq(shares.id, share.id));
    return { outcome: 'done' };
  };

/** Both sides' rating change, only for a rated game whose snapshots were all written. */
function ratingChanges(game: GameRow): { white: RatingChange; black: RatingChange } | null {
  if (!game.rated) return null;
  const change = (
    before: number | null,
    after: number | null,
    rdBefore: number | null,
    rdAfter: number | null,
  ): RatingChange | null =>
    before === null || after === null || rdBefore === null || rdAfter === null
      ? null
      : {
          before: ratingLabel(before, isProvisional(rdBefore)),
          after: ratingLabel(after, isProvisional(rdAfter)),
        };
  const white = change(
    game.whiteRatingBefore,
    game.whiteRatingAfter,
    game.whiteRdBefore,
    game.whiteRdAfter,
  );
  const black = change(
    game.blackRatingBefore,
    game.blackRatingAfter,
    game.blackRdBefore,
    game.blackRdAfter,
  );
  return white && black ? { white, black } : null;
}

/** The finished game's final position, told to its group (the players get no game-end DM). */
const sendResultPhoto =
  (ctx: TelegramHandlerContext, fonts: SnapshotFonts): JobHandler =>
  async ({ job }) => {
    const { gameId } = resultPayloadSchema.parse(job.payload);
    const game = await requireGameById(ctx.deps.db, gameId);
    if (game.status !== 'finished' || game.resultMessageId !== null) return { outcome: 'done' };
    if (!game.result || !game.endReason) return { outcome: 'done' };
    const group = await requireGroup(ctx.deps.db, game.groupId);
    if (group.botStatus === 'left') return { outcome: 'done' };
    const { white, black, moves } = await players(ctx, game);
    const analysis =
      game.lichessUrl ?? (moves.length > 0 ? analysisUrl(moves.map((move) => move.san)) : null);
    const buttons: InlineKeyboardButton[][] = [
      [
        {
          text: t('button.open_game'),
          url: miniAppLink(ctx.config, { kind: 'game', gameId: game.publicId }),
        },
      ],
    ];
    if (analysis && analysis.length <= MAX_BUTTON_URL_LENGTH)
      buttons.push([{ text: t('button.analyse'), url: analysis }]);
    const result = await postSnapshot(ctx, fonts, {
      game,
      group,
      white,
      black,
      moves,
      ply: game.plyCount,
      // The winner's view of their win; a draw or a void is shown from White's side.
      orientation: game.result === '0-1' ? 'black' : 'white',
      caption: renderResultCaption({
        white: displayName(white),
        black: displayName(black),
        result: game.result,
        endReason: game.endReason,
        ratings: ratingChanges(game),
      }),
      buttons,
    });
    if (!result.ok) return settle(result);
    await ctx.deps.db
      .update(games)
      .set({ resultMessageId: result.value.message_id })
      .where(eq(games.id, game.id));
    return { outcome: 'done' };
  };

export function sharePhotoJobHandlers(
  ctx: TelegramHandlerContext,
  fonts: SnapshotFonts,
): JobHandlers {
  return {
    send_share_photo: sendSharePhoto(ctx, fonts),
    send_result_photo: sendResultPhoto(ctx, fonts),
  };
}
