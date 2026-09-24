import { and, eq, gt, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { pendingShares, shares, type GameRow } from '../db/schema';
import type { Deps } from './deps';
import { DomainError } from './errors';
import { requireGameByPublicId } from './games';
import { enqueue } from '../jobs/queue';

/** PRD §7.6 / spec §7.8: one shared position per user per minute; the photo itself is a job. */
export async function sharePosition(
  deps: Deps,
  input: { gameId: string; userId: number; ply: number },
): Promise<{ shareId: number }> {
  return deps.db.transaction(async (tx) => {
    const game = await requireGameByPublicId(tx, input.gameId);
    if (input.ply > game.plyCount)
      throw new DomainError('validation', 'ply is beyond the game', { plyCount: game.plyCount });
    const [recent] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(shares)
      .where(
        and(
          eq(shares.userId, input.userId),
          sql`${shares.createdAt} > now() - interval '1 minute'`,
        ),
      );
    if ((recent?.n ?? 0) > 0)
      throw new DomainError('rate_limited', 'one shared position per minute', { reason: 'share' });
    const [share] = await tx
      .insert(shares)
      .values({ gameId: game.id, userId: input.userId, ply: input.ply })
      .returning({ id: shares.id });
    if (!share) throw new Error('share insert returned no row');
    await enqueue(tx, { kind: 'send_share_photo', payload: { shareId: share.id } });
    return { shareId: share.id };
  });
}

/** How long a staged share answers the user's inline queries: long enough to pick a chat. */
export const PENDING_SHARE_MINUTES = 10;

/**
 * Stages the position for inline mode (spec §7.7): the app then opens Telegram's chat picker, and
 * the bot offers this position when the user's inline query arrives. Nothing is posted here.
 */
export async function stagePendingShare(
  tx: DbOrTx,
  input: { game: GameRow; userId: number; ply: number },
): Promise<void> {
  if (input.ply > input.game.plyCount)
    throw new DomainError('validation', 'ply is beyond the game', {
      plyCount: input.game.plyCount,
    });
  const row = { gameId: input.game.id, ply: input.ply, createdAt: sql`now()` };
  await tx
    .insert(pendingShares)
    .values({ userId: input.userId, ...row })
    .onConflictDoUpdate({ target: pendingShares.userId, set: row });
}

/** The user's staged share, unless it is older than `PENDING_SHARE_MINUTES`. */
export async function getPendingShare(
  tx: DbOrTx,
  userId: number,
): Promise<{ gameId: number; ply: number } | null> {
  const [row] = await tx
    .select({ gameId: pendingShares.gameId, ply: pendingShares.ply })
    .from(pendingShares)
    .where(
      and(
        eq(pendingShares.userId, userId),
        gt(pendingShares.createdAt, sql`now() - make_interval(mins => ${PENDING_SHARE_MINUTES})`),
      ),
    );
  return row ?? null;
}
