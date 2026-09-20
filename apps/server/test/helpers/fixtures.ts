import { INITIAL_FEN, type TimePerMove } from '@group-chess/shared';
import { sql } from 'drizzle-orm';
import type { DbOrTx } from '../../src/db/client';
import { generatePublicId } from '../../src/db/ids';
import {
  challenges,
  games,
  groupMembers,
  groups,
  moves,
  users,
  type ChallengeRow,
  type GameRow,
  type GroupRow,
  type UserRow,
} from '../../src/db/schema';

let counter = 0;

export async function insertUser(
  db: DbOrTx,
  overrides: Partial<typeof users.$inferInsert> = {},
): Promise<UserRow> {
  counter += 1;
  const [row] = await db
    .insert(users)
    .values({ telegramUserId: 1_000_000 + counter, firstName: `User${counter}`, ...overrides })
    .returning();
  return row!;
}

export async function insertGroup(
  db: DbOrTx,
  overrides: Partial<typeof groups.$inferInsert> = {},
): Promise<GroupRow> {
  counter += 1;
  const [row] = await db
    .insert(groups)
    .values({
      publicId: generatePublicId(),
      telegramChatId: -1_000_000_000_000 - counter,
      title: `Group ${counter}`,
      type: 'supergroup',
      ...overrides,
    })
    .returning();
  return row!;
}

export async function insertMember(db: DbOrTx, groupId: number, userId: number): Promise<void> {
  await db.insert(groupMembers).values({ groupId, userId }).onConflictDoNothing();
}

export type GameOverrides = Partial<typeof games.$inferInsert> & {
  /** Seconds relative to now; negative means already passed. */
  deadlineInSeconds?: number;
  reminderInSeconds?: number;
};

export async function insertGame(
  db: DbOrTx,
  groupId: number,
  whiteId: number,
  blackId: number,
  overrides: GameOverrides = {},
): Promise<GameRow> {
  const { deadlineInSeconds, reminderInSeconds, ...rest } = overrides;
  const timePerMove: TimePerMove =
    rest.timePerMove === undefined ? 86400 : (rest.timePerMove as TimePerMove);
  const [row] = await db
    .insert(games)
    .values({
      publicId: generatePublicId(),
      groupId,
      whiteId,
      blackId,
      timePerMove,
      rated: true,
      fen: INITIAL_FEN,
      deadlineAt:
        deadlineInSeconds === undefined
          ? timePerMove === null
            ? null
            : sql`now() + make_interval(secs => ${timePerMove})`
          : sql`now() + make_interval(secs => ${deadlineInSeconds})`,
      reminderAt:
        reminderInSeconds === undefined
          ? null
          : sql`now() + make_interval(secs => ${reminderInSeconds})`,
      ...rest,
    })
    .returning();
  return row!;
}

export async function insertMove(
  db: DbOrTx,
  gameId: number,
  ply: number,
  uci: string,
  san: string,
  fenAfter: string,
): Promise<void> {
  await db
    .insert(moves)
    .values({ gameId, ply, uci, san, fenAfter, clientMoveId: `fixture-${gameId}-${ply}` });
}

export async function insertChallenge(
  db: DbOrTx,
  groupId: number,
  challengerId: number,
  opponentId: number | null,
  overrides: Partial<typeof challenges.$inferInsert> & { expiresInSeconds?: number } = {},
): Promise<ChallengeRow> {
  const { expiresInSeconds = 86_400, ...rest } = overrides;
  const [row] = await db
    .insert(challenges)
    .values({
      publicId: generatePublicId(),
      groupId,
      challengerId,
      opponentId,
      timePerMove: 86400,
      challengerColour: 'random',
      rated: true,
      expiresAt: sql`now() + make_interval(secs => ${expiresInSeconds})`,
      ...rest,
    })
    .returning();
  return row!;
}
