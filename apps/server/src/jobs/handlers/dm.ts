import { t } from '@group-chess/shared';
import { dbNow } from '../../db/client';
import { canDelete } from '../../domain/dmRules';
import { dropUserDms, retireDmPayload } from '../../domain/dms';
import { requireGameById } from '../../domain/games';
import { setDmAllowed } from '../../domain/users';
import { miniAppLink } from '../../telegram/links';
import type { JobHandler } from '../types';
import { call, settle, type CallResult, type TelegramHandlerContext } from './telegram';

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
