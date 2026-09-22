import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { users } from '../../src/db/schema';
import { getEngineUser } from '../../src/domain/engineGames';
import { listKnownPlayers } from '../../src/domain/members';
import { openTestDb, truncateAll } from '../helpers/db';
import { insertGroup } from '../helpers/fixtures';

const { db, close } = openTestDb();

beforeEach(() => truncateAll(db));
afterAll(() => close());

describe('the engine user', () => {
  it('exists after migration, exactly once, with no Telegram id', async () => {
    const rows = await db.select().from(users).where(eq(users.isEngine, true));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.telegramUserId).toBeNull();
    expect(rows[0]!.dmAllowed).toBe(false);
  });

  it('is what getEngineUser returns', async () => {
    const engine = await getEngineUser(db);
    expect(engine.isEngine).toBe(true);
    expect(engine.firstName).toBe('Stockfish');
  });

  it('is not a known player in any group, so it stays out of the opponent picker', async () => {
    const group = await insertGroup(db, { telegramChatId: -100123, title: 'G' });
    const engine = await getEngineUser(db);
    const players = await listKnownPlayers(db, group.id);
    expect(players.map((player) => player.id)).not.toContain(String(engine.id));
  });
});
