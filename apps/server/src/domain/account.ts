import { and, eq, or, sql } from 'drizzle-orm';
import { dbNow } from '../db/client';
import { challenges, games, groupMembers, users } from '../db/schema';
import type { Deps } from './deps';
import { colourOf } from './gameDto';
import { finishGame } from './games';
import { enqueue } from '../jobs/queue';

/** Spec §12 "Delete my data": immediate and irreversible; opponents' histories stay consistent. */
export async function deleteMyData(deps: Deps, userId: number): Promise<void> {
  const finished = await deps.db.transaction(async (tx) => {
    const now = await dbNow(tx);
    const active = await tx
      .select()
      .from(games)
      .where(
        and(eq(games.status, 'active'), or(eq(games.whiteId, userId), eq(games.blackId, userId))),
      )
      .for('update');
    const publicIds: string[] = [];
    for (const game of active) {
      const colour = colourOf(game, userId);
      if (!colour) continue;
      await finishGame(
        tx,
        game,
        { result: colour === 'white' ? '0-1' : '1-0', endReason: 'resignation' },
        now,
      );
      publicIds.push(game.publicId);
    }
    const pending = await tx
      .select()
      .from(challenges)
      .where(
        and(
          eq(challenges.status, 'pending'),
          or(eq(challenges.challengerId, userId), eq(challenges.opponentId, userId)),
        ),
      )
      .for('update');
    for (const challenge of pending) {
      await tx
        .update(challenges)
        .set({
          status: challenge.challengerId === userId ? 'cancelled' : 'declined',
          resolvedAt: sql`now()`,
        })
        .where(eq(challenges.id, challenge.id));
      await enqueue(tx, {
        kind: 'edit_card',
        payload: { challengeId: challenge.id },
        dedupKey: `card:ch:${challenge.publicId}`,
      });
    }
    await tx
      .update(users)
      .set({
        telegramUserId: null,
        username: null,
        firstName: 'Deleted player',
        prefs: {},
        dmAllowed: false,
        writeAccessAskedAt: null,
        deletedAt: now,
      })
      .where(eq(users.id, userId));
    await tx.update(groupMembers).set({ status: 'left' }).where(eq(groupMembers.userId, userId));
    return publicIds;
  });
  for (const publicId of finished) deps.bus.publish(publicId);
}
