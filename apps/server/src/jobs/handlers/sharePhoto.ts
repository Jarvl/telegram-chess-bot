import { INITIAL_FEN, t, type TimePerMove } from '@group-chess/shared';
import { Chess } from 'chess.js';
import { eq } from 'drizzle-orm';
import { InputFile } from 'grammy';
import { z } from 'zod';
import { shares, type GameRow, type MoveRow, type UserRow } from '../../db/schema';
import { listMoves, requireGameById } from '../../domain/games';
import { requireGroup } from '../../domain/groups';
import { getPlayerRating } from '../../domain/ratings';
import { displayName, requireUser } from '../../domain/users';
import { getCachedFileId, snapshotImageKey, storeFileId } from '../../images/cache';
import type { SnapshotFonts } from '../../images/fonts';
import { renderSnapshotPng, renderSnapshotSvg } from '../../images/snapshot';
import { buildSnapshotModel, shareMoveNumber, type SnapshotSide } from '../../images/snapshotModel';
import { renderShareCaption } from '../../telegram/cards';
import { miniAppLink } from '../../telegram/links';
import type { JobHandler, JobHandlers } from '../types';
import { call, settle, type TelegramHandlerContext } from './telegram';

const payloadSchema = z.object({ shareId: z.number().int() });

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

/** Snapshot spec §3.1: build the card, reuse or upload it, and post it to the game's topic. */
const sendSharePhoto =
  (ctx: TelegramHandlerContext, fonts: SnapshotFonts): JobHandler =>
  async ({ job }) => {
    const { shareId } = payloadSchema.parse(job.payload);
    const [share] = await ctx.deps.db.select().from(shares).where(eq(shares.id, shareId));
    if (!share || share.messageId !== null) return { outcome: 'done' };
    const game = await requireGameById(ctx.deps.db, share.gameId);
    const group = await requireGroup(ctx.deps.db, game.groupId);
    if (group.botStatus === 'left') return { outcome: 'done' };
    const [sharer, white, black, moves] = await Promise.all([
      requireUser(ctx.deps.db, share.userId),
      requireUser(ctx.deps.db, game.whiteId),
      requireUser(ctx.deps.db, game.blackId),
      listMoves(ctx.deps.db, game.id),
    ]);
    const position = positionAtPly(moves, share.ply);
    const model = buildSnapshotModel({
      ply: share.ply,
      sans: moves.filter((move) => move.ply <= share.ply).map((move) => move.san),
      board: {
        ...position,
        check: new Chess(position.fen).inCheck(),
        orientation: share.userId === game.blackId ? 'black' : 'white',
      },
      white: await side(ctx, game, white),
      black: await side(ctx, game, black),
      groupTitle: group.title,
      timePerMove: game.timePerMove as TimePerMove,
      rated: game.rated,
      status: game.status,
      result: game.result,
      endReason: game.endReason,
      plyCount: game.plyCount,
      deadlineAt: game.deadlineAt,
      sharedAt: share.createdAt,
    });
    const svg = await renderSnapshotSvg(model, fonts);
    const key = snapshotImageKey(svg);
    const cached = await getCachedFileId(ctx.deps.db, key);
    const caption = renderShareCaption({
      sharer: displayName(sharer),
      moveNumber: shareMoveNumber(share.ply),
      white: displayName(white),
      black: displayName(black),
    });
    const photo = cached ?? new InputFile(renderSnapshotPng(svg), 'snapshot.png');
    const result = await call(ctx, group.telegramChatId, () =>
      ctx.api.sendPhoto(group.telegramChatId, photo, {
        caption,
        message_thread_id: game.cardThreadId ?? undefined,
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: t('button.open_live_game'),
                url: miniAppLink(ctx.config, { kind: 'game', gameId: game.publicId }),
              },
            ],
          ],
        },
      }),
    );
    if (!result.ok) return settle(result);
    const largest = result.value.photo.at(-1);
    if (!cached && largest) await storeFileId(ctx.deps.db, key, largest.file_id);
    await ctx.deps.db
      .update(shares)
      .set({ messageId: result.value.message_id })
      .where(eq(shares.id, share.id));
    return { outcome: 'done' };
  };

export function sharePhotoJobHandlers(
  ctx: TelegramHandlerContext,
  fonts: SnapshotFonts,
): JobHandlers {
  return { send_share_photo: sendSharePhoto(ctx, fonts) };
}
