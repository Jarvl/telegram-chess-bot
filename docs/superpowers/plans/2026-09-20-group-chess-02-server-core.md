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
- Produces: the Drizzle tables `users, groups, groupMembers, challenges, games, moves, ratings, shares, boardImages, jobs, telegramUpdates, adminActions` and their `$inferSelect` row types `UserRow, GroupRow, GroupMemberRow, ChallengeRow, GameRow, MoveRow, RatingRow, JobRow`; `createDb(url, { max? }) → { db, close }`, `type Db`, `type Tx`, `type DbOrTx`, `dbNow(tx): Promise<Date>`; `runMigrations(db, folder?)`; `generatePublicId(): string`; `interface Bus { publish(gameId: string): void; subscribe(gameId: string, listener: () => void): () => void }`, `class LocalBus`; `type Deps = { db: Db; bus: Bus; log: Logger }`; `class DomainError extends Error { code: ErrorCode; details: Record<string, unknown> }`; test helpers `openTestDb()`, `truncateAll(db)`, fixtures `insertUser`, `insertGroup`, `insertMember`, `insertGame`, `insertMove`.

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
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { Db } from './client';

const DEFAULT_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));
const MIGRATION_LOCK = 72_648_101;

/** Applies pending migrations under an advisory lock so concurrent replicas serialise (spec §4.4). */
export async function runMigrations(db: Db, migrationsFolder: string = DEFAULT_FOLDER): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${MIGRATION_LOCK})`);
    await migrate(tx, { migrationsFolder });
  });
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
import { createDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';

export default async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL must be set for integration tests');
  const { db, close } = createDb(url, { max: 1 });
  try {
    await runMigrations(db);
  } finally {
    await close();
  }
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
    await runMigrations(db);
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
    await expect(db.insert(jobs).values({ kind: 'edit_card', dedupKey: 'card:g:x' })).rejects.toThrow(
      /jobs_dedup_pending/,
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
