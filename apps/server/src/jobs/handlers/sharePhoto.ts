import { eq } from 'drizzle-orm';
import { InputFile } from 'grammy';
import { z } from 'zod';
import { shares } from '../../db/schema';
import { requireGameById } from '../../domain/games';
import { requireGroup } from '../../domain/groups';
import { renderBoardPng, renderBoardSvg } from '../../images/board';
import { boardImageKey, getCachedFileId, storeFileId } from '../../images/cache';
import { loadShareView } from '../../telegram/share';
import type { JobHandler, JobHandlers } from '../types';
import { call, settle, type TelegramHandlerContext } from './telegram';

const payloadSchema = z.object({ shareId: z.number().int() });

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
    const view = await loadShareView(ctx.deps.db, ctx.config, game, share.userId, share.ply);
    const key = boardImageKey(view.board);
    const cached = await getCachedFileId(ctx.deps.db, key);
    const photo = cached ?? new InputFile(renderBoardPng(renderBoardSvg(view.board)), 'board.png');
    const result = await call(ctx, group.telegramChatId, () =>
      ctx.api.sendPhoto(group.telegramChatId, photo, {
        caption: view.caption,
        message_thread_id: game.cardThreadId ?? undefined,
        reply_markup: view.replyMarkup,
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
