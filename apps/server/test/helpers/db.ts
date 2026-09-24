import { sql } from 'drizzle-orm';
import { LocalBus } from '../../src/bus/bus';
import { createDb, type Db } from '../../src/db/client';
import type { Deps } from '../../src/domain/deps';
import { createLogger } from '../../src/logger';

export function openTestDb(): ReturnType<typeof createDb> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL must be set for integration tests');
  return createDb(url, { max: 6 });
}

export async function truncateAll(db: Db): Promise<void> {
  await db.execute(
    sql`truncate table admin_actions, pending_shares, shares, board_images, moves, games, challenges, ratings, group_members, jobs, telegram_updates, groups, users restart identity cascade`,
  );
  // The engine user is created by migration 0002, not by any test — truncating `users`
  // removes it, so put it back to keep the helper's contract "empty database, plus the
  // engine user that migrations guarantee".
  await db.execute(
    sql`insert into users (first_name, is_engine, dm_allowed) values ('Stockfish', true, false) on conflict do nothing`,
  );
}

export function testDeps(db: Db): Deps {
  return { db, bus: new LocalBus(), log: createLogger('fatal') };
}
