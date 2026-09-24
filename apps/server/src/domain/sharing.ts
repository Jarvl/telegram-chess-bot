import type { ShareDto } from '@group-chess/shared';
import { and, eq, sql } from 'drizzle-orm';
import { shares, type GameRow } from '../db/schema';
import type { DbOrTx } from '../db/client';
import type { Deps } from './deps';
import { DomainError } from './errors';
import { requireGameByPublicId } from './games';
import { requireGroup } from './groups';
import { enqueue } from '../jobs/queue';
import { groupMessageLink } from '../telegram/links';

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

/** The app polls this after sharing, then opens the posted photo in the group. Sharers only. */
export async function loadShare(
  tx: DbOrTx,
  game: GameRow,
  input: { shareId: number; userId: number },
): Promise<ShareDto> {
  const [share] = await tx
    .select()
    .from(shares)
    .where(
      and(
        eq(shares.id, input.shareId),
        eq(shares.gameId, game.id),
        eq(shares.userId, input.userId),
      ),
    );
  if (!share) throw new DomainError('not_found', 'share not found');
  if (share.messageId === null) return { id: share.id, sent: false, link: null };
  const group = await requireGroup(tx, game.groupId);
  return {
    id: share.id,
    sent: true,
    link: groupMessageLink(group.telegramChatId, share.messageId),
  };
}
