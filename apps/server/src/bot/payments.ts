import { t } from '@group-chess/shared';
import { eq, sql } from 'drizzle-orm';
import type { Bot } from 'grammy';
import { tips } from '../db/schema';
import type { Deps } from '../domain/deps';
import { ensureUser } from '../domain/users';
import { enqueue } from '../jobs/queue';
import { tipCheckoutAccepted } from '../telegram/tips';
import { userInfo } from './userInfo';

/** Tip jar spec §2.2–2.3: Stars tips from the Mini App's Support card. */
export function registerPayments(bot: Bot, deps: Deps): void {
  // Answered inline, not queued: Telegram gives the bot 10 seconds.
  bot.on('pre_checkout_query', async (ctx) => {
    if (tipCheckoutAccepted(ctx.preCheckoutQuery)) await ctx.answerPreCheckoutQuery(true);
    else await ctx.answerPreCheckoutQuery(false, { error_message: t('payment.tip_invalid') });
  });

  bot.chatType('private').on('message:successful_payment', async (ctx) => {
    const payment = ctx.msg.successful_payment;
    const user = await ensureUser(deps.db, userInfo(ctx.from));
    await deps.db.transaction(async (tx) => {
      // The charge id is unique, so a payment Telegram delivers twice is thanked once.
      const inserted = await tx
        .insert(tips)
        .values({
          userId: user.id,
          telegramUserId: ctx.from.id,
          stars: payment.total_amount,
          telegramPaymentChargeId: payment.telegram_payment_charge_id,
        })
        .onConflictDoNothing({ target: tips.telegramPaymentChargeId })
        .returning({ id: tips.id });
      if (inserted.length === 0) return;
      await enqueue(tx, {
        kind: 'send_message',
        payload: {
          chatId: ctx.chat.id,
          threadId: null,
          text: t('dm.tip_thanks', { stars: payment.total_amount }),
        },
      });
    });
  });

  // Looked up by charge id alone: the payer may have deleted their data since.
  bot.on('message:refunded_payment', async (ctx) => {
    const refund = ctx.msg.refunded_payment;
    const updated = await deps.db
      .update(tips)
      .set({ refundedAt: sql`now()` })
      .where(eq(tips.telegramPaymentChargeId, refund.telegram_payment_charge_id))
      .returning({ id: tips.id });
    if (updated.length === 0) deps.log.warn('a refund arrived for a tip that is not recorded');
  });
}
