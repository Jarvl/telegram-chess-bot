import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { dbNow } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { jobs, tips } from '../../src/db/schema';
import { openTestDb, truncateAll } from '../helpers/db';
import { insertGame, insertGroup, insertUser } from '../helpers/fixtures';

const { db, close } = openTestDb();

beforeEach(() => truncateAll(db));
afterAll(() => close());

describe('database', () => {
  it('has every table after migration and is idempotent to migrate again', async () => {
    await runMigrations(process.env.TEST_DATABASE_URL!);
    const rows = await db.execute(
      sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
    );
    expect(rows.map((row) => row.table_name)).toEqual([
      'admin_actions',
      'board_images',
      'challenges',
      'games',
      'group_members',
      'groups',
      'jobs',
      'moves',
      'ratings',
      'shares',
      'telegram_updates',
      'tips',
      'users',
    ]);
  });

  it('reads the database clock as a Date close to the wall clock', async () => {
    const now = await dbNow(db);
    expect(Math.abs(now.getTime() - Date.now())).toBeLessThan(5_000);
  });

  it('enforces one pending job per dedup key but allows a new one once done', async () => {
    await db.insert(jobs).values({ kind: 'edit_card', dedupKey: 'card:g:x' });
    await expect(
      db.insert(jobs).values({ kind: 'edit_card', dedupKey: 'card:g:x' }),
    ).rejects.toSatisfy((error: unknown) =>
      /jobs_dedup_pending/.test(
        String(
          (error as { cause?: { message?: string } }).cause?.message ?? (error as Error).message,
        ),
      ),
    );
    await db.update(jobs).set({ doneAt: sql`now()` });
    await expect(
      db.insert(jobs).values({ kind: 'edit_card', dedupKey: 'card:g:x' }),
    ).resolves.toBeDefined();
  });

  it('stores fixture games with a database-side deadline', async () => {
    const group = await insertGroup(db);
    const white = await insertUser(db);
    const black = await insertUser(db);
    const game = await insertGame(db, group.id, white.id, black.id, { deadlineInSeconds: -1 });
    const [row] = await db.execute(
      sql`select deadline_at < now() as passed from games where id = ${game.id}`,
    );
    expect(row?.passed).toBe(true);
    expect(game.publicId).toHaveLength(10);
  });
});

describe('tips table', () => {
  it('stores a tip once per Telegram charge id', async () => {
    const user = await insertUser(db, { telegramUserId: 11 });
    const row = {
      userId: user.id,
      telegramUserId: 11,
      stars: 250,
      telegramPaymentChargeId: 'charge-1',
    };
    await db.insert(tips).values(row);
    const again = await db
      .insert(tips)
      .values(row)
      .onConflictDoNothing({ target: tips.telegramPaymentChargeId })
      .returning();
    expect(again).toHaveLength(0);
    const [stored] = await db.select().from(tips);
    expect(stored).toMatchObject({ stars: 250, refundedAt: null });
    expect(stored?.paidAt).toBeInstanceOf(Date);
  });
});
