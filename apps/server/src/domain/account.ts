import { and, eq, or, sql } from 'drizzle-orm';
import { dbNow } from '../db/client';
import { challenges, games, groupMembers, userFlair, users } from '../db/schema';
import type { Deps } from './deps';
import { colourOf } from './gameDto';
import { deletedStub } from '../telegram/dmText';
import { retireChallengeDm } from './challenges';
import { retireUserDms } from './dms';
import { finishGame } from './games';
import { deletePhoto } from './photos';
import { enqueue } from '../jobs/queue';

/** Spec §12 "Delete my data": immediate and irreversible; opponents' histories stay consistent. */
export async function deleteMyData(deps: Deps, userId: number): Promise<void> {
  const finished = await deps.db.transaction(async (tx) => {
    const now = await dbNow(tx);
    // Locks in the order every DM writer takes them — the games and challenges first, then the
    // user's `dm_messages` rows — so a DM being recorded for one of these games cannot deadlock.
    const active = await tx
      .select()
      .from(games)
      .where(
        and(eq(games.status, 'active'), or(eq(games.whiteId, userId), eq(games.blackId, userId))),
      )
      .for('update');
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
    // Anonymised before any game ends or challenge settles, so the stubs left in opponents' chats
    // name "Deleted player" rather than the handle and flair being erased.
    await tx
      .update(users)
      .set({
        telegramUserId: null,
        username: null,
        firstName: 'Deleted player',
        prefs: {},
        flairWorn: [],
        dmAllowed: false,
        writeAccessAskedAt: null,
        deletedAt: now,
      })
      .where(eq(users.id, userId));
    // DM notifications spec §2.4: before the games end, so the user's own DMs all read "Game
    // ended" rather than the game-end stubs `finishGame` would give them. Each row kept its chat id.
    await retireUserDms(tx, userId, deletedStub());
    const publicIds: string[] = [];
    for (const game of active) {
      const colour = colourOf(game, userId);
      if (!colour) continue;
      await finishGame(
        tx,
        game,
        { result: colour === 'white' ? '0-1' : '1-0', endReason: 'resignation' },
        now,
        colour,
      );
      publicIds.push(game.publicId);
    }
    for (const challenge of pending) {
      const outcome = challenge.challengerId === userId ? 'cancelled' : 'declined';
      await tx
        .update(challenges)
        .set({ status: outcome, resolvedAt: sql`now()` })
        .where(eq(challenges.id, challenge.id));
      await retireChallengeDm(tx, challenge, outcome);
      await enqueue(tx, {
        kind: 'edit_card',
        payload: { challengeId: challenge.id },
        dedupKey: `card:ch:${challenge.publicId}`,
      });
    }
    // Flair spec §3.4. The update above takes the row lock, which an award job for this player also
    // holds while it inserts `user_flair` rows. Deleting only after it has the lock means such a job
    // has committed and this sees its rows; a job that starts later finds `deleted_at` set (§3.2).
    await tx.delete(userFlair).where(eq(userFlair.userId, userId));
    await deletePhoto(tx, userId);
    await tx.update(groupMembers).set({ status: 'left' }).where(eq(groupMembers.userId, userId));
    return publicIds;
  });
  for (const publicId of finished) deps.bus.publish(publicId);
}
