import { INITIAL_FEN, sideToMove, t, type Colour } from '@group-chess/shared';
import { Chess } from 'chess.js';
import { eq } from 'drizzle-orm';
import { InputFile } from 'grammy';
import { z } from 'zod';
import { shares, type MoveRow } from '../../db/schema';
import { listMoves, requireGameById } from '../../domain/games';
import { requireGroup } from '../../domain/groups';
import { displayName, requireUser } from '../../domain/users';
import { renderBoardPng, renderBoardSvg, type BoardRenderInput } from '../../images/board';
import { boardImageKey, getCachedFileId, storeFileId } from '../../images/cache';
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

/** Spec §7.7: render or reuse, then `sendPhoto` to the game's topic with the share caption. */
const sendSharePhoto =
  (ctx: TelegramHandlerContext): JobHandler =>
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
    const orientation: Colour = share.userId === game.blackId ? 'black' : 'white';
    const input: BoardRenderInput = {
      ...position,
      check: new Chess(position.fen).inCheck(),
      orientation,
    };
    const key = boardImageKey(input);
    const cached = await getCachedFileId(ctx.deps.db, key);
    const caption = renderShareCaption({
      sharer: displayName(sharer),
      moveNumber: Math.max(1, Math.ceil(share.ply / 2)),
      white: displayName(white),
      black: displayName(black),
      sideToMove: sideToMove(position.fen),
    });
    const photo = cached ?? new InputFile(renderBoardPng(renderBoardSvg(input)), 'board.png');
    const result = await call(ctx, group.telegramChatId, () =>
      ctx.api.sendPhoto(group.telegramChatId, photo, {
        caption,
        message_thread_id: game.cardThreadId ?? undefined,
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: t('button.open_game'),
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

export function sharePhotoJobHandlers(ctx: TelegramHandlerContext): JobHandlers {
  return { send_share_photo: sendSharePhoto(ctx) };
}
