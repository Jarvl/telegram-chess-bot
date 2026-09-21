/**
 * The end-to-end backend: the real server on a fake Bot API, plus a small seeding API that exists
 * only in this process. Started by Playwright's `webServer` (apps/miniapp/playwright.config.ts).
 */
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { INITIAL_FEN } from '@group-chess/shared';
import { eq } from 'drizzle-orm';
import { games, users } from '../../src/db/schema';
import { runMigrations } from '../../src/db/migrate';
import { touchMember } from '../../src/domain/members';
import { startServer } from '../../src/main';
import { testConfig } from '../helpers/config';
import { openTestDb, truncateAll } from '../helpers/db';
import { FakeTelegram } from '../helpers/fakeTelegram';
import { insertGame, insertGroup, insertMove, insertUser } from '../helpers/fixtures';

const APP_PORT = Number(process.env.E2E_APP_PORT ?? 4180);
const HARNESS_PORT = Number(process.env.E2E_HARNESS_PORT ?? 4181);
const MINI_APP_DIR = fileURLToPath(new URL('../../../miniapp/dist/', import.meta.url));
const CHAT = -1001000000099;

const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
const AFTER_E4_E5 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2';
const FOOLS_MATE = [
  ['f2f3', 'f3', 'rnbqkbnr/pppppppp/8/8/8/5P2/PPPPP1PP/RNBQKBNR b KQkq - 0 1'],
  ['e7e5', 'e5', 'rnbqkbnr/pppp1ppp/8/4p3/8/5P2/PPPPP1PP/RNBQKBNR w KQkq e6 0 2'],
  ['g2g4', 'g4', 'rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq g3 0 2'],
  ['d8h4', 'Qh4#', 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3'],
] as const;
/** White pawn on e7, black king on d8: e7e8 promotes with check. */
const PROMOTION_FEN = '3k4/4P3/8/8/8/8/8/4K3 w - - 0 1';

type Scenario = 'none' | 'fresh' | 'opening' | 'promotion' | 'finished';
type SeedRequest = { scenario: Scenario; prefs?: Record<string, Record<string, unknown>> };

const TELEGRAM_USERS = {
  alice: { id: 11, first_name: 'Alice', username: 'alice' },
  bob: { id: 22, first_name: 'Bob', username: 'bob' },
  carol: { id: 33, first_name: 'Carol', username: 'carol' },
} as const;

async function main(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL must be set for the e2e harness');
  await runMigrations(url);
  const { db, close } = openTestDb();
  await truncateAll(db);
  const fake = await FakeTelegram.start();
  for (const user of Object.values(TELEGRAM_USERS)) fake.members.set(user.id, 'member');
  fake.admins = [TELEGRAM_USERS.alice.id];
  const server = await startServer(
    testConfig({
      TELEGRAM_API_ROOT: fake.url,
      PORT: APP_PORT,
      PUBLIC_URL: `http://127.0.0.1:${APP_PORT}`,
      MINI_APP_DIR,
      DATABASE_URL: url,
      LOG_LEVEL: 'warn',
    }),
  );

  const seed = async (request: SeedRequest) => {
    await truncateAll(db);
    fake.reset();
    for (const user of Object.values(TELEGRAM_USERS)) fake.members.set(user.id, 'member');
    fake.admins = [TELEGRAM_USERS.alice.id];
    const group = await insertGroup(db, {
      telegramChatId: CHAT,
      title: 'Chess Club',
      botStatus: 'administrator',
      botIsAdmin: true,
    });
    const rows: Record<
      string,
      { id: number; telegram: (typeof TELEGRAM_USERS)[keyof typeof TELEGRAM_USERS] }
    > = {};
    for (const [name, telegram] of Object.entries(TELEGRAM_USERS)) {
      const row = await insertUser(db, {
        telegramUserId: telegram.id,
        firstName: telegram.first_name,
        username: telegram.username,
      });
      const patch = request.prefs?.[name];
      if (patch) await db.update(users).set({ prefs: patch }).where(eq(users.id, row.id));
      await touchMember(db, group.id, row.id, { verified: true });
      rows[name] = { id: row.id, telegram };
    }
    const alice = rows.alice!.id;
    const bob = rows.bob!.id;
    let game: { id: number; publicId: string } | null = null;
    if (request.scenario === 'fresh')
      game = await insertGame(db, group.id, alice, bob, { fen: INITIAL_FEN });
    if (request.scenario === 'opening') {
      const row = await insertGame(db, group.id, alice, bob, { fen: AFTER_E4_E5, plyCount: 2 });
      await insertMove(db, row.id, 1, 'e2e4', 'e4', AFTER_E4);
      await insertMove(db, row.id, 2, 'e7e5', 'e5', AFTER_E4_E5);
      game = row;
    }
    if (request.scenario === 'promotion')
      game = await insertGame(db, group.id, alice, bob, { fen: PROMOTION_FEN, plyCount: 6 });
    if (request.scenario === 'finished') {
      const row = await insertGame(db, group.id, alice, bob, {
        fen: FOOLS_MATE[3][2],
        plyCount: 4,
        status: 'finished',
        result: '0-1',
        endReason: 'checkmate',
        finishedAt: new Date(),
      });
      for (const [index, [uci, san, fen]] of FOOLS_MATE.entries())
        await insertMove(db, row.id, index + 1, uci, san, fen);
      game = row;
    }
    return {
      group: { id: group.id, publicId: group.publicId },
      users: rows,
      game: game ? { id: game.id, publicId: game.publicId } : null,
    };
  };

  const harness = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = chunks.length
        ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as SeedRequest)
        : null;
      const reply = (status: number, json: unknown) => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(json));
      };
      const path = req.url ?? '/';
      void (async () => {
        try {
          if (path === '/health') return reply(200, { ok: true });
          if (path === '/reset') {
            await truncateAll(db);
            fake.reset();
            return reply(200, { ok: true });
          }
          if (path === '/seed' && body) return reply(200, await seed(body));
          if (path === '/telegram/calls') return reply(200, fake.calls);
          const match = /^\/games\/([A-Za-z0-9]{10})$/.exec(path);
          if (match) {
            const [row] = await db.select().from(games).where(eq(games.publicId, match[1]!));
            return reply(
              row ? 200 : 404,
              row
                ? { status: row.status, fen: row.fen, plyCount: row.plyCount, result: row.result }
                : {},
            );
          }
          reply(404, { error: 'unknown harness route' });
        } catch (error) {
          reply(500, { error: error instanceof Error ? error.message : String(error) });
        }
      })();
    });
  });
  await new Promise<void>((resolve) => harness.listen(HARNESS_PORT, '127.0.0.1', () => resolve()));
  console.log(
    `e2e harness: app http://127.0.0.1:${APP_PORT}/app/ harness http://127.0.0.1:${HARNESS_PORT}`,
  );

  const shutdown = async (): Promise<void> => {
    await new Promise<void>((resolve) => harness.close(() => resolve()));
    await server.stop();
    await fake.stop();
    await close();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}

void main();
