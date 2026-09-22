import { timingSafeEqual } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { Bot } from 'grammy';
import type { Update } from 'grammy/types';
import { Hono } from 'hono';
import type { Config } from '../config';
import { telegramUpdates } from '../db/schema';
import type { Deps } from '../domain/deps';
import type { Metrics } from '../metrics';

const MAX_UPDATE_BYTES = 1_048_576;
/** An update marked received but not processed for this long is an attempt that died mid-way. */
const STALE_ATTEMPT_MS = 60_000;

function secretMatches(given: string | undefined, expected: string): boolean {
  if (!given || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

function updateType(update: Update): string {
  return Object.keys(update).find((key) => key !== 'update_id') ?? 'unknown';
}

/**
 * Spec §5.2: secret header, update_id idempotency, 500 on failure so Telegram retries. The marker
 * is written before the handler and completed after it; a marker that stays incomplete for a
 * minute (a process that died in between) is claimed again by the retry instead of acknowledged.
 */
export function webhookRoutes(bot: Bot, deps: Deps, config: Config, metrics?: Metrics): Hono {
  const app = new Hono();
  app.post('/telegram/webhook', async (c) => {
    if (!secretMatches(c.req.header('x-telegram-bot-api-secret-token'), config.WEBHOOK_SECRET))
      return c.body(null, 401);
    if (Number(c.req.header('content-length') ?? 0) > MAX_UPDATE_BYTES) return c.body(null, 413);
    const raw = await c.req.text();
    if (raw.length > MAX_UPDATE_BYTES) return c.body(null, 413);
    let update: Update;
    try {
      update = JSON.parse(raw) as Update;
    } catch {
      return c.body(null, 400);
    }
    if (typeof update?.update_id !== 'number') return c.body(null, 400);
    metrics?.webhookUpdates.inc({ type: updateType(update) });

    const inserted = await deps.db
      .insert(telegramUpdates)
      .values({ updateId: update.update_id })
      .onConflictDoNothing()
      .returning({ updateId: telegramUpdates.updateId });
    if (inserted.length === 0) {
      // A duplicate: acknowledged, unless the earlier attempt never finished and is stale.
      const claimed = await deps.db
        .update(telegramUpdates)
        .set({ receivedAt: sql`now()` })
        .where(
          sql`${telegramUpdates.updateId} = ${update.update_id} and ${telegramUpdates.processedAt} is null and ${telegramUpdates.receivedAt} < now() - make_interval(secs => ${STALE_ATTEMPT_MS / 1000})`,
        )
        .returning({ updateId: telegramUpdates.updateId });
      if (claimed.length === 0) return c.body(null, 200);
      deps.log.warn({ updateId: update.update_id }, 'reprocessing an update whose attempt died');
    }
    try {
      await bot.handleUpdate(update);
    } catch (error) {
      await deps.db.delete(telegramUpdates).where(eq(telegramUpdates.updateId, update.update_id));
      deps.log.error({ err: error, updateId: update.update_id }, 'update handler failed');
      return c.body(null, 500);
    }
    await deps.db
      .update(telegramUpdates)
      .set({ processedAt: sql`now()` })
      .where(eq(telegramUpdates.updateId, update.update_id));
    return c.body(null, 200);
  });
  return app;
}
