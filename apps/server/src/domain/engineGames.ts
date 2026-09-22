import { eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { users, type GameRow, type UserRow } from '../db/schema';

/** The single engine user, created by migration 0002 (spec §5). */
export async function getEngineUser(tx: DbOrTx): Promise<UserRow> {
  const [row] = await tx.select().from(users).where(eq(users.isEngine, true)).limit(1);
  if (!row) throw new Error('the engine user is missing; migration 0002 did not run');
  return row;
}

export function isEngineGame(game: Pick<GameRow, 'engineLevel'>): boolean {
  return game.engineLevel !== null;
}
