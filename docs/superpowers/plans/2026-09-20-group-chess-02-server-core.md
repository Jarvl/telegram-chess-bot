# Group Chess 02 — Server Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the stateful heart of the server in `apps/server`: configuration, logging, the PostgreSQL schema with migrations, the jobs outbox and worker, users/groups/members, ratings, challenges, the move transaction and every other game transition, draw offers and claims, the clock scanners and the in-process bus — all proven by integration tests on a real PostgreSQL 16.

**Architecture:** One package, `apps/server`, with modules `config`, `logger`, `db` (Drizzle schema, migrations, client, ids), `bus`, `jobs` (outbox queue and worker), `domain` (users, groups, members, ratings, challenges, games, draws, dto), `clock` (scanners). Domain functions take `Deps = { db, bus, log }` and run one transaction each; every side effect is a row in `jobs`, every time comparison uses database `now()`, and the bus is published only after commit. Plan 3 adds the Telegram, HTTP and job-handler layers on top of these functions without changing them.

**Tech Stack:** Node 22, TypeScript strict, Drizzle ORM 0.45 with drizzle-kit 0.31 on the `postgres` (postgres-js) driver, pino 10, zod 4, vitest 5 with a real PostgreSQL 16 (`TEST_DATABASE_URL`).

**Spec:** [docs/superpowers/specs/2026-09-20-group-chess-technical-design.md](../specs/2026-09-20-group-chess-technical-design.md) §4, §7, §8, §10, §11; parent plan [2026-09-20-group-chess.md](2026-09-20-group-chess.md); consumes `@group-chess/shared` from plan 01.

## Global Constraints

- Time: every deadline, expiry, reminder and idempotency decision compares against PostgreSQL `now()` inside the transaction that acts on it; application clocks never decide anything (spec §7.3, §7.4).
- The move transaction is exactly spec §7.4: `SELECT … FOR UPDATE`; status `active`; caller is a player and it is their turn; idempotent on `(game_id, client_move_id)`; `expectedPly` must equal `ply_count` (else `stale_state`); a passed deadline applies the timeout before the move is even validated; arbiter; insert move; update game (`fen`, `ply_count + 1`, `deadline_at`, `reminder_at`, `version + 1`, clear the draw offer when the mover is not the offerer); on game end apply ratings; enqueue `edit_card` (dedup `card:g:<gameId>`), `send_dm` (turn → opponent, or game_end → both) and `lichess_import` when finished with at least one move; commit; publish.
- Clocks: after a move by X, `deadline_at = now() + T` for the opponent (null without a clock), `reminder_at = deadline_at − 0.1·T` only when `T ≥ 28800` and the opponent has `dm_allowed`. Timeout: the player to move loses (`timeout`, FIDE 6.9 draw when the opponent cannot mate) unless they have not yet moved in the game (White at ply 0, Black at ply 1) → `timeout_abort`, no rating change (spec §7.1, §7.3).
- Challenge state machine per spec §7.1: `pending → accepted | declined | cancelled | expired`; accept creates the game in the same transaction, colours as chosen or by CSPRNG coin flip; first committed acceptance of an open challenge wins (row lock); expiry at `created_at + 24 h`; rematch = reversed colours, same `rated` and `T`, new card.
- Limits (spec §7.8): 3 pending challenges per user per group; active games per user per group = `settings.maxActiveGamesPerUser` (default 5); 2 concurrent games per pair; 1 draw offer per player per own move.
- Draw offers: either player may offer when no offer is pending and they have moved since their last offer; the offer stands until the opponent declines or moves; accept at any time while pending → `draw_agreement`. Claims succeed only when the arbiter reports the position claimable; `threefold_claim` / `fifty_move_claim` (spec §7.1).
- Abort: either player while `ply_count < 2`, no rating change. Resign: opponent wins, rated. Void: admin; an active game finishes with `end_reason = 'voided'` and no result; a finished game keeps its result for display; ratings are rebuilt for the whole group by replaying every rated, finished, non-voided game in `finished_at` order (spec §3.5, §7.5).
- Jobs (spec §10): table `jobs`; worker polls every second: `WHERE done_at IS NULL AND run_at <= now() AND (locked_until IS NULL OR locked_until < now()) ORDER BY run_at LIMIT 20 FOR UPDATE SKIP LOCKED`; lease 60 s; success → `done_at`; failure → reschedule at `min(5 s · 2^attempts, 1 h)` until `max_attempts` (8), then `failed_at`. Enqueueing a `dedup_key` that has a pending row moves that row's `run_at` instead of inserting; handlers render from current state, never from the payload alone.
- Scanners (spec §7.3): every 5 s, one short transaction each, up to 100 due rows with `FOR UPDATE SKIP LOCKED`, re-check inside the transaction, apply, enqueue jobs, commit, publish. Forfeit: `status = 'active' AND deadline_at <= now()`; reminder: `reminder_at <= now()` → enqueue reminder DM and null the column; expiry: pending challenges past `expires_at`.
- Data model per spec §8 (bigint identity keys, `public_id` for games, groups and challenges, `timestamptz` everywhere, jsonb `prefs` and `settings`, partial indexes on `deadline_at`/`reminder_at` where active, unique partial index on `jobs.dedup_key` where `done_at IS NULL`, `moves` unique on `(game_id, client_move_id)`).
- Configuration is environment variables only, validated at startup with zod: `BOT_TOKEN`, `BOT_USERNAME`, `MINI_APP_SHORT_NAME`, `PUBLIC_URL`, `WEBHOOK_SECRET`, `DATABASE_URL`, `SESSION_SECRET`, `LICHESS_TOKEN` (optional), `ROLES`, `LOG_LEVEL` (spec §4.4). No secrets in the repository.
- Logs carry numeric ids and public ids only; never message text, names, `initData` or tokens (spec §12).
- Errors thrown by the domain are `DomainError` instances carrying one of the ten spec §9 codes; the HTTP and bot layers (plan 3) translate them.

## Review Focus

1. A move that arrives after the deadline must lose or abort inside the move transaction, never be accepted because the scanner had not run yet → Task 7, test "applies the timeout instead of a move that arrives after the deadline".
2. Two concurrent moves for the same ply (double tap, two devices) must yield one stored move and one `stale_state` → Task 7, test "serialises two concurrent moves for the same ply".
3. Two people accepting the same open challenge concurrently must yield exactly one game → Task 6, test "lets exactly one of two concurrent acceptances win an open challenge".
4. A card edit enqueued while the previous edit for that card is being sent must still run afterwards, so the card never shows a stale state → Task 3, test "runs a job again when it was re-enqueued while being processed".
5. Voiding a game in the middle of a group's history must rewrite the snapshots of later games, never only the voided one → Task 5, test "rebuild rewrites later games' snapshots after a void".

---

### Task 1: Server package scaffold, configuration and logger

**Files:**
- Create: `apps/server/package.json`, `apps/server/tsconfig.json`, `apps/server/vitest.config.ts`, `apps/server/src/config.ts`, `apps/server/src/logger.ts`, `scripts/local-postgres.sh`, `.env.example`
- Modify: `tsconfig.json` (root references), `vitest.config.ts` (root projects), `.github/workflows/ci.yml` (PostgreSQL service + `TEST_DATABASE_URL`)
- Test: `apps/server/test/unit/config.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `ConfigSchema`, `type Config`, `loadConfig(env?: NodeJS.ProcessEnv): Config`, `type Role = 'api' | 'bot' | 'jobs' | 'clock'`; `createLogger(level: Config['LOG_LEVEL']): Logger`, `type Logger` (pino); test layout `apps/server/test/unit/**` (always runs) and `apps/server/test/integration/**` (runs when `TEST_DATABASE_URL` is set).

- [ ] **Step 1: Write the package files**

`apps/server/package.json`:

```json
{
  "name": "@group-chess/server",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "db:generate": "drizzle-kit generate"
  },
  "dependencies": {
    "@group-chess/shared": "workspace:*",
    "drizzle-orm": "^0.45.2",
    "pino": "^10.3.1",
    "postgres": "^3.4.9",
    "zod": "^4.6.5"
  },
  "devDependencies": {
    "drizzle-kit": "^0.31.10",
    "tsx": "^4.23.0"
  }
}
```

`apps/server/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "rootDir": ".",
    "lib": ["ES2022"],
    "types": ["node"]
  },
  "include": ["src", "test", "drizzle.config.ts", "vitest.config.ts"]
}
```

`apps/server/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

const hasDatabase = Boolean(process.env.TEST_DATABASE_URL);
if (!hasDatabase) {
  console.warn(
    '[server] TEST_DATABASE_URL is not set: integration tests are skipped. See scripts/local-postgres.sh.',
  );
}

export default defineConfig({
  test: {
    name: 'server',
    include: hasDatabase ? ['test/**/*.test.ts'] : ['test/unit/**/*.test.ts'],
    globalSetup: hasDatabase ? ['test/helpers/globalSetup.ts'] : [],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
```

`scripts/local-postgres.sh` (an ephemeral PostgreSQL 16 for local integration tests; uses the system binaries):

```bash
#!/usr/bin/env bash
# Start or stop a throwaway PostgreSQL 16 for integration tests.
#   scripts/local-postgres.sh start   -> prints the TEST_DATABASE_URL to export
#   scripts/local-postgres.sh stop
set -euo pipefail

PORT="${PGPORT_LOCAL:-54329}"
DIR="${PGDIR_LOCAL:-/tmp/group-chess-pg}"
BIN="${PGBIN:-$(ls -d /usr/lib/postgresql/16/bin 2>/dev/null || dirname "$(command -v pg_ctl)")}"
DB="group_chess_test"

run_as_pg() {
  if [ "$(id -u)" = "0" ]; then su postgres -s /bin/bash -c "$1"; else bash -c "$1"; fi
}

case "${1:-}" in
  start)
    if [ ! -d "$DIR/data" ]; then
      mkdir -p "$DIR"
      [ "$(id -u)" = "0" ] && chown postgres "$DIR"
      run_as_pg "'$BIN/initdb' -D '$DIR/data' -A trust -U postgres >'$DIR/initdb.log' 2>&1"
    fi
    run_as_pg "'$BIN/pg_ctl' -D '$DIR/data' -o '-p $PORT -k $DIR -c listen_addresses=127.0.0.1' -l '$DIR/pg.log' start >/dev/null"
    for _ in $(seq 1 30); do
      "$BIN/pg_isready" -h 127.0.0.1 -p "$PORT" -U postgres >/dev/null 2>&1 && break
      sleep 0.5
    done
    "$BIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -tAc "select 1 from pg_database where datname='$DB'" | grep -q 1 \
      || "$BIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -qc "create database $DB"
    echo "export TEST_DATABASE_URL=postgres://postgres@127.0.0.1:$PORT/$DB"
    ;;
  stop)
    run_as_pg "'$BIN/pg_ctl' -D '$DIR/data' stop >/dev/null" || true
    ;;
  *)
    echo "usage: $0 start|stop" >&2
    exit 2
    ;;
esac
```

`.env.example`:

```
BOT_TOKEN=123456:replace-me
BOT_USERNAME=GroupChessBot
MINI_APP_SHORT_NAME=chess
PUBLIC_URL=https://chess.example.com
WEBHOOK_SECRET=replace-with-32-random-characters
DATABASE_URL=postgres://postgres@127.0.0.1:5432/group_chess
SESSION_SECRET=replace-with-at-least-32-random-characters
# LICHESS_TOKEN=
ROLES=api,bot,jobs,clock
LOG_LEVEL=info
PORT=3000
```

Root `tsconfig.json` becomes:

```json
{
  "files": [],
  "references": [{ "path": "packages/shared" }, { "path": "apps/server" }]
}
```

Root `vitest.config.ts` becomes:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*'],
  },
});
```

`.github/workflows/ci.yml` becomes:

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

jobs:
  check:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: postgres
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: group_chess_test
        ports: ['5432:5432']
        options: >-
          --health-cmd "pg_isready -U postgres"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
    env:
      TEST_DATABASE_URL: postgres://postgres:postgres@127.0.0.1:5432/group_chess_test
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm format:check
      - run: pnpm typecheck
      - run: pnpm test
```

Run: `pnpm install && chmod +x scripts/local-postgres.sh`
Expected: exit 0; the lockfile gains `apps/server`.

- [ ] **Step 2: Write the failing config test**

`apps/server/test/unit/config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';

const valid = {
  BOT_TOKEN: '123456:abc',
  BOT_USERNAME: 'GroupChessBot',
  MINI_APP_SHORT_NAME: 'chess',
  PUBLIC_URL: 'https://chess.example.com',
  WEBHOOK_SECRET: 'x'.repeat(32),
  DATABASE_URL: 'postgres://postgres@localhost:5432/group_chess',
  SESSION_SECRET: 's'.repeat(32),
};

describe('loadConfig', () => {
  it('parses a complete environment and applies defaults', () => {
    const config = loadConfig(valid);
    expect(config.ROLES).toEqual(['api', 'bot', 'jobs', 'clock']);
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.PORT).toBe(3000);
    expect(config.LICHESS_TOKEN).toBeUndefined();
  });

  it('parses a subset of roles and a numeric port', () => {
    const config = loadConfig({ ...valid, ROLES: 'jobs, clock', PORT: '8080' });
    expect(config.ROLES).toEqual(['jobs', 'clock']);
    expect(config.PORT).toBe(8080);
  });

  it('names the missing variable', () => {
    const { BOT_TOKEN: _omitted, ...rest } = valid;
    expect(() => loadConfig(rest)).toThrow(/BOT_TOKEN/);
  });

  it('rejects an unknown role', () => {
    expect(() => loadConfig({ ...valid, ROLES: 'api,cron' })).toThrow(/ROLES/);
  });

  it('rejects a short session secret', () => {
    expect(() => loadConfig({ ...valid, SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run apps/server/test/unit/config.test.ts`
Expected: FAIL — cannot load `../../src/config`.

- [ ] **Step 4: Write the implementation**

`apps/server/src/config.ts`:

```ts
import { z } from 'zod';

export const ROLES = ['api', 'bot', 'jobs', 'clock'] as const;

export type Role = (typeof ROLES)[number];

const RolesSchema = z
  .string()
  .default('api,bot,jobs,clock')
  .transform((raw) => raw.split(',').map((role) => role.trim()).filter(Boolean))
  .pipe(z.array(z.enum(ROLES)).min(1));

/** Environment variables (spec §4.4). Validated once at startup; the process refuses to boot otherwise. */
export const ConfigSchema = z.object({
  BOT_TOKEN: z.string().min(1),
  BOT_USERNAME: z.string().min(1),
  MINI_APP_SHORT_NAME: z.string().min(1),
  PUBLIC_URL: z.url(),
  WEBHOOK_SECRET: z.string().min(16),
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  LICHESS_TOKEN: z.string().min(1).optional(),
  ROLES: RolesSchema,
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (parsed.success) return parsed.data;
  const problems = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
  throw new Error(`Invalid configuration — ${problems}`);
}
```

`apps/server/src/logger.ts`:

```ts
import pino from 'pino';
import type { Config } from './config';

export type Logger = pino.Logger;

/** JSON logs with numeric and public ids only (spec §12, §14). */
export function createLogger(level: Config['LOG_LEVEL'] = 'info'): Logger {
  return pino({ level, base: undefined });
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run apps/server/test/unit/config.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 6: Run the whole suite and the static checks**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm format:check`
Expected: all exit 0; the server project prints its "integration tests are skipped" warning only when `TEST_DATABASE_URL` is unset.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(server): scaffold the server package with validated configuration and logging"
```

---

### Task 2: Schema, migrations, database client, public ids, bus and the test harness

**Files:**
- Create: `apps/server/drizzle.config.ts`, `apps/server/src/db/schema.ts`, `apps/server/src/db/client.ts`, `apps/server/src/db/migrate.ts`, `apps/server/src/db/ids.ts`, `apps/server/src/bus/bus.ts`, `apps/server/src/domain/deps.ts`, `apps/server/src/domain/errors.ts`, `apps/server/drizzle/0000_*.sql` (generated), `apps/server/test/helpers/globalSetup.ts`, `apps/server/test/helpers/db.ts`, `apps/server/test/helpers/fixtures.ts`
- Test: `apps/server/test/unit/ids.test.ts`, `apps/server/test/unit/bus.test.ts`, `apps/server/test/integration/db.test.ts`

**Interfaces:**
- Consumes: `createLogger`, `Logger` (Task 1); `INITIAL_FEN`, `GROUP_SETTINGS_DEFAULTS`, `PREFS_DEFAULTS`, types from `@group-chess/shared`.
- Produces: the Drizzle tables `users, groups, groupMembers, challenges, games, moves, ratings, shares, boardImages, jobs, telegramUpdates, adminActions` and their `$inferSelect` row types `UserRow, GroupRow, GroupMemberRow, ChallengeRow, GameRow, MoveRow, RatingRow, JobRow`; `createDb(url, { max? }) → { db, close }`, `type Db`, `type Tx`, `type DbOrTx`, `dbNow(tx): Promise<Date>`; `runMigrations(databaseUrl, folder?)`; `generatePublicId(): string`; `interface Bus { publish(gameId: string): void; subscribe(gameId: string, listener: () => void): () => void }`, `class LocalBus`; `type Deps = { db: Db; bus: Bus; log: Logger }`; `class DomainError extends Error { code: ErrorCode; details: Record<string, unknown> }`; test helpers `openTestDb()`, `truncateAll(db)`, fixtures `insertUser`, `insertGroup`, `insertMember`, `insertGame`, `insertMove`.

- [ ] **Step 1: Write the failing unit tests**

`apps/server/test/unit/ids.test.ts`:

```ts
import { PUBLIC_ID_PATTERN } from '@group-chess/shared';
import { describe, expect, it } from 'vitest';
import { generatePublicId } from '../../src/db/ids';

describe('generatePublicId', () => {
  it('produces ten base62 characters', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generatePublicId()).toMatch(PUBLIC_ID_PATTERN);
    }
  });

  it('does not repeat itself', () => {
    const ids = new Set(Array.from({ length: 2000 }, () => generatePublicId()));
    expect(ids.size).toBe(2000);
  });
});
```

`apps/server/test/unit/bus.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { LocalBus } from '../../src/bus/bus';

describe('LocalBus', () => {
  it('delivers a publish to every subscriber of that game only', () => {
    const bus = new LocalBus();
    const seen: string[] = [];
    bus.subscribe('game-a', () => seen.push('a1'));
    bus.subscribe('game-a', () => seen.push('a2'));
    bus.subscribe('game-b', () => seen.push('b'));
    bus.publish('game-a');
    expect(seen).toEqual(['a1', 'a2']);
  });

  it('stops delivering after unsubscribe', () => {
    const bus = new LocalBus();
    let calls = 0;
    const off = bus.subscribe('game-a', () => (calls += 1));
    bus.publish('game-a');
    off();
    bus.publish('game-a');
    expect(calls).toBe(1);
  });

  it('keeps a throwing listener from blocking the others', () => {
    const bus = new LocalBus();
    const seen: string[] = [];
    bus.subscribe('g', () => {
      throw new Error('boom');
    });
    bus.subscribe('g', () => seen.push('ok'));
    expect(() => bus.publish('g')).not.toThrow();
    expect(seen).toEqual(['ok']);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run apps/server/test/unit/ids.test.ts apps/server/test/unit/bus.test.ts`
Expected: FAIL — both files cannot load their modules.

- [ ] **Step 3: Write the schema, client, ids, bus, deps and errors**

`apps/server/drizzle.config.ts`:

```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  casing: 'snake_case',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
});
```

`apps/server/src/db/schema.ts` (spec §8; column names are snake_case via the `casing` option):

```ts
import type {
  ChallengeStatus,
  ColourChoice,
  EndReason,
  GameResult,
  GameStatus,
  GroupSettings,
  Prefs,
} from '@group-chess/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

const id = () => bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity();
const tz = () => timestamp({ withTimezone: true });

export const users = pgTable('users', {
  id: id(),
  telegramUserId: bigint({ mode: 'number' }).unique(),
  firstName: text().notNull(),
  username: text(),
  languageCode: text(),
  dmAllowed: boolean().notNull().default(false),
  writeAccessAskedAt: tz(),
  prefs: jsonb().$type<Partial<Prefs>>().notNull().default({}),
  createdAt: tz().notNull().defaultNow(),
  lastSeenAt: tz().notNull().defaultNow(),
  deletedAt: tz(),
});

export const groups = pgTable('groups', {
  id: id(),
  publicId: text().notNull().unique(),
  telegramChatId: bigint({ mode: 'number' }).notNull().unique(),
  title: text().notNull(),
  type: text().$type<'group' | 'supergroup'>().notNull(),
  isForum: boolean().notNull().default(false),
  botStatus: text().$type<'member' | 'administrator' | 'left'>().notNull().default('member'),
  botIsAdmin: boolean().notNull().default(false),
  botCanPin: boolean().notNull().default(false),
  welcomeMessageId: bigint({ mode: 'number' }),
  settings: jsonb().$type<Partial<GroupSettings>>().notNull().default({}),
  createdAt: tz().notNull().defaultNow(),
  updatedAt: tz().notNull().defaultNow(),
});

export const groupMembers = pgTable(
  'group_members',
  {
    groupId: bigint({ mode: 'number' })
      .notNull()
      .references(() => groups.id),
    userId: bigint({ mode: 'number' })
      .notNull()
      .references(() => users.id),
    status: text().$type<'member' | 'left'>().notNull().default('member'),
    firstSeenAt: tz().notNull().defaultNow(),
    lastSeenAt: tz().notNull().defaultNow(),
    verifiedAt: tz(),
    blockedAt: tz(),
    blockedBy: bigint({ mode: 'number' }),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.userId] }),
    index('group_members_seen').on(t.groupId, t.lastSeenAt),
  ],
);

export const challenges = pgTable(
  'challenges',
  {
    id: id(),
    publicId: text().notNull().unique(),
    groupId: bigint({ mode: 'number' })
      .notNull()
      .references(() => groups.id),
    challengerId: bigint({ mode: 'number' })
      .notNull()
      .references(() => users.id),
    opponentId: bigint({ mode: 'number' }).references(() => users.id),
    timePerMove: integer(),
    challengerColour: text().$type<ColourChoice>().notNull(),
    rated: boolean().notNull(),
    status: text().$type<ChallengeStatus>().notNull().default('pending'),
    messageId: bigint({ mode: 'number' }),
    threadId: bigint({ mode: 'number' }),
    gameId: bigint({ mode: 'number' }),
    createdAt: tz().notNull().defaultNow(),
    expiresAt: tz().notNull(),
    resolvedAt: tz(),
  },
  (t) => [
    index('challenges_status_expires').on(t.status, t.expiresAt),
    index('challenges_group_status').on(t.groupId, t.status),
  ],
);

export const games = pgTable(
  'games',
  {
    id: id(),
    publicId: text().notNull().unique(),
    groupId: bigint({ mode: 'number' })
      .notNull()
      .references(() => groups.id),
    whiteId: bigint({ mode: 'number' })
      .notNull()
      .references(() => users.id),
    blackId: bigint({ mode: 'number' })
      .notNull()
      .references(() => users.id),
    timePerMove: integer(),
    rated: boolean().notNull(),
    status: text().$type<GameStatus>().notNull().default('active'),
    result: text().$type<GameResult>(),
    endReason: text().$type<EndReason>(),
    fen: text().notNull(),
    plyCount: integer().notNull().default(0),
    version: integer().notNull().default(0),
    deadlineAt: tz(),
    reminderAt: tz(),
    drawOfferBy: text().$type<'white' | 'black'>(),
    drawOfferPly: integer(),
    lastDrawOfferPlyWhite: integer(),
    lastDrawOfferPlyBlack: integer(),
    cardMessageId: bigint({ mode: 'number' }),
    cardThreadId: bigint({ mode: 'number' }),
    cardMissing: boolean().notNull().default(false),
    lichessUrl: text(),
    lichessImportStatus: text().$type<'pending' | 'done' | 'failed'>(),
    whiteRatingBefore: doublePrecision(),
    whiteRatingAfter: doublePrecision(),
    whiteRdBefore: doublePrecision(),
    whiteRdAfter: doublePrecision(),
    blackRatingBefore: doublePrecision(),
    blackRatingAfter: doublePrecision(),
    blackRdBefore: doublePrecision(),
    blackRdAfter: doublePrecision(),
    voidedAt: tz(),
    voidedBy: bigint({ mode: 'number' }),
    startedAt: tz().notNull().defaultNow(),
    finishedAt: tz(),
    lastMoveAt: tz(),
  },
  (t) => [
    index('games_deadline_active').on(t.deadlineAt).where(sql`${t.status} = 'active'`),
    index('games_reminder_active')
      .on(t.reminderAt)
      .where(sql`${t.status} = 'active' and ${t.reminderAt} is not null`),
    index('games_group_status_last_move').on(t.groupId, t.status, t.lastMoveAt),
    index('games_white').on(t.whiteId),
    index('games_black').on(t.blackId),
  ],
);

export const moves = pgTable(
  'moves',
  {
    gameId: bigint({ mode: 'number' })
      .notNull()
      .references(() => games.id),
    ply: integer().notNull(),
    uci: text().notNull(),
    san: text().notNull(),
    fenAfter: text().notNull(),
    playedAt: tz().notNull().defaultNow(),
    clientMoveId: text(),
  },
  (t) => [
    primaryKey({ columns: [t.gameId, t.ply] }),
    unique('moves_client_move_unique').on(t.gameId, t.clientMoveId),
  ],
);

export const ratings = pgTable(
  'ratings',
  {
    groupId: bigint({ mode: 'number' })
      .notNull()
      .references(() => groups.id),
    userId: bigint({ mode: 'number' })
      .notNull()
      .references(() => users.id),
    rating: doublePrecision().notNull(),
    rd: doublePrecision().notNull(),
    volatility: doublePrecision().notNull(),
    gamesPlayed: integer().notNull().default(0),
    wins: integer().notNull().default(0),
    draws: integer().notNull().default(0),
    losses: integer().notNull().default(0),
    lastRatedGameAt: tz(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.userId] })],
);

export const shares = pgTable(
  'shares',
  {
    id: id(),
    gameId: bigint({ mode: 'number' })
      .notNull()
      .references(() => games.id),
    userId: bigint({ mode: 'number' })
      .notNull()
      .references(() => users.id),
    ply: integer().notNull(),
    messageId: bigint({ mode: 'number' }),
    createdAt: tz().notNull().defaultNow(),
  },
  (t) => [index('shares_user_created').on(t.userId, t.createdAt)],
);

export const boardImages = pgTable('board_images', {
  key: text().primaryKey(),
  telegramFileId: text().notNull(),
  createdAt: tz().notNull().defaultNow(),
});

export const jobs = pgTable(
  'jobs',
  {
    id: id(),
    kind: text().notNull(),
    dedupKey: text(),
    payload: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    runAt: tz().notNull().defaultNow(),
    attempts: integer().notNull().default(0),
    maxAttempts: integer().notNull().default(8),
    lockedUntil: tz(),
    lockedBy: text(),
    lastError: text(),
    createdAt: tz().notNull().defaultNow(),
    doneAt: tz(),
    failedAt: tz(),
  },
  (t) => [
    uniqueIndex('jobs_dedup_pending').on(t.dedupKey).where(sql`${t.doneAt} is null`),
    index('jobs_run_at_pending').on(t.runAt).where(sql`${t.doneAt} is null`),
  ],
);

export const telegramUpdates = pgTable('telegram_updates', {
  updateId: bigint({ mode: 'number' }).primaryKey(),
  receivedAt: tz().notNull().defaultNow(),
});

export const adminActions = pgTable('admin_actions', {
  id: id(),
  groupId: bigint({ mode: 'number' })
    .notNull()
    .references(() => groups.id),
  adminUserId: bigint({ mode: 'number' })
    .notNull()
    .references(() => users.id),
  action: text().$type<'void' | 'block' | 'unblock' | 'settings'>().notNull(),
  targetGameId: bigint({ mode: 'number' }),
  targetUserId: bigint({ mode: 'number' }),
  details: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  createdAt: tz().notNull().defaultNow(),
});

export type UserRow = typeof users.$inferSelect;
export type GroupRow = typeof groups.$inferSelect;
export type GroupMemberRow = typeof groupMembers.$inferSelect;
export type ChallengeRow = typeof challenges.$inferSelect;
export type GameRow = typeof games.$inferSelect;
export type MoveRow = typeof moves.$inferSelect;
export type RatingRow = typeof ratings.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;
```

`apps/server/src/db/client.ts`:

```ts
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export function createDb(url: string, options: { max?: number } = {}) {
  const client = postgres(url, { max: options.max ?? 10, onnotice: () => undefined });
  const db = drizzle(client, { schema, casing: 'snake_case' });
  return { db, close: () => client.end({ timeout: 5 }) };
}

export type Db = ReturnType<typeof createDb>['db'];
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbOrTx = Db | Tx;

/** The database's clock; inside a transaction this is the transaction start time. */
export async function dbNow(tx: DbOrTx): Promise<Date> {
  const rows = await tx.execute(sql`select extract(epoch from now()) * 1000 as ms`);
  return new Date(Number(rows[0]?.ms));
}
```

`apps/server/src/db/migrate.ts`:

```ts
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const DEFAULT_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));
const MIGRATION_LOCK = 72_648_101;

/**
 * Applies pending migrations under a session advisory lock so concurrent replicas serialise
 * (spec §4.4). A dedicated single connection keeps the lock and the migrator in one session.
 */
export async function runMigrations(
  databaseUrl: string,
  migrationsFolder: string = DEFAULT_FOLDER,
): Promise<void> {
  const client = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  const db = drizzle(client, { casing: 'snake_case' });
  try {
    await client`select pg_advisory_lock(${MIGRATION_LOCK})`;
    try {
      await migrate(db, { migrationsFolder });
    } finally {
      await client`select pg_advisory_unlock(${MIGRATION_LOCK})`;
    }
  } finally {
    await client.end({ timeout: 5 });
  }
}
```

`apps/server/src/db/ids.ts`:

```ts
import { randomInt } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Ten base62 characters from the CSPRNG (spec §5.3): ~59 bits, unguessable and unique-indexed. */
export function generatePublicId(): string {
  let out = '';
  for (let i = 0; i < 10; i += 1) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}
```

`apps/server/src/bus/bus.ts`:

```ts
/** In-process publish/subscribe of game changes to SSE streams (spec §4.2). Keys are public game ids. */
export interface Bus {
  publish(gameId: string): void;
  subscribe(gameId: string, listener: () => void): () => void;
}

export class LocalBus implements Bus {
  private readonly listeners = new Map<string, Set<() => void>>();

  publish(gameId: string): void {
    const set = this.listeners.get(gameId);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        listener();
      } catch {
        // A failing subscriber must never break the publisher or its siblings.
      }
    }
  }

  subscribe(gameId: string, listener: () => void): () => void {
    let set = this.listeners.get(gameId);
    if (!set) {
      set = new Set();
      this.listeners.set(gameId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(gameId);
    };
  }
}
```

`apps/server/src/domain/deps.ts`:

```ts
import type { Bus } from '../bus/bus';
import type { Db } from '../db/client';
import type { Logger } from '../logger';

export type Deps = { db: Db; bus: Bus; log: Logger };
```

`apps/server/src/domain/errors.ts`:

```ts
import type { ErrorCode } from '@group-chess/shared';

/** A business-rule failure; the HTTP and bot layers map `code` to a status or a one-line reply. */
export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}
```

- [ ] **Step 4: Generate the migration**

Run: `cd apps/server && pnpm db:generate && cd ../..`
Expected: `apps/server/drizzle/0000_<name>.sql` and `apps/server/drizzle/meta/` created; the SQL contains the twelve tables, the partial indexes `games_deadline_active`, `games_reminder_active`, `jobs_dedup_pending`, `jobs_run_at_pending` and the constraints `moves_game_id_ply_pk`, `moves_client_move_unique`.

- [ ] **Step 5: Write the test harness**

`apps/server/test/helpers/globalSetup.ts`:

```ts
import { runMigrations } from '../../src/db/migrate';

export default async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL must be set for integration tests');
  await runMigrations(url);
}
```

`apps/server/test/helpers/db.ts`:

```ts
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
    sql`truncate table admin_actions, shares, board_images, moves, games, challenges, ratings, group_members, jobs, telegram_updates, groups, users restart identity cascade`,
  );
}

export function testDeps(db: Db): Deps {
  return { db, bus: new LocalBus(), log: createLogger('fatal') };
}
```

`apps/server/test/helpers/fixtures.ts`:

```ts
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
  const timePerMove: TimePerMove = rest.timePerMove === undefined ? 86400 : (rest.timePerMove as TimePerMove);
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
        reminderInSeconds === undefined ? null : sql`now() + make_interval(secs => ${reminderInSeconds})`,
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
  await db.insert(moves).values({ gameId, ply, uci, san, fenAfter, clientMoveId: `fixture-${gameId}-${ply}` });
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
```

- [ ] **Step 6: Write the failing integration test**

`apps/server/test/integration/db.test.ts`:

```ts
import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { dbNow } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { jobs } from '../../src/db/schema';
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
        String((error as { cause?: { message?: string } }).cause?.message ?? (error as Error).message),
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
    const [row] = await db.execute(sql`select deadline_at < now() as passed from games where id = ${game.id}`);
    expect(row?.passed).toBe(true);
    expect(game.publicId).toHaveLength(10);
  });
});
```

- [ ] **Step 7: Run the tests**

Run: `export $(scripts/local-postgres.sh start | cut -d' ' -f2) && pnpm vitest run --project server`
Expected: the unit tests pass (5 ids/bus); the integration file initially FAILS only if a helper is wrong — with the files above all pass: 9 tests in `server` (config 5, ids 2, bus 3 = 10 unit, plus 4 integration = 14). Read the output; if a fixture SQL expression fails, fix the fixture, not the test.

- [ ] **Step 8: Run the whole suite and the static checks**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm format:check`
Expected: all exit 0.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(server): add the PostgreSQL schema, migrations, ids, bus and the integration test harness"
```

---

### Task 3: Jobs outbox and worker

**Files:**
- Create: `apps/server/src/jobs/types.ts`, `apps/server/src/jobs/queue.ts`, `apps/server/src/jobs/worker.ts`
- Test: `apps/server/test/integration/jobs.test.ts`

**Interfaces:**
- Consumes: `Db`, `DbOrTx` (Task 2 `db/client`), `jobs`, `JobRow` (Task 2 schema), `Logger` (Task 1).
- Produces: `JOB_KINDS`, `type JobKind`, `type JobPayload = Record<string, unknown>`, `type JobResult = { outcome: 'done' } | { outcome: 'retry'; delayMs: number; error?: string } | { outcome: 'fail'; error: string }`, `type JobContext = { job: JobRow; db: Db; log: Logger }`, `type JobHandler = (ctx: JobContext) => Promise<JobResult | void>`, `type JobHandlers = Partial<Record<JobKind, JobHandler>>`; `enqueue(tx: DbOrTx, input: { kind: JobKind; payload?: JobPayload; dedupKey?: string; delaySeconds?: number; maxAttempts?: number }): Promise<void>`; `backoffSeconds(attempts: number): number`; `class JobWorker { constructor(opts: { db; log; handlers; workerId?; batchSize?; leaseSeconds?; pollMs? }); runOnce(): Promise<number>; start(): void; stop(): Promise<void> }`.

- [ ] **Step 1: Write the failing test**

`apps/server/test/integration/jobs.test.ts`:

```ts
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { jobs } from '../../src/db/schema';
import { enqueue } from '../../src/jobs/queue';
import { JobWorker } from '../../src/jobs/worker';
import type { JobHandlers } from '../../src/jobs/types';
import { createLogger } from '../../src/logger';
import { openTestDb, truncateAll } from '../helpers/db';

const { db, close } = openTestDb();
const log = createLogger('fatal');

beforeEach(() => truncateAll(db));
afterAll(() => close());

const worker = (handlers: JobHandlers) => new JobWorker({ db, log, handlers, workerId: 'test-worker' });
const rows = () => db.select().from(jobs).orderBy(jobs.id);
const secondsFromNow = async (column: 'run_at' | 'locked_until' | 'done_at', id: number) => {
  const [row] = await db.execute(
    sql`select extract(epoch from (${sql.raw(column)} - now())) as seconds from jobs where id = ${id}`,
  );
  return Number(row?.seconds);
};

describe('enqueue', () => {
  it('inserts a pending job that is due now', async () => {
    await enqueue(db, { kind: 'prune', payload: { day: 1 } });
    const [job] = await rows();
    expect(job).toMatchObject({ kind: 'prune', payload: { day: 1 }, attempts: 0, maxAttempts: 8 });
    expect(job?.doneAt).toBeNull();
    expect(await secondsFromNow('run_at', job!.id)).toBeLessThanOrEqual(0);
  });

  it('collapses a re-enqueue on the same dedup key into one row and moves its run_at', async () => {
    await enqueue(db, { kind: 'edit_card', dedupKey: 'card:g:1', delaySeconds: 60 });
    await enqueue(db, { kind: 'edit_card', dedupKey: 'card:g:1' });
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(await secondsFromNow('run_at', all[0]!.id)).toBeLessThanOrEqual(0);
  });

  it('allows a new pending job once the previous one with that key is done', async () => {
    await enqueue(db, { kind: 'edit_card', dedupKey: 'card:g:1' });
    await db.update(jobs).set({ doneAt: sql`now()` });
    await enqueue(db, { kind: 'edit_card', dedupKey: 'card:g:1' });
    expect(await rows()).toHaveLength(2);
  });
});

describe('JobWorker', () => {
  it('runs a due job with its payload and marks it done', async () => {
    await enqueue(db, { kind: 'prune', payload: { day: 7 } });
    const seen: unknown[] = [];
    const processed = await worker({
      prune: async ({ job }) => {
        seen.push(job.payload);
      },
    }).runOnce();
    expect(processed).toBe(1);
    expect(seen).toEqual([{ day: 7 }]);
    const [job] = await rows();
    expect(job?.doneAt).not.toBeNull();
    expect(job?.lockedUntil).toBeNull();
    expect(job?.failedAt).toBeNull();
  });

  it('leaves a job that is not yet due alone', async () => {
    await enqueue(db, { kind: 'prune', delaySeconds: 60 });
    expect(await worker({ prune: async () => undefined }).runOnce()).toBe(0);
  });

  it('reschedules with backoff after a thrown error and fails after max attempts', async () => {
    await enqueue(db, { kind: 'prune', maxAttempts: 2 });
    const failing = worker({
      prune: async () => {
        throw new Error('boom');
      },
    });
    await failing.runOnce();
    let [job] = await rows();
    expect(job).toMatchObject({ attempts: 1, lastError: 'boom', doneAt: null, failedAt: null });
    expect(await secondsFromNow('run_at', job!.id)).toBeGreaterThan(4);
    await db.update(jobs).set({ runAt: sql`now()` }).where(eq(jobs.id, job!.id));
    await failing.runOnce();
    [job] = await rows();
    expect(job?.attempts).toBe(2);
    expect(job?.failedAt).not.toBeNull();
    expect(job?.doneAt).not.toBeNull();
  });

  it('honours a handler-requested retry without counting an attempt', async () => {
    await enqueue(db, { kind: 'lichess_import' });
    await worker({
      lichess_import: async () => ({ outcome: 'retry', delayMs: 30_000, error: 'rate limited' }),
    }).runOnce();
    const [job] = await rows();
    expect(job).toMatchObject({ attempts: 0, lastError: 'rate limited', doneAt: null });
    expect(await secondsFromNow('run_at', job!.id)).toBeGreaterThan(25);
  });

  it('fails a job of a kind with no handler', async () => {
    await enqueue(db, { kind: 'send_welcome' });
    await worker({}).runOnce();
    const [job] = await rows();
    expect(job?.failedAt).not.toBeNull();
    expect(job?.lastError).toMatch(/no handler/);
  });

  it('skips a job leased by another worker until the lease expires', async () => {
    await enqueue(db, { kind: 'prune' });
    await db.update(jobs).set({ lockedUntil: sql`now() + interval '60 seconds'`, lockedBy: 'other' });
    const w = worker({ prune: async () => undefined });
    expect(await w.runOnce()).toBe(0);
    await db.update(jobs).set({ lockedUntil: sql`now() - interval '1 second'` });
    expect(await w.runOnce()).toBe(1);
  });

  it('runs a job again when it was re-enqueued while being processed', async () => {
    await enqueue(db, { kind: 'edit_card', dedupKey: 'card:g:1' });
    let calls = 0;
    const w = worker({
      edit_card: async () => {
        calls += 1;
        if (calls === 1) await enqueue(db, { kind: 'edit_card', dedupKey: 'card:g:1' });
      },
    });
    await w.runOnce();
    let [job] = await rows();
    expect(calls).toBe(1);
    expect(job?.doneAt).toBeNull();
    expect(job?.lockedUntil).toBeNull();
    await w.runOnce();
    [job] = await rows();
    expect(calls).toBe(2);
    expect(job?.doneAt).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run --project server apps/server/test/integration/jobs.test.ts`
Expected: FAIL — cannot load `../../src/jobs/queue`.

- [ ] **Step 3: Write the implementation**

`apps/server/src/jobs/types.ts`:

```ts
import type { Db } from '../db/client';
import type { JobRow } from '../db/schema';
import type { Logger } from '../logger';

/** Every side effect is one of these (spec §10). */
export const JOB_KINDS = [
  'send_challenge_card',
  'edit_card',
  'send_share_photo',
  'send_dm',
  'send_welcome',
  'send_message',
  'lichess_import',
  'rebuild_ratings',
  'prune',
] as const;

export type JobKind = (typeof JOB_KINDS)[number];

export type JobPayload = Record<string, unknown>;

export type JobResult =
  | { outcome: 'done' }
  /** Try again later without counting an attempt (Telegram 429, Lichess busy). */
  | { outcome: 'retry'; delayMs: number; error?: string }
  | { outcome: 'fail'; error: string };

export type JobContext = { job: JobRow; db: Db; log: Logger };

export type JobHandler = (ctx: JobContext) => Promise<JobResult | void>;

export type JobHandlers = Partial<Record<JobKind, JobHandler>>;
```

`apps/server/src/jobs/queue.ts`:

```ts
import { sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { jobs } from '../db/schema';
import type { JobKind, JobPayload } from './types';

export type EnqueueInput = {
  kind: JobKind;
  payload?: JobPayload;
  /** A pending job with the same key is moved to the new run_at instead of duplicated (spec §10). */
  dedupKey?: string;
  delaySeconds?: number;
  maxAttempts?: number;
};

export async function enqueue(tx: DbOrTx, input: EnqueueInput): Promise<void> {
  const runAt = input.delaySeconds
    ? sql`now() + make_interval(secs => ${input.delaySeconds})`
    : sql`now()`;
  const values = {
    kind: input.kind,
    payload: input.payload ?? {},
    dedupKey: input.dedupKey ?? null,
    runAt,
    maxAttempts: input.maxAttempts ?? 8,
  };
  if (!input.dedupKey) {
    await tx.insert(jobs).values(values);
    return;
  }
  await tx
    .insert(jobs)
    .values(values)
    .onConflictDoUpdate({
      target: jobs.dedupKey,
      targetWhere: sql`done_at is null`,
      set: { runAt: sql`excluded.run_at` },
    });
}
```

`apps/server/src/jobs/worker.ts`:

```ts
import { and, eq, getTableColumns, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { jobs, type JobRow } from '../db/schema';
import type { Logger } from '../logger';
import type { JobHandlers, JobKind, JobResult } from './types';

export type WorkerOptions = {
  db: Db;
  log: Logger;
  handlers: JobHandlers;
  workerId?: string;
  batchSize?: number;
  leaseSeconds?: number;
  pollMs?: number;
};

type LeasedJob = JobRow & { runAtText: string };

type Outcome = JobResult | { outcome: 'error'; error: string };

/** Spec §10: `min(5 s · 2^attempts, 1 h)` where `attempts` counts failures so far. */
export function backoffSeconds(attempts: number): number {
  return Math.min(5 * 2 ** attempts, 3600);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class JobWorker {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private inFlight: Promise<void> | null = null;

  constructor(private readonly options: WorkerOptions) {}

  /** One poll: lease due jobs and run them in order. Returns how many were processed. */
  async runOnce(): Promise<number> {
    const leased = await this.lease();
    for (const job of leased) await this.process(job);
    return leased.length;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    const tick = async (): Promise<void> => {
      this.inFlight = this.runOnce()
        .then(() => undefined)
        .catch((error: unknown) => {
          this.options.log.error({ err: error }, 'job worker poll failed');
        });
      await this.inFlight;
      if (!this.stopped) this.timer = setTimeout(() => void tick(), this.options.pollMs ?? 1000);
    };
    this.timer = setTimeout(() => void tick(), 0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.inFlight) await this.inFlight;
  }

  private async lease(): Promise<LeasedJob[]> {
    const { db, batchSize = 20, leaseSeconds = 60, workerId = 'worker' } = this.options;
    return db.transaction(async (tx) => {
      const due = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            isNull(jobs.doneAt),
            lte(jobs.runAt, sql`now()`),
            or(isNull(jobs.lockedUntil), sql`${jobs.lockedUntil} < now()`),
          ),
        )
        .orderBy(jobs.runAt)
        .limit(batchSize)
        .for('update', { skipLocked: true });
      if (due.length === 0) return [];
      return tx
        .update(jobs)
        .set({ lockedUntil: sql`now() + make_interval(secs => ${leaseSeconds})`, lockedBy: workerId })
        .where(
          inArray(
            jobs.id,
            due.map((row) => row.id),
          ),
        )
        .returning({ ...getTableColumns(jobs), runAtText: sql<string>`${jobs.runAt}::text` });
    });
  }

  private async process(job: LeasedJob): Promise<void> {
    const { db, log, handlers } = this.options;
    const handler = handlers[job.kind as JobKind];
    let outcome: Outcome;
    if (!handler) {
      outcome = { outcome: 'fail', error: `no handler for kind ${job.kind}` };
    } else {
      try {
        outcome = (await handler({ job, db, log })) ?? { outcome: 'done' };
      } catch (error) {
        outcome = { outcome: 'error', error: errorMessage(error) };
      }
    }
    const unlock = { lockedUntil: null, lockedBy: null };
    switch (outcome.outcome) {
      case 'done': {
        // Only mark done if nobody moved run_at while we were working; otherwise it runs again.
        const updated = await db
          .update(jobs)
          .set({ doneAt: sql`now()`, ...unlock })
          .where(and(eq(jobs.id, job.id), sql`${jobs.runAt}::text = ${job.runAtText}`))
          .returning({ id: jobs.id });
        if (updated.length === 0) {
          await db.update(jobs).set(unlock).where(eq(jobs.id, job.id));
          log.debug({ jobId: job.id, kind: job.kind }, 'job re-enqueued while running; will run again');
        }
        return;
      }
      case 'retry':
        await db
          .update(jobs)
          .set({
            runAt: sql`now() + make_interval(secs => ${outcome.delayMs / 1000})`,
            lastError: outcome.error ?? null,
            ...unlock,
          })
          .where(eq(jobs.id, job.id));
        return;
      case 'fail':
        await db
          .update(jobs)
          .set({ failedAt: sql`now()`, doneAt: sql`now()`, lastError: outcome.error, ...unlock })
          .where(eq(jobs.id, job.id));
        log.error({ jobId: job.id, kind: job.kind, error: outcome.error }, 'job failed');
        return;
      case 'error': {
        const attempts = job.attempts + 1;
        if (attempts >= job.maxAttempts) {
          await db
            .update(jobs)
            .set({ attempts, failedAt: sql`now()`, doneAt: sql`now()`, lastError: outcome.error, ...unlock })
            .where(eq(jobs.id, job.id));
          log.error({ jobId: job.id, kind: job.kind, error: outcome.error, attempts }, 'job exhausted');
        } else {
          await db
            .update(jobs)
            .set({
              attempts,
              runAt: sql`now() + make_interval(secs => ${backoffSeconds(job.attempts)})`,
              lastError: outcome.error,
              ...unlock,
            })
            .where(eq(jobs.id, job.id));
          log.warn({ jobId: job.id, kind: job.kind, error: outcome.error, attempts }, 'job failed; retrying');
        }
      }
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run --project server apps/server/test/integration/jobs.test.ts`
Expected: PASS — 10 tests.

- [ ] **Step 5: Run the whole suite and the static checks**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm format:check`
Expected: all exit 0.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(server): add the jobs outbox with dedup and a leasing worker"
```

---

### Task 4: Users, groups and members

**Files:**
- Create: `apps/server/src/domain/users.ts`, `apps/server/src/domain/groups.ts`, `apps/server/src/domain/members.ts`, `apps/server/src/domain/players.ts`
- Test: `apps/server/test/integration/users-groups.test.ts`

**Interfaces:**
- Consumes: Task 2 schema rows and `generatePublicId`; `DomainError`; `PREFS_DEFAULTS`, `GROUP_SETTINGS_DEFAULTS`, `GroupSettingsSchema`, `GLICKO2`, `isProvisional`, `type Prefs`, `type GroupSettings`, `type PlayerRef` from shared.
- Produces: users — `type TelegramUserInfo`, `ensureUser(tx, info): Promise<UserRow>`, `getUserById(tx, id): Promise<UserRow | null>`, `requireUser(tx, id): Promise<UserRow>`, `prefsOf(user): Prefs`, `updatePrefs(tx, userId, patch): Promise<Prefs>`, `recordWriteAccess(tx, userId, allowed): Promise<void>`, `setDmAllowed(tx, userId, allowed): Promise<void>`, `displayName(user): string`; groups — `type TelegramChatInfo`, `ensureGroup(tx, info): Promise<GroupRow>`, `getGroupByPublicId`, `requireGroupByPublicId`, `getGroupByChatId`, `settingsOf(group): GroupSettings`, `updateGroupSettings(tx, groupId, patch): Promise<GroupSettings>`, `setBotMembership(tx, groupId, { botStatus, botIsAdmin, botCanPin })`, `migrateChatId(tx, oldChatId, newChatId)`; members — `touchMember(tx, groupId, userId, { verified? })`, `markLeft`, `getMember`, `isBlocked(tx, groupId, userId): Promise<boolean>`, `blockUser(tx, groupId, userId, byAdminId)`, `unblockUser`, `listKnownPlayers(tx, groupId, { excludeUserId?, limit? }): Promise<PlayerRef[]>`; players — `toPlayerRef(user, rating | null): PlayerRef`.

- [ ] **Step 1: Write the failing test**

`apps/server/test/integration/users-groups.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ratings } from '../../src/db/schema';
import {
  ensureGroup,
  getGroupByChatId,
  migrateChatId,
  settingsOf,
  updateGroupSettings,
} from '../../src/domain/groups';
import {
  blockUser,
  isBlocked,
  listKnownPlayers,
  markLeft,
  touchMember,
  unblockUser,
} from '../../src/domain/members';
import { ensureUser, prefsOf, recordWriteAccess, updatePrefs } from '../../src/domain/users';
import { openTestDb, truncateAll } from '../helpers/db';
import { insertGroup, insertUser } from '../helpers/fixtures';

const { db, close } = openTestDb();

beforeEach(() => truncateAll(db));
afterAll(() => close());

describe('users', () => {
  it('creates a user once and refreshes the name on later sightings', async () => {
    const first = await ensureUser(db, { telegramUserId: 42, firstName: 'Alice', username: 'alice' });
    const second = await ensureUser(db, { telegramUserId: 42, firstName: 'Alicia', username: null });
    expect(second.id).toBe(first.id);
    expect(second.firstName).toBe('Alicia');
    expect(second.username).toBeNull();
    expect(prefsOf(second)).toEqual({
      confirmMoves: true,
      closeAfterMove: true,
      notifications: true,
      boardTheme: null,
      pieceSet: null,
    });
  });

  it('merges preference updates over the defaults', async () => {
    const user = await ensureUser(db, { telegramUserId: 42, firstName: 'Alice' });
    await updatePrefs(db, user.id, { confirmMoves: false });
    const prefs = await updatePrefs(db, user.id, { boardTheme: 'wood' });
    expect(prefs).toMatchObject({ confirmMoves: false, closeAfterMove: true, boardTheme: 'wood' });
  });

  it('records the write-access prompt result', async () => {
    const user = await ensureUser(db, { telegramUserId: 42, firstName: 'Alice' });
    await recordWriteAccess(db, user.id, true);
    const again = await ensureUser(db, { telegramUserId: 42, firstName: 'Alice' });
    expect(again.dmAllowed).toBe(true);
    expect(again.writeAccessAskedAt).not.toBeNull();
  });
});

describe('groups', () => {
  it('creates a group with a public id and updates its title later', async () => {
    const first = await ensureGroup(db, { telegramChatId: -100123, title: 'Club', type: 'supergroup' });
    const second = await ensureGroup(db, {
      telegramChatId: -100123,
      title: 'Chess Club',
      type: 'supergroup',
      isForum: true,
    });
    expect(second.id).toBe(first.id);
    expect(second.publicId).toBe(first.publicId);
    expect(second.publicId).toHaveLength(10);
    expect(second.title).toBe('Chess Club');
    expect(second.isForum).toBe(true);
  });

  it('merges settings over the defaults and validates the result', async () => {
    const group = await ensureGroup(db, { telegramChatId: -1, title: 'Club', type: 'group' });
    expect(settingsOf(group).maxActiveGamesPerUser).toBe(5);
    const updated = await updateGroupSettings(db, group.id, { maxActiveGamesPerUser: 3 });
    expect(updated).toMatchObject({ maxActiveGamesPerUser: 3, leaderboardMinGames: 5 });
    await expect(updateGroupSettings(db, group.id, { maxActiveGamesPerUser: 0 })).rejects.toMatchObject({
      code: 'validation',
    });
  });

  it('follows a group to supergroup migration', async () => {
    const group = await ensureGroup(db, { telegramChatId: -1, title: 'Club', type: 'group' });
    await migrateChatId(db, -1, -1001);
    expect((await getGroupByChatId(db, -1001))?.id).toBe(group.id);
    expect(await getGroupByChatId(db, -1)).toBeNull();
  });
});

describe('members', () => {
  it('lists known players newest-seen first, excluding blocked, left, deleted and the viewer', async () => {
    const group = await insertGroup(db);
    const viewer = await insertUser(db, { firstName: 'Viewer' });
    const alice = await insertUser(db, { firstName: 'Alice' });
    const bob = await insertUser(db, { firstName: 'Bob' });
    const carol = await insertUser(db, { firstName: 'Carol' });
    const dave = await insertUser(db, { firstName: 'Dave' });
    const erin = await insertUser(db, { firstName: 'Erin', deletedAt: new Date() });
    for (const user of [viewer, alice, bob, carol, dave, erin]) await touchMember(db, group.id, user.id);
    await db.insert(ratings).values({ groupId: group.id, userId: alice.id, rating: 1600.4, rd: 60, volatility: 0.06 });
    await blockUser(db, group.id, carol.id, viewer.id);
    await markLeft(db, group.id, dave.id);
    await touchMember(db, group.id, alice.id);

    const players = await listKnownPlayers(db, group.id, { excludeUserId: viewer.id });
    expect(players.map((p) => p.name)).toEqual(['Alice', 'Bob']);
    expect(players[0]).toMatchObject({ id: String(alice.id), rating: 1600, provisional: false });
    expect(players[1]).toMatchObject({ rating: 1500, provisional: true });
  });

  it('blocks and unblocks a user', async () => {
    const group = await insertGroup(db);
    const admin = await insertUser(db);
    const user = await insertUser(db);
    expect(await isBlocked(db, group.id, user.id)).toBe(false);
    await blockUser(db, group.id, user.id, admin.id);
    expect(await isBlocked(db, group.id, user.id)).toBe(true);
    await unblockUser(db, group.id, user.id);
    expect(await isBlocked(db, group.id, user.id)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run --project server apps/server/test/integration/users-groups.test.ts`
Expected: FAIL — cannot load `../../src/domain/groups`.

- [ ] **Step 3: Write the implementation**

`apps/server/src/domain/users.ts`:

```ts
import { PREFS_DEFAULTS, type Prefs } from '@group-chess/shared';
import { eq, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { users, type UserRow } from '../db/schema';
import { DomainError } from './errors';

export type TelegramUserInfo = {
  telegramUserId: number;
  firstName: string;
  username?: string | null;
  languageCode?: string | null;
};

/** Upsert keyed by Telegram id; refreshes the display fields and `last_seen_at` (spec §8). */
export async function ensureUser(tx: DbOrTx, info: TelegramUserInfo): Promise<UserRow> {
  const fields = {
    firstName: info.firstName,
    username: info.username ?? null,
    languageCode: info.languageCode ?? null,
  };
  const [row] = await tx
    .insert(users)
    .values({ telegramUserId: info.telegramUserId, ...fields })
    .onConflictDoUpdate({ target: users.telegramUserId, set: { ...fields, lastSeenAt: sql`now()` } })
    .returning();
  if (!row) throw new Error('ensureUser returned no row');
  return row;
}

export async function getUserById(tx: DbOrTx, id: number): Promise<UserRow | null> {
  const [row] = await tx.select().from(users).where(eq(users.id, id)).limit(1);
  return row ?? null;
}

export async function requireUser(tx: DbOrTx, id: number): Promise<UserRow> {
  const row = await getUserById(tx, id);
  if (!row) throw new DomainError('not_found', 'user not found', { userId: id });
  return row;
}

export function prefsOf(user: Pick<UserRow, 'prefs'>): Prefs {
  return { ...PREFS_DEFAULTS, ...user.prefs };
}

export async function updatePrefs(tx: DbOrTx, userId: number, patch: Partial<Prefs>): Promise<Prefs> {
  const [row] = await tx
    .update(users)
    .set({ prefs: sql`${users.prefs} || ${JSON.stringify(patch)}::jsonb` })
    .where(eq(users.id, userId))
    .returning();
  if (!row) throw new DomainError('not_found', 'user not found', { userId });
  return prefsOf(row);
}

export async function recordWriteAccess(tx: DbOrTx, userId: number, allowed: boolean): Promise<void> {
  await tx
    .update(users)
    .set({ dmAllowed: allowed, writeAccessAskedAt: sql`now()` })
    .where(eq(users.id, userId));
}

export async function setDmAllowed(tx: DbOrTx, userId: number, allowed: boolean): Promise<void> {
  await tx.update(users).set({ dmAllowed: allowed }).where(eq(users.id, userId));
}

export function displayName(user: Pick<UserRow, 'firstName' | 'deletedAt'>): string {
  return user.deletedAt ? 'Deleted player' : user.firstName;
}
```

`apps/server/src/domain/groups.ts`:

```ts
import { GROUP_SETTINGS_DEFAULTS, GroupSettingsSchema, type GroupSettings } from '@group-chess/shared';
import { eq, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { generatePublicId } from '../db/ids';
import { groups, type GroupRow } from '../db/schema';
import { DomainError } from './errors';

export type TelegramChatInfo = {
  telegramChatId: number;
  title: string;
  type: 'group' | 'supergroup';
  isForum?: boolean;
};

export async function ensureGroup(tx: DbOrTx, info: TelegramChatInfo): Promise<GroupRow> {
  const fields = { title: info.title, type: info.type, isForum: info.isForum ?? false };
  const [row] = await tx
    .insert(groups)
    .values({ publicId: generatePublicId(), telegramChatId: info.telegramChatId, ...fields })
    .onConflictDoUpdate({
      target: groups.telegramChatId,
      set: { ...fields, updatedAt: sql`now()` },
    })
    .returning();
  if (!row) throw new Error('ensureGroup returned no row');
  return row;
}

export async function getGroupByPublicId(tx: DbOrTx, publicId: string): Promise<GroupRow | null> {
  const [row] = await tx.select().from(groups).where(eq(groups.publicId, publicId)).limit(1);
  return row ?? null;
}

export async function requireGroupByPublicId(tx: DbOrTx, publicId: string): Promise<GroupRow> {
  const row = await getGroupByPublicId(tx, publicId);
  if (!row) throw new DomainError('not_found', 'group not found');
  return row;
}

export async function getGroupByChatId(tx: DbOrTx, telegramChatId: number): Promise<GroupRow | null> {
  const [row] = await tx.select().from(groups).where(eq(groups.telegramChatId, telegramChatId)).limit(1);
  return row ?? null;
}

export function settingsOf(group: Pick<GroupRow, 'settings'>): GroupSettings {
  return { ...GROUP_SETTINGS_DEFAULTS, ...group.settings };
}

/** Merges a partial update and validates the whole result, so a bad field can never be stored. */
export async function updateGroupSettings(
  tx: DbOrTx,
  groupId: number,
  patch: Partial<GroupSettings>,
): Promise<GroupSettings> {
  const [current] = await tx.select().from(groups).where(eq(groups.id, groupId)).limit(1);
  if (!current) throw new DomainError('not_found', 'group not found');
  const parsed = GroupSettingsSchema.safeParse({ ...settingsOf(current), ...patch });
  if (!parsed.success) {
    throw new DomainError('validation', 'invalid group settings', {
      issues: parsed.error.issues.map((issue) => issue.path.join('.')),
    });
  }
  await tx
    .update(groups)
    .set({ settings: parsed.data, updatedAt: sql`now()` })
    .where(eq(groups.id, groupId));
  return parsed.data;
}

export async function setBotMembership(
  tx: DbOrTx,
  groupId: number,
  state: { botStatus: GroupRow['botStatus']; botIsAdmin: boolean; botCanPin: boolean },
): Promise<void> {
  await tx
    .update(groups)
    .set({ ...state, updatedAt: sql`now()` })
    .where(eq(groups.id, groupId));
}

/** `migrate_to_chat_id`: the Telegram id changes, the internal id and every game stay (spec §5.8). */
export async function migrateChatId(tx: DbOrTx, oldChatId: number, newChatId: number): Promise<void> {
  await tx
    .update(groups)
    .set({ telegramChatId: newChatId, type: 'supergroup', updatedAt: sql`now()` })
    .where(eq(groups.telegramChatId, oldChatId));
}
```

`apps/server/src/domain/players.ts`:

```ts
import { GLICKO2, isProvisional, type PlayerRef } from '@group-chess/shared';
import type { RatingRow, UserRow } from '../db/schema';
import { displayName } from './users';

/** The player shape the API sends everywhere; ratings default to 1500 provisional (spec §7.9). */
export function toPlayerRef(
  user: Pick<UserRow, 'id' | 'firstName' | 'username' | 'deletedAt'>,
  rating: Pick<RatingRow, 'rating' | 'rd'> | null,
): PlayerRef {
  return {
    id: String(user.id),
    name: displayName(user),
    username: user.deletedAt ? null : user.username,
    rating: Math.round(rating?.rating ?? GLICKO2.initialRating),
    provisional: isProvisional(rating?.rd ?? GLICKO2.initialRd),
  };
}
```

`apps/server/src/domain/members.ts`:

```ts
import type { PlayerRef } from '@group-chess/shared';
import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { groupMembers, ratings, users, type GroupMemberRow } from '../db/schema';
import { toPlayerRef } from './players';

/** Membership evidence from the user's own activity in the group (spec §5.6 step 4). */
export async function touchMember(
  tx: DbOrTx,
  groupId: number,
  userId: number,
  options: { verified?: boolean } = {},
): Promise<void> {
  const verified = options.verified ? { verifiedAt: sql`now()` } : {};
  await tx
    .insert(groupMembers)
    .values({ groupId, userId, ...verified })
    .onConflictDoUpdate({
      target: [groupMembers.groupId, groupMembers.userId],
      set: { status: 'member', lastSeenAt: sql`now()`, ...verified },
    });
}

export async function markLeft(tx: DbOrTx, groupId: number, userId: number): Promise<void> {
  await tx
    .update(groupMembers)
    .set({ status: 'left' })
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)));
}

export async function getMember(
  tx: DbOrTx,
  groupId: number,
  userId: number,
): Promise<GroupMemberRow | null> {
  const [row] = await tx
    .select()
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)))
    .limit(1);
  return row ?? null;
}

export async function isBlocked(tx: DbOrTx, groupId: number, userId: number): Promise<boolean> {
  const member = await getMember(tx, groupId, userId);
  return member?.blockedAt != null;
}

export async function blockUser(
  tx: DbOrTx,
  groupId: number,
  userId: number,
  byAdminId: number,
): Promise<void> {
  await tx
    .insert(groupMembers)
    .values({ groupId, userId, blockedAt: sql`now()`, blockedBy: byAdminId })
    .onConflictDoUpdate({
      target: [groupMembers.groupId, groupMembers.userId],
      set: { blockedAt: sql`now()`, blockedBy: byAdminId },
    });
}

export async function unblockUser(tx: DbOrTx, groupId: number, userId: number): Promise<void> {
  await tx
    .update(groupMembers)
    .set({ blockedAt: null, blockedBy: null })
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)));
}

/** The opponent picker: members the bot has seen here, newest first (spec §5.6, PRD §7.2). */
export async function listKnownPlayers(
  tx: DbOrTx,
  groupId: number,
  options: { excludeUserId?: number; limit?: number } = {},
): Promise<PlayerRef[]> {
  const conditions = [
    eq(groupMembers.groupId, groupId),
    eq(groupMembers.status, 'member'),
    isNull(groupMembers.blockedAt),
    isNull(users.deletedAt),
  ];
  if (options.excludeUserId !== undefined) conditions.push(ne(users.id, options.excludeUserId));
  const rows = await tx
    .select({ user: users, rating: ratings })
    .from(groupMembers)
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .leftJoin(ratings, and(eq(ratings.groupId, groupMembers.groupId), eq(ratings.userId, users.id)))
    .where(and(...conditions))
    .orderBy(desc(groupMembers.lastSeenAt), users.id)
    .limit(options.limit ?? 50);
  return rows.map((row) => toPlayerRef(row.user, row.rating));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run --project server apps/server/test/integration/users-groups.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Run the whole suite and the static checks**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm format:check`
Expected: all exit 0.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(server): add users, groups, settings and membership records"
```

---

### Task 5: Ratings — applying results, rebuilding after a void, leaderboard

**Files:**
- Create: `apps/server/src/domain/ratings.ts`
- Test: `apps/server/test/integration/ratings.test.ts`

**Interfaces:**
- Consumes: schema (Task 2); `applyRatedGame`, `replayRatings`, `freshPlayerState`, `isRatedEndReason`, `type PlayerRatingState`, `type RatingSnapshot`, `type LeaderboardEntry` from shared; `toPlayerRef` (Task 4).
- Produces: `loadRatingState(tx, groupId, userId): Promise<PlayerRatingState>`, `getPlayerRating(tx, groupId, userId): Promise<Pick<RatingRow, 'rating' | 'rd'> | null>`, `applyGameResultToRatings(tx, game: GameRow, finishedAt: Date): Promise<RatingSnapshot | null>`, `rebuildGroupRatings(tx, groupId): Promise<{ changedGameIds: number[] }>`, `getLeaderboard(tx, groupId, minGames): Promise<LeaderboardEntry[]>`.

- [ ] **Step 1: Write the failing test**

`apps/server/test/integration/ratings.test.ts`:

```ts
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { games, ratings, type GameRow } from '../../src/db/schema';
import { touchMember } from '../../src/domain/members';
import {
  applyGameResultToRatings,
  getLeaderboard,
  rebuildGroupRatings,
} from '../../src/domain/ratings';
import { openTestDb, truncateAll } from '../helpers/db';
import { insertGame, insertGroup, insertUser } from '../helpers/fixtures';

const { db, close } = openTestDb();

beforeEach(() => truncateAll(db));
afterAll(() => close());

const finishedAt = (day: number) => new Date(Date.UTC(2026, 8, day, 12));

async function finished(
  groupId: number,
  whiteId: number,
  blackId: number,
  result: '1-0' | '0-1' | '1/2-1/2' | '*',
  endReason: GameRow['endReason'],
  day: number,
  rated = true,
): Promise<GameRow> {
  const game = await insertGame(db, groupId, whiteId, blackId, {
    rated,
    status: 'finished',
    result,
    endReason,
    finishedAt: finishedAt(day),
    plyCount: 30,
  });
  return game;
}

const reload = async (id: number) => (await db.select().from(games).where(eq(games.id, id)))[0]!;

describe('applyGameResultToRatings', () => {
  it('rates a decisive rated game and stores the snapshots on the game', async () => {
    const group = await insertGroup(db);
    const alice = await insertUser(db);
    const bob = await insertUser(db);
    const game = await finished(group.id, alice.id, bob.id, '1-0', 'resignation', 1);

    const snapshot = await applyGameResultToRatings(db, game, finishedAt(1));

    expect(snapshot?.white.after.rating).toBeGreaterThan(1500);
    const rows = await db.select().from(ratings).orderBy(ratings.userId);
    expect(rows.map((r) => [r.userId, r.gamesPlayed, r.wins, r.losses])).toEqual([
      [alice.id, 1, 1, 0],
      [bob.id, 1, 0, 1],
    ]);
    const stored = await reload(game.id);
    expect(stored.whiteRatingBefore).toBe(1500);
    expect(stored.whiteRdBefore).toBe(350);
    expect(stored.whiteRatingAfter).toBeCloseTo(rows[0]!.rating, 9);
    expect(stored.blackRatingAfter).toBeCloseTo(rows[1]!.rating, 9);
  });

  it('does nothing for a casual game', async () => {
    const group = await insertGroup(db);
    const alice = await insertUser(db);
    const bob = await insertUser(db);
    const game = await finished(group.id, alice.id, bob.id, '1-0', 'resignation', 1, false);
    expect(await applyGameResultToRatings(db, game, finishedAt(1))).toBeNull();
    expect(await db.select().from(ratings)).toHaveLength(0);
    expect((await reload(game.id)).whiteRatingAfter).toBeNull();
  });

  it('does nothing for an aborted rated game', async () => {
    const group = await insertGroup(db);
    const alice = await insertUser(db);
    const bob = await insertUser(db);
    const game = await finished(group.id, alice.id, bob.id, '*', 'abort', 1);
    expect(await applyGameResultToRatings(db, game, finishedAt(1))).toBeNull();
    expect(await db.select().from(ratings)).toHaveLength(0);
  });
});

describe('rebuildGroupRatings', () => {
  it('rewrites later games’ snapshots after a void', async () => {
    const group = await insertGroup(db);
    const alice = await insertUser(db);
    const bob = await insertUser(db);
    const carol = await insertUser(db);
    const a = await finished(group.id, alice.id, bob.id, '1-0', 'checkmate', 1);
    const b = await finished(group.id, bob.id, carol.id, '1-0', 'resignation', 2);
    const c = await finished(group.id, carol.id, alice.id, '1/2-1/2', 'draw_agreement', 3);
    for (const game of [a, b, c]) await applyGameResultToRatings(db, game, game.finishedAt!);
    const carolBeforeVoid = (await reload(c.id)).whiteRatingBefore;
    const aliceAfterA = (await reload(a.id)).whiteRatingAfter;
    expect(carolBeforeVoid).toBeLessThan(1500);

    await db.update(games).set({ voidedAt: sql`now()`, voidedBy: alice.id }).where(eq(games.id, b.id));
    const { changedGameIds } = await rebuildGroupRatings(db, group.id);

    expect(changedGameIds).toEqual([c.id]);
    expect((await reload(c.id)).whiteRatingBefore).toBe(1500);
    expect((await reload(a.id)).whiteRatingAfter).toBeCloseTo(aliceAfterA ?? 0, 9);
    const rows = await db.select().from(ratings).orderBy(ratings.userId);
    expect(rows.map((r) => [r.userId, r.gamesPlayed])).toEqual([
      [alice.id, 2],
      [bob.id, 1],
      [carol.id, 1],
    ]);
  });

  it('removes rating rows for players whose games were all voided', async () => {
    const group = await insertGroup(db);
    const alice = await insertUser(db);
    const bob = await insertUser(db);
    const a = await finished(group.id, alice.id, bob.id, '1-0', 'checkmate', 1);
    await applyGameResultToRatings(db, a, finishedAt(1));
    await db.update(games).set({ voidedAt: sql`now()` }).where(eq(games.id, a.id));
    await rebuildGroupRatings(db, group.id);
    expect(await db.select().from(ratings)).toHaveLength(0);
  });
});

describe('getLeaderboard', () => {
  it('orders by rating, applies the minimum games and hides blocked and deleted players', async () => {
    const group = await insertGroup(db);
    const alice = await insertUser(db, { firstName: 'Alice' });
    const bob = await insertUser(db, { firstName: 'Bob' });
    const carol = await insertUser(db, { firstName: 'Carol' });
    const dave = await insertUser(db, { firstName: 'Dave', deletedAt: new Date() });
    for (const user of [alice, bob, carol, dave]) await touchMember(db, group.id, user.id);
    await db.insert(ratings).values([
      { groupId: group.id, userId: alice.id, rating: 1550, rd: 80, volatility: 0.06, gamesPlayed: 6, wins: 4, draws: 1, losses: 1 },
      { groupId: group.id, userId: bob.id, rating: 1600, rd: 90, volatility: 0.06, gamesPlayed: 5, wins: 5, draws: 0, losses: 0 },
      { groupId: group.id, userId: carol.id, rating: 1700, rd: 200, volatility: 0.06, gamesPlayed: 2, wins: 2, draws: 0, losses: 0 },
      { groupId: group.id, userId: dave.id, rating: 1800, rd: 50, volatility: 0.06, gamesPlayed: 9, wins: 9, draws: 0, losses: 0 },
    ]);
    const board = await getLeaderboard(db, group.id, 5);
    expect(board.map((e) => [e.name, e.rating, e.gamesPlayed])).toEqual([
      ['Bob', 1600, 5],
      ['Alice', 1550, 6],
    ]);
    expect(board[1]?.record).toEqual({ wins: 4, draws: 1, losses: 1 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run --project server apps/server/test/integration/ratings.test.ts`
Expected: FAIL — cannot load `../../src/domain/ratings`.

- [ ] **Step 3: Write the implementation**

`apps/server/src/domain/ratings.ts`:

```ts
import {
  applyRatedGame,
  freshPlayerState,
  isRatedEndReason,
  replayRatings,
  type LeaderboardEntry,
  type PlayerRatingState,
  type RatingSnapshot,
} from '@group-chess/shared';
import { and, asc, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { games, groupMembers, ratings, users, type GameRow, type RatingRow } from '../db/schema';
import { toPlayerRef } from './players';

const RATED_RESULTS = ['1-0', '0-1', '1/2-1/2'] as const;

type RatedResult = (typeof RATED_RESULTS)[number];

function isRatedResult(result: GameRow['result']): result is RatedResult {
  return result !== null && (RATED_RESULTS as readonly string[]).includes(result);
}

function toState(row: RatingRow): PlayerRatingState {
  return {
    rating: row.rating,
    rd: row.rd,
    volatility: row.volatility,
    gamesPlayed: row.gamesPlayed,
    wins: row.wins,
    draws: row.draws,
    losses: row.losses,
    lastRatedGameAt: row.lastRatedGameAt,
  };
}

function toRow(groupId: number, userId: number, state: PlayerRatingState): typeof ratings.$inferInsert {
  return { groupId, userId, ...state };
}

export async function getPlayerRating(
  tx: DbOrTx,
  groupId: number,
  userId: number,
): Promise<Pick<RatingRow, 'rating' | 'rd'> | null> {
  const [row] = await tx
    .select({ rating: ratings.rating, rd: ratings.rd })
    .from(ratings)
    .where(and(eq(ratings.groupId, groupId), eq(ratings.userId, userId)))
    .limit(1);
  return row ?? null;
}

export async function loadRatingState(
  tx: DbOrTx,
  groupId: number,
  userId: number,
): Promise<PlayerRatingState> {
  const [row] = await tx
    .select()
    .from(ratings)
    .where(and(eq(ratings.groupId, groupId), eq(ratings.userId, userId)))
    .limit(1);
  return row ? toState(row) : freshPlayerState();
}

function snapshotColumns(snapshot: RatingSnapshot) {
  return {
    whiteRatingBefore: snapshot.white.before.rating,
    whiteRatingAfter: snapshot.white.after.rating,
    whiteRdBefore: snapshot.white.before.rd,
    whiteRdAfter: snapshot.white.after.rd,
    blackRatingBefore: snapshot.black.before.rating,
    blackRatingAfter: snapshot.black.after.rating,
    blackRdBefore: snapshot.black.before.rd,
    blackRdAfter: snapshot.black.after.rd,
  };
}

async function upsertStates(
  tx: DbOrTx,
  groupId: number,
  states: Map<string, PlayerRatingState>,
): Promise<void> {
  for (const [userId, state] of states) {
    const row = toRow(groupId, Number(userId), state);
    await tx
      .insert(ratings)
      .values(row)
      .onConflictDoUpdate({ target: [ratings.groupId, ratings.userId], set: row });
  }
}

/**
 * Each rated result is its own rating period for both players (spec §7.5). Returns null and
 * touches nothing for casual games and for results that do not change ratings (aborts, voids).
 */
export async function applyGameResultToRatings(
  tx: DbOrTx,
  game: GameRow,
  finishedAt: Date,
): Promise<RatingSnapshot | null> {
  if (!game.rated || !isRatedResult(game.result)) return null;
  if (!game.endReason || !isRatedEndReason(game.endReason)) return null;
  const white = String(game.whiteId);
  const black = String(game.blackId);
  const states = new Map<string, PlayerRatingState>([
    [white, await loadRatingState(tx, game.groupId, game.whiteId)],
    [black, await loadRatingState(tx, game.groupId, game.blackId)],
  ]);
  const snapshot = applyRatedGame(states, { white, black, result: game.result, finishedAt });
  await upsertStates(tx, game.groupId, states);
  await tx.update(games).set(snapshotColumns(snapshot)).where(eq(games.id, game.id));
  return snapshot;
}

const close = (a: number | null, b: number): boolean => a !== null && Math.abs(a - b) < 1e-6;

/** Spec §3.5, §7.5: replay every rated, finished, non-voided game in order; rewrite what changed. */
export async function rebuildGroupRatings(
  tx: DbOrTx,
  groupId: number,
): Promise<{ changedGameIds: number[] }> {
  const rows = await tx
    .select()
    .from(games)
    .where(
      and(
        eq(games.groupId, groupId),
        eq(games.status, 'finished'),
        eq(games.rated, true),
        isNull(games.voidedAt),
        inArray(games.result, [...RATED_RESULTS]),
      ),
    )
    .orderBy(asc(games.finishedAt), asc(games.id));
  const rated = rows.filter(
    (row): row is GameRow & { result: RatedResult; finishedAt: Date } =>
      isRatedResult(row.result) &&
      row.finishedAt !== null &&
      row.endReason !== null &&
      isRatedEndReason(row.endReason),
  );
  const { states, snapshots } = replayRatings(
    rated.map((row) => ({
      white: String(row.whiteId),
      black: String(row.blackId),
      result: row.result,
      finishedAt: row.finishedAt,
    })),
  );
  await tx.delete(ratings).where(eq(ratings.groupId, groupId));
  await upsertStates(tx, groupId, states);
  const changedGameIds: number[] = [];
  rated.forEach((row, index) => {
    const snapshot = snapshots[index]!;
    const columns = snapshotColumns(snapshot);
    const unchanged =
      close(row.whiteRatingBefore, columns.whiteRatingBefore) &&
      close(row.whiteRatingAfter, columns.whiteRatingAfter) &&
      close(row.whiteRdBefore, columns.whiteRdBefore) &&
      close(row.whiteRdAfter, columns.whiteRdAfter) &&
      close(row.blackRatingBefore, columns.blackRatingBefore) &&
      close(row.blackRatingAfter, columns.blackRatingAfter) &&
      close(row.blackRdBefore, columns.blackRdBefore) &&
      close(row.blackRdAfter, columns.blackRdAfter);
    if (!unchanged) changedGameIds.push(row.id);
  });
  for (const id of changedGameIds) {
    const index = rated.findIndex((row) => row.id === id);
    await tx.update(games).set(snapshotColumns(snapshots[index]!)).where(eq(games.id, id));
  }
  return { changedGameIds };
}

/** PRD §7.9: members with enough games, not deleted, not blocked; rating then games played. */
export async function getLeaderboard(
  tx: DbOrTx,
  groupId: number,
  minGames: number,
): Promise<LeaderboardEntry[]> {
  const rows = await tx
    .select({ user: users, rating: ratings, member: groupMembers })
    .from(ratings)
    .innerJoin(users, eq(users.id, ratings.userId))
    .leftJoin(
      groupMembers,
      and(eq(groupMembers.groupId, ratings.groupId), eq(groupMembers.userId, ratings.userId)),
    )
    .where(
      and(
        eq(ratings.groupId, groupId),
        gte(ratings.gamesPlayed, minGames),
        isNull(users.deletedAt),
        sql`${groupMembers.blockedAt} is null`,
      ),
    )
    .orderBy(desc(ratings.rating), desc(ratings.gamesPlayed), asc(users.id));
  return rows.map((row) => ({
    ...toPlayerRef(row.user, row.rating),
    gamesPlayed: row.rating.gamesPlayed,
    record: { wins: row.rating.wins, draws: row.rating.draws, losses: row.rating.losses },
  }));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run --project server apps/server/test/integration/ratings.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Run the whole suite and the static checks**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm format:check`
Expected: all exit 0.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(server): apply rated results, rebuild ratings after a void, and build the leaderboard"
```

---

### Task 6: Challenges — create, accept, decline, cancel, expire, rematch

**Files:**
- Create: `apps/server/src/domain/limits.ts`, `apps/server/src/domain/challenges.ts`
- Modify: `apps/server/src/domain/groups.ts` (add `getGroupById`, `requireGroup`)
- Test: `apps/server/test/integration/challenges.test.ts`

**Interfaces:**
- Consumes: schema, `dbNow`, `generatePublicId`, `enqueue`, `DomainError`, `Deps`, `requireUser`, `settingsOf`, `isBlocked` (Tasks 2–4); `INITIAL_FEN`, `opposite`, `type ColourChoice`, `type TimePerMove` from shared.
- Produces: limits — `MAX_PENDING_CHALLENGES = 3`, `MAX_GAMES_PER_PAIR = 2`, `countActiveGames(tx, groupId, userId)`, `countActiveGamesBetween(tx, groupId, a, b)`, `countPendingChallenges(tx, groupId, challengerId)`, `reminderExpression(timePerMove, dmAllowed): SQL | null`; challenges — `type CreateChallengeInput = { groupId: number; challengerId: number; opponentId: number | null; timePerMove: TimePerMove; colour: ColourChoice; rated: boolean; threadId: number | null }`, `createChallenge(deps, input): Promise<ChallengeRow>`, `acceptChallenge(deps, { challengeId: number; userId: number }): Promise<{ challenge: ChallengeRow; game: GameRow }>`, `declineChallenge(deps, { challengeId, userId }): Promise<ChallengeRow>`, `cancelChallenge(deps, { challengeId, userId }): Promise<ChallengeRow>`, `expireChallenges(deps, limit?): Promise<number>`, `createRematch(deps, { gameId: number; userId: number }): Promise<ChallengeRow>`, `getChallengeByPublicId(tx, publicId)`, `getChallengeById(tx, id)`, `setChallengeMessage(tx, challengeId, messageId)`; groups — `getGroupById(tx, id)`, `requireGroup(tx, id)`.
- `DomainError.details.reason` values the bot maps to one-line replies: `self`, `blocked`, `pending_limit`, `active_limit` (with `name`, `count`), `pair_limit` (with `name`, `count`), `open_disabled`, `not_your_challenge` (with `opponentId`), `own_challenge`, `accepted_first`, `challenge_gone`, `opponent_gone`.

- [ ] **Step 1: Write the failing test**

`apps/server/test/integration/challenges.test.ts`:

```ts
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { challenges, games, jobs, users } from '../../src/db/schema';
import {
  acceptChallenge,
  cancelChallenge,
  createChallenge,
  createRematch,
  declineChallenge,
  expireChallenges,
} from '../../src/domain/challenges';
import { updateGroupSettings } from '../../src/domain/groups';
import { blockUser, touchMember } from '../../src/domain/members';
import { openTestDb, testDeps, truncateAll } from '../helpers/db';
import { insertChallenge, insertGame, insertGroup, insertUser } from '../helpers/fixtures';

const { db, close } = openTestDb();
const deps = testDeps(db);

beforeEach(() => truncateAll(db));
afterAll(() => close());

async function setup() {
  const group = await insertGroup(db);
  const [alice, bob, carol] = await Promise.all([
    insertUser(db, { firstName: 'Alice' }),
    insertUser(db, { firstName: 'Bob' }),
    insertUser(db, { firstName: 'Carol' }),
  ]);
  for (const user of [alice, bob, carol]) await touchMember(db, group.id, user.id);
  return { group, alice, bob, carol };
}

const direct = (groupId: number, challengerId: number, opponentId: number | null) =>
  createChallenge(deps, {
    groupId,
    challengerId,
    opponentId,
    timePerMove: 86400,
    colour: 'random',
    rated: true,
    threadId: null,
  });

const jobRows = () => db.select().from(jobs).orderBy(jobs.id);
const secondsUntil = async (table: 'games' | 'challenges', column: string, id: number) => {
  const [row] = await db.execute(
    sql`select extract(epoch from (${sql.raw(column)} - now())) as seconds from ${sql.raw(table)} where id = ${id}`,
  );
  return Number(row?.seconds);
};

describe('createChallenge', () => {
  it('creates a direct challenge with a 24 h expiry and enqueues the card and the DM', async () => {
    const { group, alice, bob } = await setup();
    const challenge = await direct(group.id, alice.id, bob.id);
    expect(challenge).toMatchObject({ status: 'pending', challengerId: alice.id, opponentId: bob.id });
    expect(challenge.publicId).toHaveLength(10);
    expect(await secondsUntil('challenges', 'expires_at', challenge.id)).toBeGreaterThan(86_000);
    const all = await jobRows();
    expect(all.map((job) => [job.kind, job.dedupKey])).toEqual([
      ['send_challenge_card', `card:send:${challenge.publicId}`],
      ['send_dm', `dm:${bob.id}:ch:${challenge.publicId}`],
    ]);
    expect(all[1]?.payload).toEqual({ userId: bob.id, template: 'challenge', challengeId: challenge.id });
  });

  it('refuses a self-challenge', async () => {
    const { group, alice } = await setup();
    await expect(direct(group.id, alice.id, alice.id)).rejects.toMatchObject({
      code: 'validation',
      details: { reason: 'self' },
    });
  });

  it('enforces three pending challenges per user per group', async () => {
    const { group, alice, bob, carol } = await setup();
    const dave = await insertUser(db);
    const erin = await insertUser(db);
    await direct(group.id, alice.id, bob.id);
    await direct(group.id, alice.id, carol.id);
    await direct(group.id, alice.id, dave.id);
    await expect(direct(group.id, alice.id, erin.id)).rejects.toMatchObject({
      code: 'limit_exceeded',
      details: { reason: 'pending_limit', count: 3 },
    });
  });

  it('enforces two concurrent games per pair', async () => {
    const { group, alice, bob } = await setup();
    await insertGame(db, group.id, alice.id, bob.id);
    await insertGame(db, group.id, bob.id, alice.id);
    await expect(direct(group.id, alice.id, bob.id)).rejects.toMatchObject({
      code: 'limit_exceeded',
      details: { reason: 'pair_limit', name: 'Bob', count: 2 },
    });
  });

  it('enforces the group’s active games limit for either player', async () => {
    const { group, alice, bob, carol } = await setup();
    await updateGroupSettings(db, group.id, { maxActiveGamesPerUser: 1 });
    await insertGame(db, group.id, bob.id, carol.id);
    await expect(direct(group.id, alice.id, bob.id)).rejects.toMatchObject({
      code: 'limit_exceeded',
      details: { reason: 'active_limit', name: 'Bob', count: 1 },
    });
  });

  it('refuses a blocked challenger', async () => {
    const { group, alice, bob } = await setup();
    await blockUser(db, group.id, alice.id, bob.id);
    await expect(direct(group.id, alice.id, bob.id)).rejects.toMatchObject({
      code: 'forbidden',
      details: { reason: 'blocked' },
    });
  });

  it('allows open challenges only when the group allows them', async () => {
    const { group, alice } = await setup();
    const open = await direct(group.id, alice.id, null);
    expect(open.opponentId).toBeNull();
    expect((await jobRows()).map((job) => job.kind)).toEqual(['send_challenge_card']);
    await updateGroupSettings(db, group.id, { allowOpenChallenges: false });
    await expect(direct(group.id, alice.id, null)).rejects.toMatchObject({
      code: 'forbidden',
      details: { reason: 'open_disabled' },
    });
  });
});

describe('acceptChallenge', () => {
  it('creates the game with the chosen colours, White’s clock and the card and DM jobs', async () => {
    const { group, alice, bob } = await setup();
    await db.update(users).set({ dmAllowed: true }).where(eq(users.id, bob.id));
    const challenge = await createChallenge(deps, {
      groupId: group.id,
      challengerId: alice.id,
      opponentId: bob.id,
      timePerMove: 86400,
      colour: 'black',
      rated: true,
      threadId: 55,
    });
    await db.update(challenges).set({ messageId: 777 }).where(eq(challenges.id, challenge.id));
    await db.delete(jobs);

    const { game, challenge: accepted } = await acceptChallenge(deps, { challengeId: challenge.id, userId: bob.id });

    expect(game).toMatchObject({
      whiteId: bob.id,
      blackId: alice.id,
      status: 'active',
      plyCount: 0,
      rated: true,
      timePerMove: 86400,
      cardMessageId: 777,
      cardThreadId: 55,
    });
    expect(await secondsUntil('games', 'deadline_at', game.id)).toBeGreaterThan(86_390);
    expect(await secondsUntil('games', 'reminder_at', game.id)).toBeGreaterThan(77_750);
    expect(accepted).toMatchObject({ status: 'accepted', gameId: game.id });
    expect((await jobRows()).map((job) => [job.kind, job.dedupKey])).toEqual([
      ['edit_card', `card:g:${game.publicId}`],
      ['send_dm', `dm:${bob.id}:g:${game.publicId}:turn:0`],
    ]);
  });

  it('gives a random colour to both players and no reminder without DMs', async () => {
    const { group, alice, bob } = await setup();
    const challenge = await direct(group.id, alice.id, bob.id);
    const { game } = await acceptChallenge(deps, { challengeId: challenge.id, userId: bob.id });
    expect(new Set([game.whiteId, game.blackId])).toEqual(new Set([alice.id, bob.id]));
    expect(game.reminderAt).toBeNull();
  });

  it('lets only the challenged player accept a direct challenge', async () => {
    const { group, alice, bob, carol } = await setup();
    const challenge = await direct(group.id, alice.id, bob.id);
    await expect(acceptChallenge(deps, { challengeId: challenge.id, userId: carol.id })).rejects.toMatchObject({
      code: 'forbidden',
      details: { reason: 'not_your_challenge', opponentId: bob.id },
    });
  });

  it('refuses the challenger of an open challenge', async () => {
    const { group, alice } = await setup();
    const challenge = await direct(group.id, alice.id, null);
    await expect(acceptChallenge(deps, { challengeId: challenge.id, userId: alice.id })).rejects.toMatchObject({
      code: 'forbidden',
      details: { reason: 'own_challenge' },
    });
  });

  it('lets exactly one of two concurrent acceptances win an open challenge', async () => {
    const { group, alice, bob, carol } = await setup();
    const challenge = await direct(group.id, alice.id, null);
    const results = await Promise.allSettled([
      acceptChallenge(deps, { challengeId: challenge.id, userId: bob.id }),
      acceptChallenge(deps, { challengeId: challenge.id, userId: carol.id }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'stale_state',
      details: { reason: 'accepted_first' },
    });
    expect(await db.select().from(games)).toHaveLength(1);
  });

  it('refuses a challenge past its expiry even before the scanner ran', async () => {
    const { group, alice, bob } = await setup();
    const challenge = await insertChallenge(db, group.id, alice.id, bob.id, { expiresInSeconds: -5 });
    await expect(acceptChallenge(deps, { challengeId: challenge.id, userId: bob.id })).rejects.toMatchObject({
      code: 'expired',
    });
  });
});

describe('decline, cancel, expire', () => {
  it('lets the opponent decline and the challenger cancel, each editing the card', async () => {
    const { group, alice, bob } = await setup();
    const first = await direct(group.id, alice.id, bob.id);
    await expect(declineChallenge(deps, { challengeId: first.id, userId: alice.id })).rejects.toMatchObject({ code: 'forbidden' });
    expect((await declineChallenge(deps, { challengeId: first.id, userId: bob.id })).status).toBe('declined');
    const second = await direct(group.id, alice.id, bob.id);
    await expect(cancelChallenge(deps, { challengeId: second.id, userId: bob.id })).rejects.toMatchObject({ code: 'forbidden' });
    expect((await cancelChallenge(deps, { challengeId: second.id, userId: alice.id })).status).toBe('cancelled');
    const edits = (await jobRows()).filter((job) => job.kind === 'edit_card').map((job) => job.dedupKey);
    expect(edits).toEqual([`card:ch:${first.publicId}`, `card:ch:${second.publicId}`]);
  });

  it('refuses to act on a challenge that is no longer pending', async () => {
    const { group, alice, bob } = await setup();
    const challenge = await direct(group.id, alice.id, bob.id);
    await declineChallenge(deps, { challengeId: challenge.id, userId: bob.id });
    await expect(acceptChallenge(deps, { challengeId: challenge.id, userId: bob.id })).rejects.toMatchObject({
      code: 'expired',
      details: { reason: 'challenge_gone' },
    });
  });

  it('expires only the pending challenges that are past due', async () => {
    const { group, alice, bob, carol } = await setup();
    const overdue = await insertChallenge(db, group.id, alice.id, bob.id, { expiresInSeconds: -1 });
    const fresh = await insertChallenge(db, group.id, alice.id, carol.id, { expiresInSeconds: 3600 });
    expect(await expireChallenges(deps)).toBe(1);
    const rows = await db.select().from(challenges).orderBy(challenges.id);
    expect(rows.map((row) => [row.id, row.status])).toEqual([
      [overdue.id, 'expired'],
      [fresh.id, 'pending'],
    ]);
    expect((await jobRows()).map((job) => job.dedupKey)).toEqual([`card:ch:${overdue.publicId}`]);
  });
});

describe('createRematch', () => {
  it('reverses the colours and copies the terms of a finished game', async () => {
    const { group, alice, bob } = await setup();
    const game = await insertGame(db, group.id, alice.id, bob.id, {
      timePerMove: 3600,
      rated: false,
      status: 'finished',
      result: '1-0',
      endReason: 'resignation',
      finishedAt: new Date(),
      cardThreadId: 9,
    });
    const rematch = await createRematch(deps, { gameId: game.id, userId: bob.id });
    expect(rematch).toMatchObject({
      challengerId: bob.id,
      opponentId: alice.id,
      challengerColour: 'white',
      timePerMove: 3600,
      rated: false,
      threadId: 9,
      status: 'pending',
    });
  });

  it('refuses a rematch from a spectator or on a running game', async () => {
    const { group, alice, bob, carol } = await setup();
    const running = await insertGame(db, group.id, alice.id, bob.id);
    await expect(createRematch(deps, { gameId: running.id, userId: alice.id })).rejects.toMatchObject({ code: 'stale_state' });
    const done = await insertGame(db, group.id, alice.id, bob.id, { status: 'finished', result: '0-1', endReason: 'checkmate', finishedAt: new Date() });
    await expect(createRematch(deps, { gameId: done.id, userId: carol.id })).rejects.toMatchObject({ code: 'forbidden' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run --project server apps/server/test/integration/challenges.test.ts`
Expected: FAIL — cannot load `../../src/domain/challenges`.

- [ ] **Step 3: Write the implementation**

Append to `apps/server/src/domain/groups.ts`:

```ts
export async function getGroupById(tx: DbOrTx, id: number): Promise<GroupRow | null> {
  const [row] = await tx.select().from(groups).where(eq(groups.id, id)).limit(1);
  return row ?? null;
}

export async function requireGroup(tx: DbOrTx, id: number): Promise<GroupRow> {
  const row = await getGroupById(tx, id);
  if (!row) throw new DomainError('not_found', 'group not found', { groupId: id });
  return row;
}
```

`apps/server/src/domain/limits.ts`:

```ts
import { REMINDER_FRACTION, REMINDER_MIN_TIME_PER_MOVE, type TimePerMove } from '@group-chess/shared';
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
```

`apps/server/src/domain/challenges.ts`:

```ts
import { randomInt } from 'node:crypto';
import { INITIAL_FEN, opposite, type ColourChoice, type TimePerMove } from '@group-chess/shared';
import { and, asc, eq, lte, sql } from 'drizzle-orm';
import { dbNow, type DbOrTx } from '../db/client';
import { generatePublicId } from '../db/ids';
import { challenges, games, type ChallengeRow, type GameRow, type UserRow } from '../db/schema';
import { enqueue } from '../jobs/queue';
import type { Deps } from './deps';
import { DomainError } from './errors';
import { requireGroup, settingsOf } from './groups';
import {
  MAX_GAMES_PER_PAIR,
  MAX_PENDING_CHALLENGES,
  countActiveGames,
  countActiveGamesBetween,
  countPendingChallenges,
  deadlineExpression,
  reminderExpression,
} from './limits';
import { isBlocked } from './members';
import { requireUser } from './users';

export type CreateChallengeInput = {
  groupId: number;
  challengerId: number;
  /** null for an open challenge. */
  opponentId: number | null;
  timePerMove: TimePerMove;
  colour: ColourChoice;
  rated: boolean;
  /** Forum topic the card belongs to; null for the General topic or a basic group. */
  threadId: number | null;
};

function randomColour(): 'white' | 'black' {
  return randomInt(2) === 0 ? 'white' : 'black';
}

async function assertCanPlay(tx: DbOrTx, groupId: number, user: UserRow, maxActive: number): Promise<void> {
  if (await isBlocked(tx, groupId, user.id)) {
    throw new DomainError('forbidden', 'blocked in this group', { reason: 'blocked', userId: user.id });
  }
  const active = await countActiveGames(tx, groupId, user.id);
  if (active >= maxActive) {
    throw new DomainError('limit_exceeded', 'active games limit reached', {
      reason: 'active_limit',
      userId: user.id,
      name: user.firstName,
      count: active,
    });
  }
}

async function assertPairLimit(tx: DbOrTx, groupId: number, a: UserRow, b: UserRow): Promise<void> {
  const pair = await countActiveGamesBetween(tx, groupId, a.id, b.id);
  if (pair >= MAX_GAMES_PER_PAIR) {
    throw new DomainError('limit_exceeded', 'too many games with this opponent', {
      reason: 'pair_limit',
      name: b.firstName,
      count: pair,
    });
  }
}

export async function getChallengeById(tx: DbOrTx, id: number): Promise<ChallengeRow | null> {
  const [row] = await tx.select().from(challenges).where(eq(challenges.id, id)).limit(1);
  return row ?? null;
}

export async function getChallengeByPublicId(tx: DbOrTx, publicId: string): Promise<ChallengeRow | null> {
  const [row] = await tx.select().from(challenges).where(eq(challenges.publicId, publicId)).limit(1);
  return row ?? null;
}

export async function setChallengeMessage(tx: DbOrTx, challengeId: number, messageId: number): Promise<void> {
  await tx.update(challenges).set({ messageId }).where(eq(challenges.id, challengeId));
}

function editCard(tx: DbOrTx, challenge: Pick<ChallengeRow, 'id' | 'publicId'>): Promise<void> {
  return enqueue(tx, {
    kind: 'edit_card',
    payload: { challengeId: challenge.id },
    dedupKey: `card:ch:${challenge.publicId}`,
  });
}

/** Spec §7.1/§7.8: limits checked, the card send and the opponent's DM enqueued in the same transaction. */
export async function createChallenge(deps: Deps, input: CreateChallengeInput): Promise<ChallengeRow> {
  return deps.db.transaction(async (tx) => {
    const group = await requireGroup(tx, input.groupId);
    const settings = settingsOf(group);
    if (input.opponentId !== null && input.opponentId === input.challengerId) {
      throw new DomainError('validation', 'cannot challenge yourself', { reason: 'self' });
    }
    if (input.opponentId === null && !settings.allowOpenChallenges) {
      throw new DomainError('forbidden', 'open challenges are off in this group', { reason: 'open_disabled' });
    }
    const challenger = await requireUser(tx, input.challengerId);
    await assertCanPlay(tx, group.id, challenger, settings.maxActiveGamesPerUser);
    const pending = await countPendingChallenges(tx, group.id, challenger.id);
    if (pending >= MAX_PENDING_CHALLENGES) {
      throw new DomainError('limit_exceeded', 'too many pending challenges', {
        reason: 'pending_limit',
        count: pending,
      });
    }
    let opponent: UserRow | null = null;
    if (input.opponentId !== null) {
      opponent = await requireUser(tx, input.opponentId);
      if (opponent.deletedAt) {
        throw new DomainError('not_found', 'opponent no longer plays here', { reason: 'opponent_gone' });
      }
      await assertCanPlay(tx, group.id, opponent, settings.maxActiveGamesPerUser);
      await assertPairLimit(tx, group.id, challenger, opponent);
    }
    const [challenge] = await tx
      .insert(challenges)
      .values({
        publicId: generatePublicId(),
        groupId: group.id,
        challengerId: challenger.id,
        opponentId: opponent?.id ?? null,
        timePerMove: input.timePerMove,
        challengerColour: input.colour,
        rated: input.rated,
        threadId: input.threadId,
        expiresAt: sql`now() + interval '24 hours'`,
      })
      .returning();
    if (!challenge) throw new Error('challenge insert returned no row');
    await enqueue(tx, {
      kind: 'send_challenge_card',
      payload: { challengeId: challenge.id },
      dedupKey: `card:send:${challenge.publicId}`,
    });
    if (opponent) {
      await enqueue(tx, {
        kind: 'send_dm',
        payload: { userId: opponent.id, template: 'challenge', challengeId: challenge.id },
        dedupKey: `dm:${opponent.id}:ch:${challenge.publicId}`,
      });
    }
    return challenge;
  });
}

async function lockPendingChallenge(tx: DbOrTx, challengeId: number): Promise<ChallengeRow> {
  const [challenge] = await tx
    .select()
    .from(challenges)
    .where(eq(challenges.id, challengeId))
    .limit(1)
    .for('update');
  if (!challenge) throw new DomainError('not_found', 'challenge not found');
  if (challenge.status === 'accepted') {
    throw new DomainError('stale_state', 'someone accepted first', { reason: 'accepted_first' });
  }
  if (challenge.status !== 'pending') {
    throw new DomainError('expired', 'this challenge is no longer open', { reason: 'challenge_gone' });
  }
  const now = await dbNow(tx);
  if (challenge.expiresAt.getTime() <= now.getTime()) {
    throw new DomainError('expired', 'this challenge has expired', { reason: 'challenge_gone' });
  }
  return challenge;
}

/** Spec §7.1 accept: the row lock makes the first committed acceptance of an open challenge win. */
export async function acceptChallenge(
  deps: Deps,
  input: { challengeId: number; userId: number },
): Promise<{ challenge: ChallengeRow; game: GameRow }> {
  const result = await deps.db.transaction(async (tx) => {
    const challenge = await lockPendingChallenge(tx, input.challengeId);
    if (challenge.opponentId !== null && challenge.opponentId !== input.userId) {
      throw new DomainError('forbidden', 'only the challenged player can accept', {
        reason: 'not_your_challenge',
        opponentId: challenge.opponentId,
      });
    }
    if (challenge.opponentId === null && challenge.challengerId === input.userId) {
      throw new DomainError('forbidden', 'cannot accept your own challenge', { reason: 'own_challenge' });
    }
    const group = await requireGroup(tx, challenge.groupId);
    const settings = settingsOf(group);
    const challenger = await requireUser(tx, challenge.challengerId);
    const accepter = await requireUser(tx, input.userId);
    await assertCanPlay(tx, group.id, accepter, settings.maxActiveGamesPerUser);
    await assertCanPlay(tx, group.id, challenger, settings.maxActiveGamesPerUser);
    await assertPairLimit(tx, group.id, accepter, challenger);

    const challengerColour =
      challenge.challengerColour === 'random' ? randomColour() : challenge.challengerColour;
    const white = challengerColour === 'white' ? challenger : accepter;
    const black = challengerColour === 'white' ? accepter : challenger;
    const timePerMove = challenge.timePerMove as TimePerMove;
    const [game] = await tx
      .insert(games)
      .values({
        publicId: generatePublicId(),
        groupId: group.id,
        whiteId: white.id,
        blackId: black.id,
        timePerMove,
        rated: challenge.rated,
        fen: INITIAL_FEN,
        deadlineAt: deadlineExpression(timePerMove),
        reminderAt: reminderExpression(timePerMove, white.dmAllowed),
        cardMessageId: challenge.messageId,
        cardThreadId: challenge.threadId,
      })
      .returning();
    if (!game) throw new Error('game insert returned no row');
    const [accepted] = await tx
      .update(challenges)
      .set({ status: 'accepted', opponentId: accepter.id, gameId: game.id, resolvedAt: sql`now()` })
      .where(eq(challenges.id, challenge.id))
      .returning();
    await enqueue(tx, { kind: 'edit_card', payload: { gameId: game.id }, dedupKey: `card:g:${game.publicId}` });
    await enqueue(tx, {
      kind: 'send_dm',
      payload: { userId: white.id, template: 'turn', gameId: game.id },
      dedupKey: `dm:${white.id}:g:${game.publicId}:turn:0`,
    });
    return { challenge: accepted ?? challenge, game };
  });
  deps.bus.publish(result.game.publicId);
  return result;
}

export async function declineChallenge(
  deps: Deps,
  input: { challengeId: number; userId: number },
): Promise<ChallengeRow> {
  return deps.db.transaction(async (tx) => {
    const challenge = await lockPendingChallenge(tx, input.challengeId);
    if (challenge.opponentId === null || challenge.opponentId !== input.userId) {
      throw new DomainError('forbidden', 'only the challenged player can decline', {
        reason: 'not_your_challenge',
        opponentId: challenge.opponentId,
      });
    }
    const [declined] = await tx
      .update(challenges)
      .set({ status: 'declined', resolvedAt: sql`now()` })
      .where(eq(challenges.id, challenge.id))
      .returning();
    await editCard(tx, challenge);
    return declined ?? challenge;
  });
}

export async function cancelChallenge(
  deps: Deps,
  input: { challengeId: number; userId: number },
): Promise<ChallengeRow> {
  return deps.db.transaction(async (tx) => {
    const challenge = await lockPendingChallenge(tx, input.challengeId);
    if (challenge.challengerId !== input.userId) {
      throw new DomainError('forbidden', 'only the challenger can withdraw', { reason: 'not_your_challenge' });
    }
    const [cancelled] = await tx
      .update(challenges)
      .set({ status: 'cancelled', resolvedAt: sql`now()` })
      .where(eq(challenges.id, challenge.id))
      .returning();
    await editCard(tx, challenge);
    return cancelled ?? challenge;
  });
}

/** Scanner (spec §7.3): pending challenges past `expires_at`, at most `limit` per pass. */
export async function expireChallenges(deps: Deps, limit = 100): Promise<number> {
  return deps.db.transaction(async (tx) => {
    const due = await tx
      .select({ id: challenges.id, publicId: challenges.publicId })
      .from(challenges)
      .where(and(eq(challenges.status, 'pending'), lte(challenges.expiresAt, sql`now()`)))
      .orderBy(asc(challenges.expiresAt))
      .limit(limit)
      .for('update', { skipLocked: true });
    for (const challenge of due) {
      await tx
        .update(challenges)
        .set({ status: 'expired', resolvedAt: sql`now()` })
        .where(and(eq(challenges.id, challenge.id), eq(challenges.status, 'pending')));
      await editCard(tx, challenge);
    }
    return due.length;
  });
}

/** PRD §7.2: a reversed-colour challenge with the same terms, as a new card. */
export async function createRematch(deps: Deps, input: { gameId: number; userId: number }): Promise<ChallengeRow> {
  const [game] = await deps.db.select().from(games).where(eq(games.id, input.gameId)).limit(1);
  if (!game) throw new DomainError('not_found', 'game not found');
  if (game.status !== 'finished') throw new DomainError('stale_state', 'the game is still running');
  const colour = game.whiteId === input.userId ? 'white' : game.blackId === input.userId ? 'black' : null;
  if (!colour) throw new DomainError('forbidden', 'only the players can ask for a rematch');
  return createChallenge(deps, {
    groupId: game.groupId,
    challengerId: input.userId,
    opponentId: colour === 'white' ? game.blackId : game.whiteId,
    timePerMove: game.timePerMove as TimePerMove,
    colour: opposite(colour),
    rated: game.rated,
    threadId: game.cardThreadId,
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run --project server apps/server/test/integration/challenges.test.ts`
Expected: PASS — 18 tests.

- [ ] **Step 5: Run the whole suite and the static checks**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm format:check`
Expected: all exit 0.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(server): add the challenge state machine with limits, races and rematches"
```

---

### Task 7: Games — the move transaction, game ends, timeout, resign, abort, void, DTO

**Files:**
- Create: `apps/server/src/domain/gameDto.ts`, `apps/server/src/domain/games.ts`
- Test: `apps/server/test/integration/games.test.ts`

**Interfaces:**
- Consumes: Tasks 2–6 (`dbNow`, schema, `enqueue`, `DomainError`, `Deps`, `requireUser`, `getPlayerRating`, `applyGameResultToRatings`, `toPlayerRef`, `deadlineExpression`, `reminderExpression`); shared `applyMove`, `computeClaims`, `positionKey`, `sideToMove`, `timeoutOutcome`, `analysisUrl`, `isProvisional`, `INITIAL_FEN`, `type GameDto`, `type EndReason`, `type GameResult`, `type Colour`, `type TimePerMove`.
- Produces: gameDto — `colourOf(game, userId | null): Colour | null`, `positionKeys(moves: MoveRow[]): string[]`, `buildGameDto(input: { game; moves; group: { publicId; title }; white: UserRow; black: UserRow; whiteRating; blackRating; viewerUserId: number | null; now: Date }): GameDto`; games — `type EndInput = { result: GameResult; endReason: EndReason }`, `requireGameByPublicId(tx, publicId, { forUpdate? })`, `requireGameById(tx, id, { forUpdate? })`, `listMoves(tx, gameId): Promise<MoveRow[]>`, `loadGameDto(tx, game, viewerUserId): Promise<GameDto>`, `getGameDto(deps, { gameId: string; viewerUserId: number | null }): Promise<GameDto>`, `finishGame(tx, game, end, now): Promise<GameRow>`, `timeoutEnd(game): EndInput`, `applyTimeout(tx, game, now): Promise<GameRow>`, `playMove(deps, { gameId: string; userId; uci; expectedPly; clientMoveId }): Promise<GameDto>`, `resign(deps, { gameId, userId }): Promise<GameDto>`, `abortGame(deps, { gameId, userId }): Promise<GameDto>`, `voidGame(deps, { gameId: string; adminUserId }): Promise<GameDto>`.

- [ ] **Step 1: Write the failing test**

`apps/server/test/integration/games.test.ts`:

```ts
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { adminActions, games, jobs, moves, ratings, users } from '../../src/db/schema';
import {
  abortGame,
  getGameDto,
  playMove,
  resign,
  voidGame,
} from '../../src/domain/games';
import { touchMember } from '../../src/domain/members';
import { openTestDb, testDeps, truncateAll } from '../helpers/db';
import { insertGame, insertGroup, insertMove, insertUser, type GameOverrides } from '../helpers/fixtures';

const { db, close } = openTestDb();
const deps = testDeps(db);

beforeEach(() => truncateAll(db));
afterAll(() => close());

const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
const AFTER_E4_E5 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2';
/** 1.e4 e5 2.Qh5 Nc6 3.Bc4 Nf6, White to play Qxf7#. */
const BEFORE_SCHOLARS_MATE = 'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4';

async function setup(overrides: GameOverrides = {}) {
  const group = await insertGroup(db);
  const alice = await insertUser(db, { firstName: 'Alice' });
  const bob = await insertUser(db, { firstName: 'Bob' });
  const carol = await insertUser(db, { firstName: 'Carol' });
  for (const user of [alice, bob, carol]) await touchMember(db, group.id, user.id);
  const game = await insertGame(db, group.id, alice.id, bob.id, overrides);
  return { group, alice, bob, carol, game };
}

let moveCounter = 0;
const move = (gameId: string, userId: number, uci: string, expectedPly: number, clientMoveId?: string) =>
  playMove(deps, { gameId, userId, uci, expectedPly, clientMoveId: clientMoveId ?? `client-${(moveCounter += 1)}` });

const jobList = () => db.select().from(jobs).orderBy(jobs.id);
const secondsUntil = async (column: 'deadline_at' | 'reminder_at', id: number) => {
  const [row] = await db.execute(sql`select extract(epoch from (${sql.raw(column)} - now())) as seconds from games where id = ${id}`);
  return row?.seconds === null ? null : Number(row?.seconds);
};

describe('playMove', () => {
  it('plays a legal move, resets the opponent’s clock and enqueues the card edit and turn DM', async () => {
    const { game, alice, bob } = await setup();
    const dto = await move(game.publicId, alice.id, 'e2e4', 0);
    expect(dto).toMatchObject({ fen: AFTER_E4, plyCount: 1, version: 1, viewerRole: 'white', status: 'active' });
    expect(dto.moves).toEqual([expect.objectContaining({ ply: 1, uci: 'e2e4', san: 'e4', fenAfter: AFTER_E4 })]);
    expect(await secondsUntil('deadline_at', game.id)).toBeGreaterThan(86_390);
    expect((await jobList()).map((job) => [job.kind, job.dedupKey])).toEqual([
      ['edit_card', `card:g:${game.publicId}`],
      ['send_dm', `dm:${bob.id}:g:${game.publicId}:turn:1`],
    ]);
  });

  it('sets a reminder only when the opponent allows DMs and the control is eight hours or more', async () => {
    const { game, alice, bob } = await setup();
    await db.update(users).set({ dmAllowed: true }).where(eq(users.id, bob.id));
    await move(game.publicId, alice.id, 'e2e4', 0);
    expect(await secondsUntil('reminder_at', game.id)).toBeGreaterThan(77_750);
    const short = await setup({ timePerMove: 3600 });
    await db.update(users).set({ dmAllowed: true }).where(eq(users.id, short.bob.id));
    await move(short.game.publicId, short.alice.id, 'e2e4', 0);
    expect(await secondsUntil('reminder_at', short.game.id)).toBeNull();
  });

  it('is idempotent for a retried client move id', async () => {
    const { game, alice } = await setup();
    await move(game.publicId, alice.id, 'e2e4', 0, 'retry-me');
    const again = await move(game.publicId, alice.id, 'e2e4', 0, 'retry-me');
    expect(again.plyCount).toBe(1);
    expect(await db.select().from(moves)).toHaveLength(1);
  });

  it('rejects a stale expected ply', async () => {
    const { game, alice, bob } = await setup();
    await move(game.publicId, alice.id, 'e2e4', 0);
    await expect(move(game.publicId, bob.id, 'e7e5', 0)).rejects.toMatchObject({ code: 'stale_state' });
  });

  it('rejects a move out of turn and from a spectator', async () => {
    const { game, bob, carol } = await setup();
    await expect(move(game.publicId, bob.id, 'e7e5', 0)).rejects.toMatchObject({ code: 'not_your_turn' });
    await expect(move(game.publicId, carol.id, 'e2e4', 0)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('rejects an illegal move and leaves the game untouched', async () => {
    const { game, alice } = await setup();
    await expect(move(game.publicId, alice.id, 'e2e5', 0)).rejects.toMatchObject({ code: 'illegal_move' });
    const [row] = await db.select().from(games).where(eq(games.id, game.id));
    expect(row?.version).toBe(0);
    expect(await jobList()).toHaveLength(0);
  });

  it('applies the timeout instead of a move that arrives after the deadline', async () => {
    const { game, alice, bob } = await setup({ deadlineInSeconds: -1 });
    const dto = await move(game.publicId, alice.id, 'e2e4', 0);
    expect(dto).toMatchObject({ status: 'finished', result: '*', endReason: 'timeout_abort', plyCount: 0 });
    expect(dto.moves).toEqual([]);
    const kinds = (await jobList()).map((job) => [job.kind, job.dedupKey]);
    expect(kinds).toEqual([
      ['edit_card', `card:g:${game.publicId}`],
      ['send_dm', `dm:${alice.id}:g:${game.publicId}:end`],
      ['send_dm', `dm:${bob.id}:g:${game.publicId}:end`],
    ]);
  });

  it('scores a late move after real play as a rated loss on time', async () => {
    const { game, alice } = await setup({ deadlineInSeconds: -1, fen: AFTER_E4_E5, plyCount: 2 });
    await insertMove(db, game.id, 1, 'e2e4', 'e4', AFTER_E4);
    await insertMove(db, game.id, 2, 'e7e5', 'e5', AFTER_E4_E5);
    const dto = await move(game.publicId, alice.id, 'g1f3', 2);
    expect(dto).toMatchObject({ status: 'finished', result: '0-1', endReason: 'timeout', plyCount: 2 });
    expect(await db.select().from(ratings)).toHaveLength(2);
    expect((await jobList()).map((job) => job.kind)).toContain('lichess_import');
  });

  it('finishes the game on checkmate with ratings, snapshots and a Lichess import', async () => {
    const { game, alice } = await setup({ fen: BEFORE_SCHOLARS_MATE, plyCount: 6 });
    const dto = await move(game.publicId, alice.id, 'h5f7', 6);
    expect(dto).toMatchObject({ status: 'finished', result: '1-0', endReason: 'checkmate', plyCount: 7, version: 2 });
    expect(dto.white.ratingAfter).toBeGreaterThan(1500);
    expect(dto.black.ratingAfter).toBeLessThan(1500);
    expect(dto.white.rating).toBe(1500);
    expect(dto.analysisUrl).toContain('Qxf7%23');
    expect(dto.deadlineAt).toBeNull();
    const dedups = (await jobList()).map((job) => job.dedupKey);
    expect(dedups).toEqual(
      expect.arrayContaining([`card:g:${game.publicId}`, `lichess:${game.publicId}`, `dm:${alice.id}:g:${game.publicId}:end`]),
    );
  });

  it('clears the opponent’s draw offer when the mover is not the offerer, and keeps the mover’s own', async () => {
    const { game, alice } = await setup({ drawOfferBy: 'black', drawOfferPly: 0 });
    expect((await move(game.publicId, alice.id, 'e2e4', 0)).drawOffer).toBeNull();
    const own = await setup({ drawOfferBy: 'white', drawOfferPly: 0 });
    expect((await move(own.game.publicId, own.alice.id, 'e2e4', 0)).drawOffer).toEqual({ by: 'white', atPly: 0 });
  });

  it('serialises two concurrent moves for the same ply', async () => {
    const { game, alice } = await setup();
    const results = await Promise.allSettled([
      move(game.publicId, alice.id, 'e2e4', 0, 'first-tap'),
      move(game.publicId, alice.id, 'd2d4', 0, 'second-tap'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'stale_state' });
    expect(await db.select().from(moves)).toHaveLength(1);
  });
});

describe('resign, abort, void', () => {
  it('resigns as a rated loss', async () => {
    const { game, bob } = await setup({ fen: AFTER_E4_E5, plyCount: 2 });
    const dto = await resign(deps, { gameId: game.publicId, userId: bob.id });
    expect(dto).toMatchObject({ status: 'finished', result: '1-0', endReason: 'resignation' });
    expect(await db.select().from(ratings)).toHaveLength(2);
  });

  it('allows an abort only before both players have moved', async () => {
    const { game, alice, bob } = await setup();
    await move(game.publicId, alice.id, 'e2e4', 0);
    const dto = await abortGame(deps, { gameId: game.publicId, userId: bob.id });
    expect(dto).toMatchObject({ status: 'finished', result: '*', endReason: 'abort' });
    expect(await db.select().from(ratings)).toHaveLength(0);
    const later = await setup({ fen: AFTER_E4_E5, plyCount: 2 });
    await expect(abortGame(deps, { gameId: later.game.publicId, userId: later.alice.id })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('voids a running game without a result and a finished one with a rebuild', async () => {
    const running = await setup({ fen: AFTER_E4_E5, plyCount: 2 });
    const voided = await voidGame(deps, { gameId: running.game.publicId, adminUserId: running.carol.id });
    expect(voided).toMatchObject({ status: 'finished', result: '*', endReason: 'voided', voided: true });

    const done = await setup({ status: 'finished', result: '1-0', endReason: 'checkmate', finishedAt: new Date(), plyCount: 7 });
    await db.delete(jobs);
    const dto = await voidGame(deps, { gameId: done.game.publicId, adminUserId: done.carol.id });
    expect(dto).toMatchObject({ result: '1-0', endReason: 'checkmate', voided: true });
    expect((await jobList()).map((job) => [job.kind, job.dedupKey])).toEqual([
      ['rebuild_ratings', `ratings:${done.group.publicId}`],
      ['edit_card', `card:g:${done.game.publicId}`],
    ]);
    const audit = await db.select().from(adminActions);
    expect(audit.map((row) => [row.action, row.targetGameId, row.adminUserId])).toEqual([
      ['void', running.game.id, running.carol.id],
      ['void', done.game.id, done.carol.id],
    ]);
  });
});

describe('getGameDto', () => {
  it('describes a running game for a spectator without Lichess links', async () => {
    const { game, carol } = await setup({ fen: AFTER_E4, plyCount: 1 });
    await insertMove(db, game.id, 1, 'e2e4', 'e4', AFTER_E4);
    const dto = await getGameDto(deps, { gameId: game.publicId, viewerUserId: carol.id });
    expect(dto).toMatchObject({
      viewerRole: 'spectator',
      claims: { threefold: false, fiftyMove: false },
      drawOffer: null,
      white: { name: 'Alice', rating: 1500, provisional: true, ratingAfter: null },
    });
    expect(dto.lichessUrl).toBeUndefined();
    expect(dto.analysisUrl).toBeUndefined();
    expect(Math.abs(Date.parse(dto.serverTime) - Date.now())).toBeLessThan(5_000);
  });

  it('reports the pre-game snapshot as the rating of a finished rated game', async () => {
    const { game, alice } = await setup({
      status: 'finished',
      result: '1-0',
      endReason: 'resignation',
      finishedAt: new Date(),
      whiteRatingBefore: 1500,
      whiteRatingAfter: 1534.4,
      whiteRdBefore: 350,
      whiteRdAfter: 290,
      blackRatingBefore: 1500,
      blackRatingAfter: 1465.6,
      blackRdBefore: 350,
      blackRdAfter: 290,
    });
    await db.insert(ratings).values({ groupId: game.groupId, userId: alice.id, rating: 1610, rd: 80, volatility: 0.06, gamesPlayed: 9 });
    const dto = await getGameDto(deps, { gameId: game.publicId, viewerUserId: null });
    expect(dto.white).toMatchObject({ rating: 1500, provisional: true, ratingAfter: 1534, provisionalAfter: true });
    expect(dto.black).toMatchObject({ rating: 1500, ratingAfter: 1466 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run --project server apps/server/test/integration/games.test.ts`
Expected: FAIL — cannot load `../../src/domain/games`.

- [ ] **Step 3: Write the implementation**

`apps/server/src/domain/gameDto.ts`:

```ts
import {
  INITIAL_FEN,
  analysisUrl,
  computeClaims,
  isProvisional,
  positionKey,
  type Colour,
  type GameDto,
  type GamePlayer,
  type TimePerMove,
} from '@group-chess/shared';
import type { GameRow, GroupRow, MoveRow, RatingRow, UserRow } from '../db/schema';
import { toPlayerRef } from './players';

export function colourOf(game: Pick<GameRow, 'whiteId' | 'blackId'>, userId: number | null): Colour | null {
  if (userId === null) return null;
  if (game.whiteId === userId) return 'white';
  if (game.blackId === userId) return 'black';
  return null;
}

/** Position keys of every position so far, the initial one first (arbiter contract). */
export function positionKeys(moves: readonly MoveRow[]): string[] {
  return [positionKey(INITIAL_FEN), ...moves.map((move) => positionKey(move.fenAfter))];
}

export type GameDtoInput = {
  game: GameRow;
  moves: MoveRow[];
  group: Pick<GroupRow, 'publicId' | 'title'>;
  white: UserRow;
  black: UserRow;
  whiteRating: Pick<RatingRow, 'rating' | 'rd'> | null;
  blackRating: Pick<RatingRow, 'rating' | 'rd'> | null;
  viewerUserId: number | null;
  now: Date;
};

function player(
  user: UserRow,
  live: Pick<RatingRow, 'rating' | 'rd'> | null,
  snapshot: { before: number | null; after: number | null; rdBefore: number | null; rdAfter: number | null },
  finishedRated: boolean,
): GamePlayer {
  const useSnapshot =
    finishedRated && snapshot.before !== null && snapshot.after !== null && snapshot.rdBefore !== null && snapshot.rdAfter !== null;
  if (!useSnapshot) return { ...toPlayerRef(user, live), ratingAfter: null, provisionalAfter: null };
  return {
    ...toPlayerRef(user, { rating: snapshot.before!, rd: snapshot.rdBefore! }),
    ratingAfter: Math.round(snapshot.after!),
    provisionalAfter: isProvisional(snapshot.rdAfter!),
  };
}

/** The full game DTO of spec §9; the same function serves the REST route and every SSE push. */
export function buildGameDto(input: GameDtoInput): GameDto {
  const { game, moves, group, now } = input;
  const finishedRated = game.status === 'finished' && game.rated;
  const active = game.status === 'active';
  const dto: GameDto = {
    id: game.publicId,
    group: { id: group.publicId, title: group.title },
    status: game.status,
    white: player(
      input.white,
      input.whiteRating,
      { before: game.whiteRatingBefore, after: game.whiteRatingAfter, rdBefore: game.whiteRdBefore, rdAfter: game.whiteRdAfter },
      finishedRated,
    ),
    black: player(
      input.black,
      input.blackRating,
      { before: game.blackRatingBefore, after: game.blackRatingAfter, rdBefore: game.blackRdBefore, rdAfter: game.blackRdAfter },
      finishedRated,
    ),
    timePerMove: game.timePerMove as TimePerMove,
    rated: game.rated,
    fen: game.fen,
    plyCount: game.plyCount,
    version: game.version,
    moves: moves.map((move) => ({
      ply: move.ply,
      uci: move.uci,
      san: move.san,
      fenAfter: move.fenAfter,
      playedAt: move.playedAt.toISOString(),
    })),
    deadlineAt: active && game.deadlineAt ? game.deadlineAt.toISOString() : null,
    serverTime: now.toISOString(),
    drawOffer:
      active && game.drawOfferBy !== null && game.drawOfferPly !== null
        ? { by: game.drawOfferBy, atPly: game.drawOfferPly }
        : null,
    claims: active ? computeClaims(game.fen, positionKeys(moves)) : { threefold: false, fiftyMove: false },
    viewerRole: colourOf(game, input.viewerUserId) ?? 'spectator',
    result: game.result,
    endReason: game.endReason,
    voided: game.voidedAt !== null,
    startedAt: game.startedAt.toISOString(),
    finishedAt: game.finishedAt ? game.finishedAt.toISOString() : null,
  };
  if (game.status === 'finished') {
    if (game.lichessUrl) dto.lichessUrl = game.lichessUrl;
    if (moves.length > 0) dto.analysisUrl = analysisUrl(moves.map((move) => move.san));
  }
  return dto;
}
```

`apps/server/src/domain/games.ts`:

```ts
import {
  applyMove,
  sideToMove,
  timeoutOutcome,
  type EndReason,
  type GameDto,
  type GameResult,
  type TimePerMove,
} from '@group-chess/shared';
import { asc, eq, sql } from 'drizzle-orm';
import { dbNow, type DbOrTx } from '../db/client';
import { adminActions, games, groups, moves, type GameRow, type MoveRow } from '../db/schema';
import { enqueue } from '../jobs/queue';
import type { Deps } from './deps';
import { DomainError } from './errors';
import { buildGameDto, colourOf, positionKeys } from './gameDto';
import { deadlineExpression, reminderExpression } from './limits';
import { applyGameResultToRatings, getPlayerRating } from './ratings';
import { requireUser } from './users';

export type EndInput = { result: GameResult; endReason: EndReason };

export async function requireGameByPublicId(
  tx: DbOrTx,
  publicId: string,
  options: { forUpdate?: boolean } = {},
): Promise<GameRow> {
  const query = tx.select().from(games).where(eq(games.publicId, publicId)).limit(1);
  const [row] = options.forUpdate ? await query.for('update') : await query;
  if (!row) throw new DomainError('not_found', 'game not found');
  return row;
}

export async function requireGameById(
  tx: DbOrTx,
  id: number,
  options: { forUpdate?: boolean } = {},
): Promise<GameRow> {
  const query = tx.select().from(games).where(eq(games.id, id)).limit(1);
  const [row] = options.forUpdate ? await query.for('update') : await query;
  if (!row) throw new DomainError('not_found', 'game not found');
  return row;
}

export async function listMoves(tx: DbOrTx, gameId: number): Promise<MoveRow[]> {
  return tx.select().from(moves).where(eq(moves.gameId, gameId)).orderBy(asc(moves.ply));
}

export async function loadGameDto(tx: DbOrTx, game: GameRow, viewerUserId: number | null): Promise<GameDto> {
  const [group] = await tx
    .select({ publicId: groups.publicId, title: groups.title })
    .from(groups)
    .where(eq(groups.id, game.groupId))
    .limit(1);
  if (!group) throw new DomainError('not_found', 'group not found');
  const [moveRows, white, black, whiteRating, blackRating, now] = await Promise.all([
    listMoves(tx, game.id),
    requireUser(tx, game.whiteId),
    requireUser(tx, game.blackId),
    getPlayerRating(tx, game.groupId, game.whiteId),
    getPlayerRating(tx, game.groupId, game.blackId),
    dbNow(tx),
  ]);
  return buildGameDto({ game, moves: moveRows, group, white, black, whiteRating, blackRating, viewerUserId, now });
}

export async function getGameDto(deps: Deps, input: { gameId: string; viewerUserId: number | null }): Promise<GameDto> {
  const game = await requireGameByPublicId(deps.db, input.gameId);
  return loadGameDto(deps.db, game, input.viewerUserId);
}

/** Ends a game inside `tx`: status and result, ratings and snapshots, then the card, DM and import jobs. */
export async function finishGame(tx: DbOrTx, game: GameRow, end: EndInput, now: Date): Promise<GameRow> {
  const [updated] = await tx
    .update(games)
    .set({
      status: 'finished',
      result: end.result,
      endReason: end.endReason,
      finishedAt: now,
      deadlineAt: null,
      reminderAt: null,
      drawOfferBy: null,
      drawOfferPly: null,
      lichessImportStatus: game.plyCount > 0 ? 'pending' : null,
      version: sql`${games.version} + 1`,
    })
    .where(eq(games.id, game.id))
    .returning();
  if (!updated) throw new DomainError('not_found', 'game not found');
  await applyGameResultToRatings(tx, updated, now);
  await enqueue(tx, { kind: 'edit_card', payload: { gameId: game.id }, dedupKey: `card:g:${game.publicId}` });
  for (const userId of [game.whiteId, game.blackId]) {
    await enqueue(tx, {
      kind: 'send_dm',
      payload: { userId, template: 'game_end', gameId: game.id },
      dedupKey: `dm:${userId}:g:${game.publicId}:end`,
    });
  }
  if (game.plyCount > 0) {
    await enqueue(tx, { kind: 'lichess_import', payload: { gameId: game.id }, dedupKey: `lichess:${game.publicId}` });
  }
  return requireGameById(tx, game.id);
}

/** Spec §7.1: `timeout_abort` when the player to move never moved, otherwise a loss on time (FIDE 6.9). */
export function timeoutEnd(game: Pick<GameRow, 'fen' | 'plyCount'>): EndInput {
  const flagged = sideToMove(game.fen);
  const neverMoved = (flagged === 'white' && game.plyCount === 0) || (flagged === 'black' && game.plyCount === 1);
  if (neverMoved) return { result: '*', endReason: 'timeout_abort' };
  return timeoutOutcome(game.fen, flagged);
}

export async function applyTimeout(tx: DbOrTx, game: GameRow, now: Date): Promise<GameRow> {
  return finishGame(tx, game, timeoutEnd(game), now);
}

async function lockActiveGame(tx: DbOrTx, publicId: string, userId: number): Promise<{ game: GameRow; colour: 'white' | 'black' }> {
  const game = await requireGameByPublicId(tx, publicId, { forUpdate: true });
  const colour = colourOf(game, userId);
  if (!colour) throw new DomainError('forbidden', 'only the players can do that');
  if (game.status !== 'active') throw new DomainError('stale_state', 'the game is over');
  return { game, colour };
}

export type PlayMoveInput = { gameId: string; userId: number; uci: string; expectedPly: number; clientMoveId: string };

/** The move transaction of spec §7.4, step for step. */
export async function playMove(deps: Deps, input: PlayMoveInput): Promise<GameDto> {
  const dto = await deps.db.transaction(async (tx) => {
    const { game, colour } = await lockActiveGame(tx, input.gameId, input.userId);
    if (sideToMove(game.fen) !== colour) throw new DomainError('not_your_turn', 'not your turn');
    const history = await listMoves(tx, game.id);
    if (history.some((move) => move.clientMoveId === input.clientMoveId)) {
      return loadGameDto(tx, game, input.userId);
    }
    if (input.expectedPly !== game.plyCount) {
      throw new DomainError('stale_state', 'the position has changed', { plyCount: game.plyCount });
    }
    const now = await dbNow(tx);
    if (game.deadlineAt && game.deadlineAt.getTime() < now.getTime()) {
      return loadGameDto(tx, await applyTimeout(tx, game, now), input.userId);
    }
    const result = applyMove(game.fen, positionKeys(history), input.uci);
    if (!result.legal) throw new DomainError('illegal_move', 'illegal move');

    const ply = game.plyCount + 1;
    await tx.insert(moves).values({
      gameId: game.id,
      ply,
      uci: result.uci,
      san: result.san,
      fenAfter: result.fenAfter,
      playedAt: now,
      clientMoveId: input.clientMoveId,
    });
    const opponentId = colour === 'white' ? game.blackId : game.whiteId;
    const opponent = await requireUser(tx, opponentId);
    const timePerMove = game.timePerMove as TimePerMove;
    const offerLapses = game.drawOfferBy !== null && game.drawOfferBy !== colour;
    const [moved] = await tx
      .update(games)
      .set({
        fen: result.fenAfter,
        plyCount: ply,
        version: sql`${games.version} + 1`,
        lastMoveAt: now,
        deadlineAt: deadlineExpression(timePerMove),
        reminderAt: reminderExpression(timePerMove, opponent.dmAllowed),
        ...(offerLapses ? { drawOfferBy: null, drawOfferPly: null } : {}),
      })
      .where(eq(games.id, game.id))
      .returning();
    if (!moved) throw new DomainError('not_found', 'game not found');

    if (result.outcome.kind !== 'continue') {
      const end: EndInput =
        result.outcome.kind === 'checkmate'
          ? { result: result.outcome.winner === 'white' ? '1-0' : '0-1', endReason: 'checkmate' }
          : { result: '1/2-1/2', endReason: result.outcome.reason };
      return loadGameDto(tx, await finishGame(tx, moved, end, now), input.userId);
    }
    await enqueue(tx, { kind: 'edit_card', payload: { gameId: game.id }, dedupKey: `card:g:${game.publicId}` });
    await enqueue(tx, {
      kind: 'send_dm',
      payload: { userId: opponentId, template: 'turn', gameId: game.id },
      dedupKey: `dm:${opponentId}:g:${game.publicId}:turn:${ply}`,
    });
    return loadGameDto(tx, moved, input.userId);
  });
  deps.bus.publish(input.gameId);
  return dto;
}

export async function resign(deps: Deps, input: { gameId: string; userId: number }): Promise<GameDto> {
  const dto = await deps.db.transaction(async (tx) => {
    const { game, colour } = await lockActiveGame(tx, input.gameId, input.userId);
    const now = await dbNow(tx);
    const end: EndInput = { result: colour === 'white' ? '0-1' : '1-0', endReason: 'resignation' };
    return loadGameDto(tx, await finishGame(tx, game, end, now), input.userId);
  });
  deps.bus.publish(input.gameId);
  return dto;
}

/** PRD §7.3: abort is available before both players have moved; no rating change. */
export async function abortGame(deps: Deps, input: { gameId: string; userId: number }): Promise<GameDto> {
  const dto = await deps.db.transaction(async (tx) => {
    const { game } = await lockActiveGame(tx, input.gameId, input.userId);
    if (game.plyCount >= 2) throw new DomainError('forbidden', 'abort is no longer available', { reason: 'abort_unavailable' });
    const now = await dbNow(tx);
    return loadGameDto(tx, await finishGame(tx, game, { result: '*', endReason: 'abort' }, now), input.userId);
  });
  deps.bus.publish(input.gameId);
  return dto;
}

/** Spec §7.1/§7.5 void: caller has verified admin rights; ratings are rebuilt by the `rebuild_ratings` job. */
export async function voidGame(deps: Deps, input: { gameId: string; adminUserId: number }): Promise<GameDto> {
  const dto = await deps.db.transaction(async (tx) => {
    let game = await requireGameByPublicId(tx, input.gameId, { forUpdate: true });
    const now = await dbNow(tx);
    if (game.voidedAt) throw new DomainError('stale_state', 'already voided');
    if (game.status === 'active') {
      game = await finishGame(tx, game, { result: '*', endReason: 'voided' }, now);
    }
    const [voided] = await tx
      .update(games)
      .set({ voidedAt: now, voidedBy: input.adminUserId, version: sql`${games.version} + 1` })
      .where(eq(games.id, game.id))
      .returning();
    if (!voided) throw new DomainError('not_found', 'game not found');
    const [group] = await tx.select({ publicId: groups.publicId }).from(groups).where(eq(groups.id, game.groupId));
    if (voided.rated) {
      await enqueue(tx, { kind: 'rebuild_ratings', payload: { groupId: game.groupId }, dedupKey: `ratings:${group?.publicId}` });
    }
    await enqueue(tx, { kind: 'edit_card', payload: { gameId: game.id }, dedupKey: `card:g:${game.publicId}` });
    await tx.insert(adminActions).values({
      groupId: game.groupId,
      adminUserId: input.adminUserId,
      action: 'void',
      targetGameId: game.id,
      details: { previousResult: game.result, previousEndReason: game.endReason },
    });
    return loadGameDto(tx, voided, input.adminUserId);
  });
  deps.bus.publish(input.gameId);
  return dto;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run --project server apps/server/test/integration/games.test.ts`
Expected: PASS — 16 tests.

- [ ] **Step 5: Run the whole suite and the static checks**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm format:check`
Expected: all exit 0.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(server): add the move transaction, game ends, timeouts, resign, abort, void and the game DTO"
```

---

### Task 8: Draw offers and draw claims

**Files:**
- Create: `apps/server/src/domain/draws.ts`
- Modify: `apps/server/src/domain/games.ts` (export `lockActiveGame`)
- Test: `apps/server/test/unit/draws.test.ts`, `apps/server/test/integration/draws.test.ts`

**Interfaces:**
- Consumes: Task 7 (`lockActiveGame`, `finishGame`, `listMoves`, `loadGameDto`, `type EndInput`), `positionKeys`; shared `computeClaims`, `type Colour`.
- Produces: `canOfferDraw(game: Pick<GameRow, 'drawOfferBy' | 'lastDrawOfferPlyWhite' | 'lastDrawOfferPlyBlack' | 'plyCount'>, colour: Colour): boolean`, `offerDraw(deps, { gameId, userId }): Promise<GameDto>`, `acceptDraw(deps, { gameId, userId }): Promise<GameDto>`, `declineDraw(deps, { gameId, userId }): Promise<GameDto>`, `claimDraw(deps, { gameId, userId }): Promise<GameDto>`. `DomainError.details.reason` values: `draw_offer_unavailable`, `no_offer`, `no_claim`.

- [ ] **Step 1: Write the failing tests**

`apps/server/test/unit/draws.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { canOfferDraw } from '../../src/domain/draws';

const game = (over: Partial<Parameters<typeof canOfferDraw>[0]>) => ({
  drawOfferBy: null,
  lastDrawOfferPlyWhite: null,
  lastDrawOfferPlyBlack: null,
  plyCount: 0,
  ...over,
});

describe('canOfferDraw', () => {
  it('allows a first offer and refuses one while another is pending', () => {
    expect(canOfferDraw(game({}), 'white')).toBe(true);
    expect(canOfferDraw(game({ drawOfferBy: 'white' }), 'black')).toBe(false);
  });

  it('requires the player to have moved since their last offer', () => {
    expect(canOfferDraw(game({ lastDrawOfferPlyWhite: 0, plyCount: 0 }), 'white')).toBe(false);
    expect(canOfferDraw(game({ lastDrawOfferPlyWhite: 0, plyCount: 1 }), 'white')).toBe(true);
    expect(canOfferDraw(game({ lastDrawOfferPlyWhite: 1, plyCount: 2 }), 'white')).toBe(false);
    expect(canOfferDraw(game({ lastDrawOfferPlyWhite: 1, plyCount: 3 }), 'white')).toBe(true);
    expect(canOfferDraw(game({ lastDrawOfferPlyBlack: 1, plyCount: 1 }), 'black')).toBe(false);
    expect(canOfferDraw(game({ lastDrawOfferPlyBlack: 1, plyCount: 2 }), 'black')).toBe(true);
    expect(canOfferDraw(game({ lastDrawOfferPlyBlack: 2, plyCount: 3 }), 'black')).toBe(false);
    expect(canOfferDraw(game({ lastDrawOfferPlyBlack: 2, plyCount: 4 }), 'black')).toBe(true);
  });
});
```

`apps/server/test/integration/draws.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ratings } from '../../src/db/schema';
import { acceptDraw, claimDraw, declineDraw, offerDraw } from '../../src/domain/draws';
import { playMove } from '../../src/domain/games';
import { touchMember } from '../../src/domain/members';
import { openTestDb, testDeps, truncateAll } from '../helpers/db';
import { insertGame, insertGroup, insertUser, type GameOverrides } from '../helpers/fixtures';

const { db, close } = openTestDb();
const deps = testDeps(db);

beforeEach(() => truncateAll(db));
afterAll(() => close());

async function setup(overrides: GameOverrides = {}) {
  const group = await insertGroup(db);
  const alice = await insertUser(db, { firstName: 'Alice' });
  const bob = await insertUser(db, { firstName: 'Bob' });
  for (const user of [alice, bob]) await touchMember(db, group.id, user.id);
  const game = await insertGame(db, group.id, alice.id, bob.id, overrides);
  return { group, alice, bob, game };
}

let n = 0;
const play = (gameId: string, userId: number, uci: string, expectedPly: number) =>
  playMove(deps, { gameId, userId, uci, expectedPly, clientMoveId: `draw-test-${(n += 1)}` });

describe('draw offers', () => {
  it('records an offer, refuses a second one while it stands, and lets the opponent decline', async () => {
    const { game, alice, bob } = await setup();
    const offered = await offerDraw(deps, { gameId: game.publicId, userId: alice.id });
    expect(offered.drawOffer).toEqual({ by: 'white', atPly: 0 });
    expect(offered.version).toBe(1);
    await expect(offerDraw(deps, { gameId: game.publicId, userId: bob.id })).rejects.toMatchObject({
      details: { reason: 'draw_offer_unavailable' },
    });
    await expect(acceptDraw(deps, { gameId: game.publicId, userId: alice.id })).rejects.toMatchObject({
      details: { reason: 'no_offer' },
    });
    const declined = await declineDraw(deps, { gameId: game.publicId, userId: bob.id });
    expect(declined.drawOffer).toBeNull();
    expect(declined.status).toBe('active');
  });

  it('allows one offer per own move', async () => {
    const { game, alice, bob } = await setup();
    await offerDraw(deps, { gameId: game.publicId, userId: alice.id });
    await declineDraw(deps, { gameId: game.publicId, userId: bob.id });
    await expect(offerDraw(deps, { gameId: game.publicId, userId: alice.id })).rejects.toMatchObject({
      details: { reason: 'draw_offer_unavailable' },
    });
    await play(game.publicId, alice.id, 'e2e4', 0);
    const again = await offerDraw(deps, { gameId: game.publicId, userId: alice.id });
    expect(again.drawOffer).toEqual({ by: 'white', atPly: 1 });
  });

  it('ends the game by agreement when the opponent accepts', async () => {
    const { game, alice, bob } = await setup();
    await play(game.publicId, alice.id, 'e2e4', 0);
    await play(game.publicId, bob.id, 'e7e5', 1);
    await offerDraw(deps, { gameId: game.publicId, userId: bob.id });
    const dto = await acceptDraw(deps, { gameId: game.publicId, userId: alice.id });
    expect(dto).toMatchObject({ status: 'finished', result: '1/2-1/2', endReason: 'draw_agreement', drawOffer: null });
    expect(await db.select().from(ratings)).toHaveLength(2);
  });
});

describe('draw claims', () => {
  it('lets a player claim threefold repetition once the arbiter reports it', async () => {
    const { game, alice, bob } = await setup();
    const shuffle = ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8'];
    let ply = 0;
    for (const uci of shuffle) {
      await play(game.publicId, ply % 2 === 0 ? alice.id : bob.id, uci, ply);
      ply += 1;
    }
    await expect(claimDraw(deps, { gameId: game.publicId, userId: alice.id })).resolves.toMatchObject({
      status: 'finished',
      result: '1/2-1/2',
      endReason: 'threefold_claim',
    });
  });

  it('lets a player claim the fifty-move rule at halfmove 100', async () => {
    const { game, bob } = await setup({ fen: '8/8/8/8/8/8/1R6/K6k w - - 100 60', plyCount: 120 });
    const dto = await claimDraw(deps, { gameId: game.publicId, userId: bob.id });
    expect(dto).toMatchObject({ status: 'finished', endReason: 'fifty_move_claim' });
  });

  it('refuses a claim when neither rule applies', async () => {
    const { game, alice } = await setup();
    await expect(claimDraw(deps, { gameId: game.publicId, userId: alice.id })).rejects.toMatchObject({
      code: 'forbidden',
      details: { reason: 'no_claim' },
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run --project server apps/server/test/unit/draws.test.ts apps/server/test/integration/draws.test.ts`
Expected: FAIL — both files cannot load `../../src/domain/draws`.

- [ ] **Step 3: Write the implementation**

In `apps/server/src/domain/games.ts`, change `async function lockActiveGame(` to `export async function lockActiveGame(`.

`apps/server/src/domain/draws.ts`:

```ts
import { computeClaims, type Colour, type GameDto } from '@group-chess/shared';
import { eq, sql } from 'drizzle-orm';
import { dbNow } from '../db/client';
import { games, type GameRow } from '../db/schema';
import type { Deps } from './deps';
import { DomainError } from './errors';
import { positionKeys } from './gameDto';
import { finishGame, listMoves, loadGameDto, lockActiveGame, type EndInput } from './games';

type OfferState = Pick<GameRow, 'drawOfferBy' | 'lastDrawOfferPlyWhite' | 'lastDrawOfferPlyBlack' | 'plyCount'>;

/** Spec §7.1/§7.8: no offer while one stands, and at most one offer per own move. */
export function canOfferDraw(game: OfferState, colour: Colour): boolean {
  if (game.drawOfferBy !== null) return false;
  const last = colour === 'white' ? game.lastDrawOfferPlyWhite : game.lastDrawOfferPlyBlack;
  if (last === null) return true;
  // White moves on odd plies and Black on even ones; the player must have made a move after the offer.
  const ownParity = colour === 'white' ? 1 : 0;
  const nextOwnPly = last % 2 === ownParity ? last + 2 : last + 1;
  return game.plyCount >= nextOwnPly;
}

type Input = { gameId: string; userId: number };

export async function offerDraw(deps: Deps, input: Input): Promise<GameDto> {
  const dto = await deps.db.transaction(async (tx) => {
    const { game, colour } = await lockActiveGame(tx, input.gameId, input.userId);
    if (!canOfferDraw(game, colour)) {
      throw new DomainError('forbidden', 'a draw offer is not available now', { reason: 'draw_offer_unavailable' });
    }
    const [updated] = await tx
      .update(games)
      .set({
        drawOfferBy: colour,
        drawOfferPly: game.plyCount,
        ...(colour === 'white' ? { lastDrawOfferPlyWhite: game.plyCount } : { lastDrawOfferPlyBlack: game.plyCount }),
        version: sql`${games.version} + 1`,
      })
      .where(eq(games.id, game.id))
      .returning();
    if (!updated) throw new DomainError('not_found', 'game not found');
    return loadGameDto(tx, updated, input.userId);
  });
  deps.bus.publish(input.gameId);
  return dto;
}

function requireOpponentOffer(game: GameRow, colour: Colour): void {
  if (game.drawOfferBy === null || game.drawOfferBy === colour) {
    throw new DomainError('forbidden', 'there is no offer to answer', { reason: 'no_offer' });
  }
}

export async function acceptDraw(deps: Deps, input: Input): Promise<GameDto> {
  const dto = await deps.db.transaction(async (tx) => {
    const { game, colour } = await lockActiveGame(tx, input.gameId, input.userId);
    requireOpponentOffer(game, colour);
    const now = await dbNow(tx);
    const end: EndInput = { result: '1/2-1/2', endReason: 'draw_agreement' };
    return loadGameDto(tx, await finishGame(tx, game, end, now), input.userId);
  });
  deps.bus.publish(input.gameId);
  return dto;
}

export async function declineDraw(deps: Deps, input: Input): Promise<GameDto> {
  const dto = await deps.db.transaction(async (tx) => {
    const { game, colour } = await lockActiveGame(tx, input.gameId, input.userId);
    requireOpponentOffer(game, colour);
    const [updated] = await tx
      .update(games)
      .set({ drawOfferBy: null, drawOfferPly: null, version: sql`${games.version} + 1` })
      .where(eq(games.id, game.id))
      .returning();
    if (!updated) throw new DomainError('not_found', 'game not found');
    return loadGameDto(tx, updated, input.userId);
  });
  deps.bus.publish(input.gameId);
  return dto;
}

/** Spec §7.1: a claim succeeds only when the arbiter reports the current position claimable. */
export async function claimDraw(deps: Deps, input: Input): Promise<GameDto> {
  const dto = await deps.db.transaction(async (tx) => {
    const { game } = await lockActiveGame(tx, input.gameId, input.userId);
    const claims = computeClaims(game.fen, positionKeys(await listMoves(tx, game.id)));
    let end: EndInput;
    if (claims.threefold) end = { result: '1/2-1/2', endReason: 'threefold_claim' };
    else if (claims.fiftyMove) end = { result: '1/2-1/2', endReason: 'fifty_move_claim' };
    else throw new DomainError('forbidden', 'no draw can be claimed here', { reason: 'no_claim' });
    const now = await dbNow(tx);
    return loadGameDto(tx, await finishGame(tx, game, end, now), input.userId);
  });
  deps.bus.publish(input.gameId);
  return dto;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run --project server apps/server/test/unit/draws.test.ts apps/server/test/integration/draws.test.ts`
Expected: PASS — 8 tests (2 unit, 6 integration).

- [ ] **Step 5: Run the whole suite and the static checks**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm format:check`
Expected: all exit 0.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(server): add draw offers and draw claims"
```

---

### Task 9: Clock scanners — forfeits, reminders, challenge expiry

**Files:**
- Create: `apps/server/src/clock/scanners.ts`
- Test: `apps/server/test/integration/scanners.test.ts`

**Interfaces:**
- Consumes: `applyTimeout` (Task 7), `expireChallenges` (Task 6), `enqueue` (Task 3), `dbNow`, schema, `Deps`; shared `sideToMove`.
- Produces: `forfeitOverdueGames(deps, limit?): Promise<number>`, `sendDueReminders(deps, limit?): Promise<number>`, `runScannersOnce(deps): Promise<{ forfeits: number; reminders: number; expiries: number }>`, `startScanners(deps, { intervalMs? }): { stop(): Promise<void> }`.

- [ ] **Step 1: Write the failing test**

`apps/server/test/integration/scanners.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { forfeitOverdueGames, runScannersOnce, sendDueReminders, startScanners } from '../../src/clock/scanners';
import { games, jobs } from '../../src/db/schema';
import { openTestDb, testDeps, truncateAll } from '../helpers/db';
import { insertChallenge, insertGame, insertGroup, insertMove, insertUser } from '../helpers/fixtures';

const { db, close } = openTestDb();
const deps = testDeps(db);

beforeEach(() => truncateAll(db));
afterAll(() => close());

const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
const AFTER_E4_E5 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2';

async function people() {
  const group = await insertGroup(db);
  const alice = await insertUser(db);
  const bob = await insertUser(db);
  return { group, alice, bob };
}

const reload = async (id: number) => (await db.select().from(games).where(eq(games.id, id)))[0]!;

describe('forfeitOverdueGames', () => {
  it('ends only overdue games and publishes each one', async () => {
    const { group, alice, bob } = await people();
    const overdue = await insertGame(db, group.id, alice.id, bob.id, { deadlineInSeconds: -1 });
    const fresh = await insertGame(db, group.id, alice.id, bob.id, { deadlineInSeconds: 3600 });
    const published: string[] = [];
    deps.bus.subscribe(overdue.publicId, () => published.push(overdue.publicId));
    deps.bus.subscribe(fresh.publicId, () => published.push(fresh.publicId));

    expect(await forfeitOverdueGames(deps)).toBe(1);

    expect(await reload(overdue.id)).toMatchObject({ status: 'finished', result: '*', endReason: 'timeout_abort' });
    expect((await reload(fresh.id)).status).toBe('active');
    expect(published).toEqual([overdue.publicId]);
    expect(await forfeitOverdueGames(deps)).toBe(0);
  });

  it('scores a flag fall after real play as a loss', async () => {
    const { group, alice, bob } = await people();
    const game = await insertGame(db, group.id, alice.id, bob.id, { deadlineInSeconds: -1, fen: AFTER_E4_E5, plyCount: 2 });
    await insertMove(db, game.id, 1, 'e2e4', 'e4', AFTER_E4);
    await insertMove(db, game.id, 2, 'e7e5', 'e5', AFTER_E4_E5);
    await forfeitOverdueGames(deps);
    expect(await reload(game.id)).toMatchObject({ status: 'finished', result: '0-1', endReason: 'timeout' });
  });
});

describe('sendDueReminders', () => {
  it('enqueues one reminder DM for the player to move and clears the column', async () => {
    const { group, alice, bob } = await people();
    const game = await insertGame(db, group.id, alice.id, bob.id, { reminderInSeconds: -1 });
    expect(await sendDueReminders(deps)).toBe(1);
    const [job] = await db.select().from(jobs);
    expect(job).toMatchObject({ kind: 'send_dm', dedupKey: `dm:${alice.id}:g:${game.publicId}:reminder:0` });
    expect(job?.payload).toEqual({ userId: alice.id, template: 'reminder', gameId: game.id });
    expect((await reload(game.id)).reminderAt).toBeNull();
    expect(await sendDueReminders(deps)).toBe(0);
  });
});

describe('runScannersOnce and startScanners', () => {
  it('covers forfeits, reminders and challenge expiry in one pass', async () => {
    const { group, alice, bob } = await people();
    await insertGame(db, group.id, alice.id, bob.id, { deadlineInSeconds: -1 });
    await insertGame(db, group.id, bob.id, alice.id, { reminderInSeconds: -1 });
    await insertChallenge(db, group.id, alice.id, bob.id, { expiresInSeconds: -1 });
    expect(await runScannersOnce(deps)).toEqual({ forfeits: 1, reminders: 1, expiries: 1 });
  });

  it('keeps scanning on an interval until stopped', async () => {
    const { group, alice, bob } = await people();
    const game = await insertGame(db, group.id, alice.id, bob.id, { deadlineInSeconds: -1 });
    const scanners = startScanners(deps, { intervalMs: 20 });
    try {
      const deadline = Date.now() + 5_000;
      while ((await reload(game.id)).status === 'active' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally {
      await scanners.stop();
    }
    expect((await reload(game.id)).status).toBe('finished');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run --project server apps/server/test/integration/scanners.test.ts`
Expected: FAIL — cannot load `../../src/clock/scanners`.

- [ ] **Step 3: Write the implementation**

`apps/server/src/clock/scanners.ts`:

```ts
import { sideToMove } from '@group-chess/shared';
import { and, asc, eq, isNotNull, lte, sql } from 'drizzle-orm';
import { dbNow } from '../db/client';
import { games } from '../db/schema';
import { expireChallenges } from '../domain/challenges';
import type { Deps } from '../domain/deps';
import { applyTimeout } from '../domain/games';
import { enqueue } from '../jobs/queue';

/** Spec §7.3 forfeit scanner: rows are the state; the transaction re-checks each deadline against now(). */
export async function forfeitOverdueGames(deps: Deps, limit = 100): Promise<number> {
  const finished = await deps.db.transaction(async (tx) => {
    const due = await tx
      .select()
      .from(games)
      .where(and(eq(games.status, 'active'), lte(games.deadlineAt, sql`now()`)))
      .orderBy(asc(games.deadlineAt))
      .limit(limit)
      .for('update', { skipLocked: true });
    const now = await dbNow(tx);
    const publicIds: string[] = [];
    for (const game of due) {
      if (game.status !== 'active' || !game.deadlineAt || game.deadlineAt.getTime() > now.getTime()) continue;
      await applyTimeout(tx, game, now);
      publicIds.push(game.publicId);
    }
    return publicIds;
  });
  for (const publicId of finished) deps.bus.publish(publicId);
  return finished.length;
}

/** Spec §7.3 reminder scanner: one DM per turn, then the column is cleared. */
export async function sendDueReminders(deps: Deps, limit = 100): Promise<number> {
  return deps.db.transaction(async (tx) => {
    const due = await tx
      .select()
      .from(games)
      .where(and(eq(games.status, 'active'), isNotNull(games.reminderAt), lte(games.reminderAt, sql`now()`)))
      .orderBy(asc(games.reminderAt))
      .limit(limit)
      .for('update', { skipLocked: true });
    for (const game of due) {
      const userId = sideToMove(game.fen) === 'white' ? game.whiteId : game.blackId;
      await enqueue(tx, {
        kind: 'send_dm',
        payload: { userId, template: 'reminder', gameId: game.id },
        dedupKey: `dm:${userId}:g:${game.publicId}:reminder:${game.plyCount}`,
      });
      await tx.update(games).set({ reminderAt: null }).where(eq(games.id, game.id));
    }
    return due.length;
  });
}

export async function runScannersOnce(
  deps: Deps,
): Promise<{ forfeits: number; reminders: number; expiries: number }> {
  const forfeits = await forfeitOverdueGames(deps);
  const reminders = await sendDueReminders(deps);
  const expiries = await expireChallenges(deps);
  return { forfeits, reminders, expiries };
}

/** The `clock` role: every 5 s by default (spec §7.3). Errors are logged and the loop continues. */
export function startScanners(deps: Deps, options: { intervalMs?: number } = {}): { stop(): Promise<void> } {
  const intervalMs = options.intervalMs ?? 5_000;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> = Promise.resolve();
  const tick = async (): Promise<void> => {
    inFlight = runScannersOnce(deps)
      .then((counts) => {
        if (counts.forfeits || counts.reminders || counts.expiries) deps.log.info(counts, 'scanners applied transitions');
      })
      .catch((error: unknown) => {
        deps.log.error({ err: error }, 'scanner pass failed');
      });
    await inFlight;
    if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
  };
  timer = setTimeout(() => void tick(), 0);
  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight;
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run --project server apps/server/test/integration/scanners.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Run the whole suite and the static checks**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm format:check`
Expected: all exit 0.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(server): add the forfeit, reminder and expiry scanners"
```

---

### Task 10: Core job handlers — ratings rebuild and pruning

**Files:**
- Create: `apps/server/src/jobs/handlers/rebuildRatings.ts`, `apps/server/src/jobs/handlers/prune.ts`, `apps/server/src/jobs/handlers/index.ts`
- Test: `apps/server/test/integration/handlers.test.ts`

**Interfaces:**
- Consumes: `rebuildGroupRatings` (Task 5), `enqueue`, `JobWorker`, `JobHandler`, `JobHandlers` (Task 3), schema, `Deps`.
- Produces: `rebuildRatingsHandler(deps): JobHandler` (payload `{ groupId: number }`), `pruneHandler(deps): JobHandler` (spec §10: `telegram_updates` older than 7 days, done jobs older than 30 days; re-arms itself daily under dedup key `prune`), `ensurePruneScheduled(db): Promise<void>`, `coreJobHandlers(deps): JobHandlers` — plan 3 spreads its Telegram and Lichess handlers over this object.

- [ ] **Step 1: Write the failing test**

`apps/server/test/integration/handlers.test.ts`:

```ts
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { games, jobs, telegramUpdates } from '../../src/db/schema';
import { applyGameResultToRatings } from '../../src/domain/ratings';
import { coreJobHandlers, ensurePruneScheduled } from '../../src/jobs/handlers';
import { enqueue } from '../../src/jobs/queue';
import { JobWorker } from '../../src/jobs/worker';
import { openTestDb, testDeps, truncateAll } from '../helpers/db';
import { insertGame, insertGroup, insertUser } from '../helpers/fixtures';

const { db, close } = openTestDb();
const deps = testDeps(db);
const worker = () => new JobWorker({ db, log: deps.log, handlers: coreJobHandlers(deps), workerId: 'w' });

beforeEach(() => truncateAll(db));
afterAll(() => close());

describe('rebuild_ratings', () => {
  it('rebuilds the group and re-edits the cards whose deltas changed', async () => {
    const group = await insertGroup(db);
    const [alice, bob, carol] = await Promise.all([insertUser(db), insertUser(db), insertUser(db)]);
    const day = (d: number) => new Date(Date.UTC(2026, 8, d, 12));
    const finished = (w: number, b: number, result: '1-0' | '1/2-1/2', d: number) =>
      insertGame(db, group.id, w, b, { status: 'finished', result, endReason: 'resignation', finishedAt: day(d), plyCount: 20 });
    const a = await finished(alice.id, bob.id, '1-0', 1);
    const b = await finished(bob.id, carol.id, '1-0', 2);
    const c = await finished(carol.id, alice.id, '1/2-1/2', 3);
    for (const game of [a, b, c]) await applyGameResultToRatings(db, game, game.finishedAt!);
    await db.update(games).set({ voidedAt: sql`now()` }).where(eq(games.id, b.id));
    await enqueue(db, { kind: 'rebuild_ratings', payload: { groupId: group.id }, dedupKey: `ratings:${group.publicId}` });

    expect(await worker().runOnce()).toBe(1);

    const pending = await db.select().from(jobs).where(sql`${jobs.doneAt} is null`);
    expect(pending.map((job) => [job.kind, job.dedupKey])).toEqual([['edit_card', `card:g:${c.publicId}`]]);
  });
});

describe('prune', () => {
  it('deletes old updates and old done jobs, keeps recent ones, and re-arms itself for tomorrow', async () => {
    await db.insert(telegramUpdates).values([
      { updateId: 1, receivedAt: sql`now() - interval '8 days'` },
      { updateId: 2, receivedAt: sql`now() - interval '1 day'` },
    ]);
    await db.insert(jobs).values([
      { kind: 'edit_card', doneAt: sql`now() - interval '31 days'` },
      { kind: 'edit_card', doneAt: sql`now() - interval '1 day'` },
    ]);
    await ensurePruneScheduled(db);

    expect(await worker().runOnce()).toBe(1);

    expect((await db.select().from(telegramUpdates)).map((row) => row.updateId)).toEqual([2]);
    const remaining = await db.select().from(jobs).orderBy(jobs.id);
    expect(remaining.filter((job) => job.kind === 'edit_card')).toHaveLength(1);
    const prune = remaining.find((job) => job.kind === 'prune');
    expect(prune?.doneAt).toBeNull();
    const [row] = await db.execute(sql`select extract(epoch from (run_at - now())) as seconds from jobs where kind = 'prune'`);
    expect(Number(row?.seconds)).toBeGreaterThan(86_000);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run --project server apps/server/test/integration/handlers.test.ts`
Expected: FAIL — cannot load `../../src/jobs/handlers`.

- [ ] **Step 3: Write the implementation**

`apps/server/src/jobs/handlers/rebuildRatings.ts`:

```ts
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { games } from '../../db/schema';
import type { Deps } from '../../domain/deps';
import { rebuildGroupRatings } from '../../domain/ratings';
import { enqueue } from '../queue';
import type { JobHandler } from '../types';

const Payload = z.object({ groupId: z.number().int() });

/** Spec §7.5: replay the group, rewrite snapshots, re-edit the cards whose displayed deltas changed. */
export function rebuildRatingsHandler(deps: Deps): JobHandler {
  return async ({ job }) => {
    const { groupId } = Payload.parse(job.payload);
    await deps.db.transaction(async (tx) => {
      const { changedGameIds } = await rebuildGroupRatings(tx, groupId);
      for (const id of changedGameIds) {
        const [game] = await tx.select({ publicId: games.publicId }).from(games).where(eq(games.id, id));
        if (game) await enqueue(tx, { kind: 'edit_card', payload: { gameId: id }, dedupKey: `card:g:${game.publicId}` });
      }
    });
  };
}
```

`apps/server/src/jobs/handlers/prune.ts`:

```ts
import { and, isNotNull, sql } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client';
import { jobs, telegramUpdates } from '../../db/schema';
import type { Deps } from '../../domain/deps';
import { enqueue } from '../queue';
import type { JobHandler } from '../types';

const PRUNE_KEY = 'prune';
const DAY_SECONDS = 86_400;

/** Called at startup by the jobs role: makes sure one prune job is pending. */
export async function ensurePruneScheduled(db: DbOrTx): Promise<void> {
  await enqueue(db, { kind: 'prune', dedupKey: PRUNE_KEY });
}

/**
 * Spec §10 daily prune: `telegram_updates` older than 7 days, done jobs older than 30 days. Re-arming
 * moves this very row's `run_at` to tomorrow, which the worker then leaves pending instead of done.
 */
export function pruneHandler(deps: Deps): JobHandler {
  return async () => {
    await deps.db.delete(telegramUpdates).where(sql`${telegramUpdates.receivedAt} < now() - interval '7 days'`);
    await deps.db
      .delete(jobs)
      .where(and(isNotNull(jobs.doneAt), sql`${jobs.doneAt} < now() - interval '30 days'`));
    await enqueue(deps.db, { kind: 'prune', dedupKey: PRUNE_KEY, delaySeconds: DAY_SECONDS });
  };
}
```

`apps/server/src/jobs/handlers/index.ts`:

```ts
import type { Deps } from '../../domain/deps';
import type { JobHandlers } from '../types';
import { ensurePruneScheduled, pruneHandler } from './prune';
import { rebuildRatingsHandler } from './rebuildRatings';

export { ensurePruneScheduled };

/** Handlers that need no Telegram or Lichess client; plan 3 adds the rest to this object. */
export function coreJobHandlers(deps: Deps): JobHandlers {
  return {
    rebuild_ratings: rebuildRatingsHandler(deps),
    prune: pruneHandler(deps),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run --project server apps/server/test/integration/handlers.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 5: Run the whole suite and the static checks**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm format:check`
Expected: all exit 0.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(server): add the ratings rebuild and prune job handlers"
```

---

## Self-review

**Spec coverage (plan 2 scope):** §4.4 configuration → Task 1; §8 data model and migrations → Task 2; §10 jobs table, dedup, leasing, backoff, prune → Tasks 3 and 10; §5.6 membership records and blocks (database side) → Task 4; §7.5 ratings, snapshots, void rebuild, leaderboard → Tasks 5 and 10; §7.1 challenge state machine, limits §7.8, open-challenge race, rematch → Task 6; §7.4 move transaction, §7.1 end reasons, timeout and abort rules, resign, void, §9 game DTO → Task 7; draw offers and claims → Task 8; §7.3 scanners → Task 9; §4.2 bus → Task 2. Left to plan 3 by design: the membership verification ladder's Telegram calls, `delete my data`, sharing rows, lobby and finished-page queries, the API and bot layers, and every Telegram/Lichess job handler.

**Placeholder scan:** none.

**Type consistency:** `Deps = { db, bus, log }` is the single context type; `DomainError(code, message, details)` with `details.reason` strings listed per task; `EndInput` is defined in Task 7 and consumed by Task 8; `lockActiveGame` is created in Task 7 and exported in Task 8; `positionKeys` lives in `gameDto.ts` and is used by `games.ts` and `draws.ts`; `deadlineExpression`/`reminderExpression` in `limits.ts` are used by Tasks 6 and 7; job dedup keys follow one grammar — `card:send:<challengePublicId>`, `card:ch:<challengePublicId>`, `card:g:<gamePublicId>`, `dm:<userId>:ch:<challengePublicId>`, `dm:<userId>:g:<gamePublicId>:turn:<ply>`, `dm:<userId>:g:<gamePublicId>:end`, `dm:<userId>:g:<gamePublicId>:reminder:<ply>`, `lichess:<gamePublicId>`, `ratings:<groupPublicId>`, `prune`.

**Review Focus:** all five lines have their tests in the named tasks.
