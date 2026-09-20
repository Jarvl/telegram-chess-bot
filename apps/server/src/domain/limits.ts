import {
  REMINDER_FRACTION,
  REMINDER_MIN_TIME_PER_MOVE,
  type TimePerMove,
} from '@group-chess/shared';
import { and, eq, or, sql, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { challenges, games } from '../db/schema';

/** Spec §7.8. */
export const MAX_PENDING_CHALLENGES = 3;
export const MAX_GAMES_PER_PAIR = 2;

async function count(tx: DbOrTx, query: Promise<{ n: number }[]>): Promise<number> {
  void tx;
  const [row] = await query;
  return row?.n ?? 0;
}

export function countActiveGames(tx: DbOrTx, groupId: number, userId: number): Promise<number> {
  return count(
    tx,
    tx
      .select({ n: sql<number>`count(*)::int` })
      .from(games)
      .where(
        and(
          eq(games.groupId, groupId),
          eq(games.status, 'active'),
          or(eq(games.whiteId, userId), eq(games.blackId, userId)),
        ),
      ),
  );
}

export function countActiveGamesBetween(
  tx: DbOrTx,
  groupId: number,
  a: number,
  b: number,
): Promise<number> {
  return count(
    tx,
    tx
      .select({ n: sql<number>`count(*)::int` })
      .from(games)
      .where(
        and(
          eq(games.groupId, groupId),
          eq(games.status, 'active'),
          or(
            and(eq(games.whiteId, a), eq(games.blackId, b)),
            and(eq(games.whiteId, b), eq(games.blackId, a)),
          ),
        ),
      ),
  );
}

export function countPendingChallenges(
  tx: DbOrTx,
  groupId: number,
  challengerId: number,
): Promise<number> {
  return count(
    tx,
    tx
      .select({ n: sql<number>`count(*)::int` })
      .from(challenges)
      .where(
        and(
          eq(challenges.groupId, groupId),
          eq(challenges.challengerId, challengerId),
          eq(challenges.status, 'pending'),
        ),
      ),
  );
}

/** `deadline_at − 0.1·T` expressed against the database clock; null when no reminder applies (spec §7.3). */
export function reminderExpression(timePerMove: TimePerMove, dmAllowed: boolean): SQL | null {
  if (timePerMove === null || timePerMove < REMINDER_MIN_TIME_PER_MOVE || !dmAllowed) return null;
  return sql`now() + make_interval(secs => ${timePerMove * (1 - REMINDER_FRACTION)})`;
}

export function deadlineExpression(timePerMove: TimePerMove): SQL | null {
  if (timePerMove === null) return null;
  return sql`now() + make_interval(secs => ${timePerMove})`;
}
