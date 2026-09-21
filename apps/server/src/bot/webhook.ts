import { eq } from 'drizzle-orm';
import type { Bot } from 'grammy';
import type { Update } from 'grammy/types';
import { Hono } from 'hono';
import type { Config } from '../config';
import { telegramUpdates } from '../db/schema';
import type { Deps } from '../domain/deps';

const MAX_UPDATE_BYTES = 1_048_576;

/** Spec §5.2: secret header, update_id idempotency, 500 on failure so Telegram retries. */
export function webhookRoutes(bot: Bot, deps: Deps, config: Config): Hono {
  const app = new Hono();
  app.post('/telegram/webhook', async (c) => {
    if (c.req.header('x-telegram-bot-api-secret-token') !== config.WEBHOOK_SECRET)
      return c.body(null, 401);
    if (Number(c.req.header('content-length') ?? 0) > MAX_UPDATE_BYTES) return c.body(null, 413);
    let update: Update;
    try {
      update = (await c.req.json()) as Update;
    } catch {
      return c.body(null, 400);
    }
    if (typeof update?.update_id !== 'number') return c.body(null, 400);
    const inserted = await deps.db
      .insert(telegramUpdates)
      .values({ updateId: update.update_id })
      .onConflictDoNothing()
      .returning({ updateId: telegramUpdates.updateId });
    if (inserted.length === 0) return c.body(null, 200);
    try {
      await bot.handleUpdate(update);
    } catch (error) {
      await deps.db.delete(telegramUpdates).where(eq(telegramUpdates.updateId, update.update_id));
      deps.log.error({ err: error, updateId: update.update_id }, 'update handler failed');
      return c.body(null, 500);
    }
    return c.body(null, 200);
  });
  return app;
}
