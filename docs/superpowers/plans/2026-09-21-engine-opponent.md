# Engine Opponent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Any user can challenge an always-available Stockfish opponent inside a group, at one of four named levels, in games that never affect ratings and never post to the group chat.

**Architecture:** Stockfish runs as a native binary behind an `Engine` interface, spawned once per move by a new `engine_move` job in the `jobs` role, so engine CPU never touches the `api` process holding SSE streams. A nullable `games.engine_level` column marks an engine game and drives one hook in `playMove`. Every test uses a fake engine; no CI runner installs Stockfish.

**Tech Stack:** TypeScript, Node 22, Drizzle on PostgreSQL 18, Hono, grammY, Preact, vitest, Playwright, Stockfish over UCI.

**Spec:** [docs/superpowers/specs/2026-09-21-engine-opponent-design.md](../specs/2026-09-21-engine-opponent-design.md)

## Global Constraints

- **No rating numbers in user-facing copy.** Not on the level control, the game card, or the game-end screen. The internal `UCI_Elo` values stay internal (spec §7 requirement 1).
- **No level may be presented as equivalent to a rating on the group's leaderboard** (spec §7 requirement 2).
- **`beginner` copy rule:** "the easiest level" is permitted, "suitable for beginners" is forbidden (spec §7 requirement 3).
- **Engine games are always unrated.** `rated` is forced `false` server-side, never taken from the client (spec E3).
- **Engine games post nothing to the group chat** — no challenge card, no result card (spec §8).
- **Engine games are never imported into Lichess** (spec §8).
- **The engine can never lose on time** (spec §9).
- **No test asserts a specific engine move, an evaluation, a mate score, or that a level plays at its labelled strength.** Level configuration is verified by asserting the UCI options *we send* (spec §11).
- **No CI runner installs Stockfish.** The real binary appears only in the Dockerfile build assertion and the existing image smoke job (spec §11).
- Naming: the Telegram bot is "the bot"; this feature is "the engine" in code, config and metrics, and "the bot" in user-facing copy (spec §0).
- Existing gates must stay green: `pnpm lint && pnpm format:check && pnpm typecheck`, `pnpm test`, `pnpm build && pnpm check:budget`, `pnpm check:licences`.

## Review Focus

These are the input classes the spec implies but does not name. Each has a test in the task that owns the code.

1. **The engine returns a promotion move (`e7e8q`).** If the adapter drops the promotion character, `playMove` rejects the move as illegal and the E7 fallback silently substitutes a random move — so a parser bug becomes permanently bad play with no visible error. Test in Task 2.
2. **An engine game with `timePerMove = null` (no clock).** `deadlineExpression(null)` already yields null for everyone, so the never-forfeit rule must not assume a clock exists, and a human in a clockless engine game must not acquire one. Test in Task 5.
3. **An `engine_move` job that runs after the game already ended** — the human resigned, aborted, or was forfeited while the job sat in the queue. It must complete without moving rather than throwing. Test in Task 6.
4. **A third concurrent engine game by the same user.** `MAX_GAMES_PER_PAIR = 2` must refuse it as a domain error the API turns into a clean 4xx, not an unhandled 500. Test in Task 4.
5. **`ENGINE_ENABLED=false` while an engine game is in flight.** The worker retries an unhandled job kind forever *without counting an attempt* (`apps/server/src/jobs/worker.ts:119`), so leaving the handler unregistered when the engine is off would stall such a game permanently and it would never reach §9's abort. The handler is therefore always registered and owns the disabled case itself. Test in Task 6.

---

### Task 1: Level vocabulary, config, and the Engine interface

Adds the shared `EngineLevel` type, the three config variables, and the `Engine` seam with its fake. No behaviour yet — this is the vocabulary every later task imports.

**Files:**
- Modify: `packages/shared/src/protocol/enums.ts`
- Create: `apps/server/src/engine/engine.ts`
- Modify: `apps/server/src/config.ts`
- Create: `apps/server/test/helpers/fakeEngine.ts`
- Test: `packages/shared/test/enums.test.ts` (create if absent), `apps/server/test/unit/config.test.ts` (append)

**Interfaces:**
- Consumes: nothing.
- Produces: `EngineLevel` (`'beginner' | 'casual' | 'club' | 'strong'`), `ENGINE_LEVELS: readonly EngineLevel[]`, `EngineLevelSchema` (zod) from `@group-chess/shared`; `Engine`, `BestMove` from `../engine/engine`; `fakeEngine(options)` returning `Engine & { calls: EngineCall[] }`; config fields `ENGINE_ENABLED: boolean`, `ENGINE_PATH: string`, `ENGINE_MOVETIME_MS: number`.

- [ ] **Step 1: Write the failing test for the level vocabulary**

In `packages/shared/test/enums.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ENGINE_LEVELS, EngineLevelSchema } from '../src';

describe('engine levels', () => {
  it('lists the four levels weakest first', () => {
    expect(ENGINE_LEVELS).toEqual(['beginner', 'casual', 'club', 'strong']);
  });

  it('accepts a known level and refuses anything else', () => {
    expect(EngineLevelSchema.safeParse('club').success).toBe(true);
    expect(EngineLevelSchema.safeParse('grandmaster').success).toBe(false);
    expect(EngineLevelSchema.safeParse(1600).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm --filter @group-chess/shared exec vitest run test/enums.test.ts`
Expected: FAIL — `ENGINE_LEVELS` is not exported.

- [ ] **Step 3: Add the vocabulary to shared**

In `packages/shared/src/protocol/enums.ts`, following the file's existing pattern:

```ts
export const ENGINE_LEVELS = ['beginner', 'casual', 'club', 'strong'] as const;

export type EngineLevel = (typeof ENGINE_LEVELS)[number];

export const EngineLevelSchema = z.enum(ENGINE_LEVELS);
```

If `enums.ts` does not already import zod, add `import { z } from 'zod';` at the top. Confirm `packages/shared/src/index.ts` re-exports `./protocol/enums` — it does for the other enums; if the exports are named individually, add `ENGINE_LEVELS`, `EngineLevel` and `EngineLevelSchema`.

- [ ] **Step 4: Run it to make sure it passes**

Run: `pnpm --filter @group-chess/shared exec vitest run test/enums.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing config test**

Append to the `describe('loadConfig')` block in `apps/server/test/unit/config.test.ts`. That file already has a `valid` object of required variables and imports `loadConfig` from `../../src/config`; spread `valid` rather than building a new environment:

```ts
it('defaults the engine on, at the binary on PATH, with a 200 ms budget', () => {
  const config = loadConfig(valid);
  expect(config.ENGINE_ENABLED).toBe(true);
  expect(config.ENGINE_PATH).toBe('stockfish');
  expect(config.ENGINE_MOVETIME_MS).toBe(200);
});

it('lets a machine without the binary turn the engine off', () => {
  expect(loadConfig({ ...valid, ENGINE_ENABLED: 'false' }).ENGINE_ENABLED).toBe(false);
});

it('refuses a non-positive move time', () => {
  expect(() => loadConfig({ ...valid, ENGINE_MOVETIME_MS: '0' })).toThrow();
});
```

The `valid` object in that file has no engine variables, so these cases also prove the defaults apply when nothing is set.

- [ ] **Step 6: Run it to make sure it fails**

Run: `pnpm --filter @group-chess/server exec vitest run test/unit/config.test.ts`
Expected: FAIL — `ENGINE_ENABLED` is not on the config type.

- [ ] **Step 7: Add the config fields**

In `apps/server/src/config.ts`, inside the schema object alongside `TELEGRAM_POLLING` (copy that field's boolean-coercion style exactly rather than inventing one):

```ts
  ENGINE_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  ENGINE_PATH: z.string().min(1).default('stockfish'),
  ENGINE_MOVETIME_MS: z.coerce.number().int().min(1).max(60_000).default(200),
```

- [ ] **Step 8: Run it to make sure it passes**

Run: `pnpm --filter @group-chess/server exec vitest run test/unit/config.test.ts`
Expected: PASS

- [ ] **Step 9: Write the Engine interface**

Create `apps/server/src/engine/engine.ts`:

```ts
import type { EngineLevel } from '@group-chess/shared';

/** A move in UCI notation, or `none` when the engine reports the position is terminal. */
export type BestMove = { uci: string } | { none: true };

/**
 * The seam between the server and Stockfish (spec §6.2). Everything above it — jobs, domain, API —
 * depends only on this, which is what keeps the test suite free of the binary (spec §11).
 */
export type Engine = {
  bestMove(fen: string, level: EngineLevel, deadlineMs: number): Promise<BestMove>;
  probe(): Promise<{ available: boolean; version?: string }>;
};
```

- [ ] **Step 10: Write the fake engine**

Create `apps/server/test/helpers/fakeEngine.ts`:

```ts
import type { EngineLevel } from '@group-chess/shared';
import type { BestMove, Engine } from '../../src/engine/engine';

export type EngineCall = { fen: string; level: EngineLevel; deadlineMs: number };

export type FakeEngineOptions = {
  /** Replies in order; the last one repeats once the list runs out. */
  replies?: BestMove[];
  /** Thrown instead of replying, for the crash and timeout paths. */
  fail?: Error;
  available?: boolean;
};

export type FakeEngine = Engine & { calls: EngineCall[] };

export function fakeEngine(options: FakeEngineOptions = {}): FakeEngine {
  const replies = options.replies ?? [{ uci: 'e7e5' }];
  const calls: EngineCall[] = [];
  return {
    calls,
    async bestMove(fen, level, deadlineMs) {
      calls.push({ fen, level, deadlineMs });
      if (options.fail) throw options.fail;
      return replies[Math.min(calls.length - 1, replies.length - 1)]!;
    },
    async probe() {
      return { available: options.available ?? true, version: 'fake 1' };
    },
  };
}
```

- [ ] **Step 11: Verify the whole suite and the gates still pass**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: PASS, with the new level and config tests included.

- [ ] **Step 12: Commit**

```bash
git add packages/shared apps/server/src/config.ts apps/server/src/engine apps/server/test
git commit -m "feat: add engine level vocabulary, config and the Engine seam"
```

---

### Task 2: The UCI adapter

The only code that talks to Stockfish. Split into pure functions (options per level, reply parsing) that are unit-tested, plus thin spawn glue that the Dockerfile assertion and the image smoke job cover (spec §11, §12).

**Files:**
- Create: `apps/server/src/engine/protocol.ts`
- Create: `apps/server/src/engine/uci.ts`
- Test: `apps/server/test/unit/engine-protocol.test.ts`

**Interfaces:**
- Consumes: `EngineLevel` from shared; `BestMove`, `Engine` from `../engine/engine` (Task 1); `Config` from `../config`.
- Produces: `optionsForLevel(level: EngineLevel): UciOption[]` where `UciOption = { name: string; value: string | number }`; `parseBestMove(output: string): BestMove | null`; `uciEngine(config: Pick<Config, 'ENGINE_PATH' | 'ENGINE_MOVETIME_MS'>): Engine`.

- [ ] **Step 1: Write the failing test for the per-level options**

Create `apps/server/test/unit/engine-protocol.test.ts`:

```ts
import { ENGINE_LEVELS } from '@group-chess/shared';
import { describe, expect, it } from 'vitest';
import { optionsForLevel, parseBestMove } from '../../src/engine/protocol';

const byName = (level: Parameters<typeof optionsForLevel>[0]) =>
  new Map(optionsForLevel(level).map((option) => [option.name, option.value]));

describe('optionsForLevel', () => {
  it('weakens the two lowest levels with Skill Level, not with an Elo limit', () => {
    for (const level of ['beginner', 'casual'] as const) {
      const options = byName(level);
      expect(options.has('Skill Level')).toBe(true);
      expect(options.has('UCI_LimitStrength')).toBe(false);
    }
  });

  it('limits the two highest levels by Elo', () => {
    for (const level of ['club', 'strong'] as const) {
      const options = byName(level);
      expect(options.get('UCI_LimitStrength')).toBe('true');
      expect(typeof options.get('UCI_Elo')).toBe('number');
    }
  });

  it('orders the levels weakest to strongest, so no two levels play the same', () => {
    const skill = (level: 'beginner' | 'casual') => Number(byName(level).get('Skill Level'));
    const elo = (level: 'club' | 'strong') => Number(byName(level).get('UCI_Elo'));
    expect(skill('beginner')).toBeLessThan(skill('casual'));
    expect(elo('club')).toBeLessThan(elo('strong'));
  });

  it('gives every level a configuration', () => {
    for (const level of ENGINE_LEVELS) expect(optionsForLevel(level).length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm --filter @group-chess/server exec vitest run test/unit/engine-protocol.test.ts`
Expected: FAIL — cannot resolve `../../src/engine/protocol`.

- [ ] **Step 3: Write the failing parser tests, including the promotion case**

Append to the same file. The promotion case is Review Focus 1: dropping the promotion character would make `playMove` reject the move and silently trigger the E7 random fallback.

```ts
describe('parseBestMove', () => {
  it('reads a plain move', () => {
    expect(parseBestMove('info depth 1\nbestmove e2e4\n')).toEqual({ uci: 'e2e4' });
  });

  it('keeps the promotion piece', () => {
    expect(parseBestMove('bestmove e7e8q\n')).toEqual({ uci: 'e7e8q' });
  });

  it('ignores a ponder move rather than reading it as the move', () => {
    expect(parseBestMove('bestmove d2d4 ponder g8f6\n')).toEqual({ uci: 'd2d4' });
  });

  it('reports a terminal position', () => {
    expect(parseBestMove('bestmove (none)\n')).toEqual({ none: true });
  });

  it('returns null for output with no bestmove line', () => {
    expect(parseBestMove('info string Load eval file\n')).toBeNull();
    expect(parseBestMove('')).toBeNull();
  });

  it('takes the last bestmove when several are present', () => {
    expect(parseBestMove('bestmove a2a3\nbestmove h2h4\n')).toEqual({ uci: 'h2h4' });
  });
});
```

- [ ] **Step 4: Run them to make sure they fail**

Run: `pnpm --filter @group-chess/server exec vitest run test/unit/engine-protocol.test.ts`
Expected: FAIL — module still missing.

- [ ] **Step 5: Write the pure protocol module**

Create `apps/server/src/engine/protocol.ts`:

```ts
import type { EngineLevel } from '@group-chess/shared';
import type { BestMove } from './engine';

export type UciOption = { name: string; value: string | number };

/**
 * Spec §7. The two Skill Level values and the two UCI_Elo values are chosen, not measured: this
 * project runs no calibration matches. `beginner` is the weakest setting Stockfish offers natively,
 * which is still well above a new player — see the spec's §14.
 */
const LEVELS: Record<EngineLevel, UciOption[]> = {
  beginner: [{ name: 'Skill Level', value: 0 }],
  casual: [{ name: 'Skill Level', value: 5 }],
  club: [
    { name: 'UCI_LimitStrength', value: 'true' },
    { name: 'UCI_Elo', value: 1600 },
  ],
  strong: [
    { name: 'UCI_LimitStrength', value: 'true' },
    { name: 'UCI_Elo', value: 2400 },
  ],
};

export function optionsForLevel(level: EngineLevel): UciOption[] {
  return LEVELS[level];
}

/**
 * Reads the `bestmove` line out of a UCI session. The promotion suffix must survive: without it the
 * arbiter rejects the move and the caller falls back to a random one (spec §9), which would turn a
 * parser bug into permanently bad play.
 */
export function parseBestMove(output: string): BestMove | null {
  let found: BestMove | null = null;
  for (const line of output.split('\n')) {
    const match = /^bestmove\s+(\S+)/.exec(line.trim());
    if (!match) continue;
    const token = match[1]!;
    found = token === '(none)' ? { none: true } : { uci: token };
  }
  return found;
}
```

- [ ] **Step 6: Run them to make sure they pass**

Run: `pnpm --filter @group-chess/server exec vitest run test/unit/engine-protocol.test.ts`
Expected: PASS

- [ ] **Step 7: Write the spawn glue**

Create `apps/server/src/engine/uci.ts`. One process per move (spec §6.2): no mutex, no session state to bleed, and a `SIGKILL` that cannot leave a job held open.

```ts
import { spawn } from 'node:child_process';
import type { EngineLevel } from '@group-chess/shared';
import type { Config } from '../config';
import type { BestMove, Engine } from './engine';
import { optionsForLevel, parseBestMove } from './protocol';

export type EngineConfig = Pick<Config, 'ENGINE_PATH' | 'ENGINE_MOVETIME_MS'>;

/** Runs one UCI session to completion and returns everything it printed. */
function session(path: string, commands: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(path, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '';
    let settled = false;
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      if (error) reject(error);
      else resolve(output);
    };
    const timer = setTimeout(() => finish(new Error('engine timed out')), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
    });
    child.on('error', (error) => finish(error));
    child.on('close', () => finish(null));
    child.stdin.on('error', () => undefined);
    child.stdin.end(`${commands.join('\n')}\n`);
  });
}

export function uciEngine(config: EngineConfig): Engine {
  const path = config.ENGINE_PATH;
  return {
    async bestMove(fen: string, level: EngineLevel, deadlineMs: number): Promise<BestMove> {
      const options = optionsForLevel(level).map(
        (option) => `setoption name ${option.name} value ${option.value}`,
      );
      const output = await session(
        path,
        [
          'uci',
          ...options,
          'isready',
          'ucinewgame',
          `position fen ${fen}`,
          `go movetime ${config.ENGINE_MOVETIME_MS}`,
          'quit',
        ],
        deadlineMs,
      );
      const move = parseBestMove(output);
      if (!move) throw new Error(`engine produced no bestmove: ${output.slice(-200)}`);
      return move;
    },
    async probe() {
      try {
        const output = await session(path, ['uci', 'quit'], 10_000);
        const version = /^id name (.+)$/m.exec(output)?.[1];
        return { available: /uciok/.test(output), version };
      } catch {
        return { available: false };
      }
    },
  };
}
```

- [ ] **Step 8: Verify the gates**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: PASS. No test spawns a binary.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/engine apps/server/test/unit/engine-protocol.test.ts
git commit -m "feat: add the UCI adapter with per-level options and reply parsing"
```

---

### Task 3: Migration and the engine user

Adds `games.engine_level`, `users.is_engine`, and the single engine user row.

**Files:**
- Modify: `apps/server/src/db/schema.ts`
- Create: `apps/server/drizzle/0002_engine_opponent.sql` (generated, then hand-edited to add the row)
- Create: `apps/server/src/domain/engineGames.ts`
- Test: `apps/server/test/integration/engine-user.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `games.engineLevel` (`EngineLevel | null`) and `users.isEngine` (`boolean`) on the Drizzle row types; `getEngineUser(tx: DbOrTx): Promise<UserRow>`; `isEngineGame(game: Pick<GameRow, 'engineLevel'>): boolean`.

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/integration/engine-user.test.ts`. Copy the describe/setup preamble from an existing integration test such as `apps/server/test/integration/users-groups.test.ts` so the database helpers match.

```ts
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { users } from '../../src/db/schema';
import { getEngineUser } from '../../src/domain/engineGames';
// plus the same db/truncate helpers the neighbouring integration tests import

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
```

Import `insertGroup` from `../helpers/fixtures` and `listKnownPlayers` from `../../src/domain/members`. Note `truncateAll` must not delete the engine row — Step 5 covers that.

- [ ] **Step 2: Run it to make sure it fails**

Run: `TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54329/group_chess_test pnpm --filter @group-chess/server exec vitest run test/integration/engine-user.test.ts`
Expected: FAIL — `users.isEngine` does not exist.

- [ ] **Step 3: Add the columns to the schema**

In `apps/server/src/db/schema.ts`, add to the `users` table:

```ts
  isEngine: boolean().notNull().default(false),
```

and to the `games` table, beside `rated`:

```ts
  engineLevel: text().$type<EngineLevel>(),
```

Add `EngineLevel` to the existing `@group-chess/shared` type import at the top of the file.

- [ ] **Step 4: Generate the migration**

Run: `pnpm --filter @group-chess/server db:generate`
Expected: a new file under `apps/server/drizzle/`. Rename it to `0002_engine_opponent.sql` only if drizzle-kit's generated name is unhelpful, and update `apps/server/drizzle/meta/_journal.json` to match if you rename it.

- [ ] **Step 5: Add the engine row and its uniqueness to the migration**

Append to the generated SQL file:

```sql
--> statement-breakpoint
CREATE UNIQUE INDEX "users_single_engine" ON "users" ("is_engine") WHERE "is_engine";
--> statement-breakpoint
INSERT INTO "users" ("first_name", "is_engine", "dm_allowed")
VALUES ('Stockfish', true, false)
ON CONFLICT DO NOTHING;
```

Then open `apps/server/test/helpers/db.ts` and make `truncateAll` preserve this row: the engine user is created by a migration, not by a test, so truncating it would break every later test. Either exclude `users` from the truncation of that row with a `WHERE NOT is_engine` delete, or re-insert it after truncation. Read the helper and follow whichever fits its existing shape.

- [ ] **Step 6: Write the domain helpers**

Create `apps/server/src/domain/engineGames.ts`:

```ts
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
```

- [ ] **Step 7: Run the test to make sure it passes**

Run: `TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54329/group_chess_test pnpm --filter @group-chess/server exec vitest run test/integration/engine-user.test.ts`
Expected: PASS

- [ ] **Step 8: Run the whole suite — the truncation change touches everything**

Run: `export TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54329/group_chess_test && pnpm test`
Expected: PASS, all existing tests included. If integration tests fail on a missing engine row, Step 5's truncation change is wrong.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/db apps/server/drizzle apps/server/src/domain/engineGames.ts apps/server/test
git commit -m "feat: add engine_level, is_engine and the engine user row"
```

---

### Task 4: Creating an engine game

A single transaction that creates a started game with no challenge, no card and no expiry.

**Files:**
- Modify: `apps/server/src/domain/engineGames.ts`
- Test: `apps/server/test/integration/engine-games.test.ts`

**Interfaces:**
- Consumes: `getEngineUser` (Task 3); `EngineLevel` from shared; `Deps`; `deadlineExpression`, `reminderExpression`, `countActiveGames`, `countActiveGamesBetween`, `MAX_GAMES_PER_PAIR` from `./limits`; `requireGroup`, `settingsOf` from `./groups`; `requireUser`, `wantsDms` from `./users`; `generatePublicId` from `../db/ids`.
- Produces: `createEngineGame(deps: Deps, input: CreateEngineGameInput): Promise<GameRow>` where `CreateEngineGameInput = { groupId: number; userId: number; level: EngineLevel; colour: ColourChoice; timePerMove: TimePerMove }`.

- [ ] **Step 1: Write the failing tests**

Create `apps/server/test/integration/engine-games.test.ts`, with the same preamble as the neighbouring integration tests. The third-game case is Review Focus 4.

```ts
it('creates a started, unrated game against the engine with no challenge and no card job', async () => {
  const game = await createEngineGame(deps, {
    groupId: group.id, userId: alice.id, level: 'club', colour: 'white', timePerMove: 86_400,
  });
  expect(game.status).toBe('active');
  expect(game.rated).toBe(false);
  expect(game.engineLevel).toBe('club');
  expect(game.whiteId).toBe(alice.id);
  expect(game.blackId).toBe((await getEngineUser(db)).id);
  expect(await db.select().from(challenges)).toHaveLength(0);
  const kinds = (await db.select().from(jobs)).map((job) => job.kind);
  expect(kinds).not.toContain('send_challenge_card');
  expect(kinds).not.toContain('edit_card');
});

it('forces the game unrated even when the caller asks for rated', async () => {
  // `rated` is not part of the input at all, which is the point: it cannot be requested.
  const game = await createEngineGame(deps, {
    groupId: group.id, userId: alice.id, level: 'club', colour: 'random', timePerMove: null,
  });
  expect(game.rated).toBe(false);
});

it('enqueues an engine move immediately when the engine has white', async () => {
  const game = await createEngineGame(deps, {
    groupId: group.id, userId: alice.id, level: 'club', colour: 'black', timePerMove: 86_400,
  });
  const engineJobs = (await db.select().from(jobs)).filter((job) => job.kind === 'engine_move');
  expect(engineJobs).toHaveLength(1);
  expect(game.deadlineAt).toBeNull();
});

it('refuses a third concurrent engine game with a domain error, not a crash', async () => {
  for (let i = 0; i < MAX_GAMES_PER_PAIR; i += 1) {
    await createEngineGame(deps, {
      groupId: group.id, userId: alice.id, level: 'club', colour: 'white', timePerMove: 86_400,
    });
  }
  await expect(
    createEngineGame(deps, {
      groupId: group.id, userId: alice.id, level: 'club', colour: 'white', timePerMove: 86_400,
    }),
  ).rejects.toBeInstanceOf(DomainError);
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `TEST_DATABASE_URL=… pnpm --filter @group-chess/server exec vitest run test/integration/engine-games.test.ts`
Expected: FAIL — `createEngineGame` is not exported.

- [ ] **Step 3: Implement createEngineGame**

Append to `apps/server/src/domain/engineGames.ts`. Read `acceptChallenge` in `apps/server/src/domain/challenges.ts` first: this mirrors its game insert, minus the challenge row, the card and the DM to the opponent.

```ts
export type CreateEngineGameInput = {
  groupId: number;
  userId: number;
  level: EngineLevel;
  colour: ColourChoice;
  timePerMove: TimePerMove;
};

/** Spec §6.1. No challenge, no card, no expiry: there is nothing to accept. */
export async function createEngineGame(
  deps: Deps,
  input: CreateEngineGameInput,
): Promise<GameRow> {
  const result = await deps.db.transaction(async (tx) => {
    const group = await requireGroup(tx, input.groupId);
    const settings = settingsOf(group);
    const player = await requireUser(tx, input.userId);
    const engine = await getEngineUser(tx);
    if (await isBlocked(tx, group.id, player.id)) {
      throw new DomainError('forbidden', 'blocked in this group', { reason: 'blocked' });
    }
    const active = await countActiveGames(tx, group.id, player.id);
    if (active >= settings.maxActiveGamesPerUser) {
      throw new DomainError('limit_exceeded', 'active games limit reached', {
        reason: 'active_limit', userId: player.id, name: player.firstName, count: active,
      });
    }
    // The engine's own active-game count is exempt — it plays everyone at once — but the pair limit
    // still caps concurrent engine games per user (spec §6.1).
    const pair = await countActiveGamesBetween(tx, group.id, player.id, engine.id);
    if (pair >= MAX_GAMES_PER_PAIR) {
      throw new DomainError('limit_exceeded', 'too many games against the bot', {
        reason: 'pair_limit', name: engine.firstName, count: pair,
      });
    }
    const playerColour = input.colour === 'random' ? randomColour() : input.colour;
    const white = playerColour === 'white' ? player : engine;
    const black = playerColour === 'white' ? engine : player;
    const engineToMove = white.isEngine;
    const [game] = await tx
      .insert(games)
      .values({
        publicId: generatePublicId(),
        groupId: group.id,
        whiteId: white.id,
        blackId: black.id,
        timePerMove: input.timePerMove,
        rated: false,
        engineLevel: input.level,
        fen: INITIAL_FEN,
        // Spec §9: the engine never carries a deadline, so it can never be forfeited.
        deadlineAt: engineToMove ? null : deadlineExpression(input.timePerMove),
        reminderAt: engineToMove
          ? null
          : reminderExpression(input.timePerMove, wantsDms(player)),
      })
      .returning();
    if (!game) throw new Error('engine game insert returned no row');
    if (engineToMove) await enqueueEngineMove(tx, game);
    return game;
  });
  deps.bus.publish(result.publicId);
  return result;
}
```

`randomColour` is private to `challenges.ts`; export it from there and import it rather than writing a second copy. `enqueueEngineMove` comes from Task 5 — write that function first if you are implementing in order, or add it now as:

```ts
export function enqueueEngineMove(
  tx: DbOrTx,
  game: Pick<GameRow, 'id' | 'publicId' | 'plyCount'>,
): Promise<void> {
  return enqueue(tx, {
    kind: 'engine_move',
    payload: { gameId: game.id },
    dedupKey: `engine:g:${game.publicId}:ply:${game.plyCount}`,
  });
}
```

Add `'engine_move'` to `JOB_KINDS` in `apps/server/src/jobs/types.ts` so the enqueue type-checks.

- [ ] **Step 4: Run them to make sure they pass**

Run: `TEST_DATABASE_URL=… pnpm --filter @group-chess/server exec vitest run test/integration/engine-games.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/domain apps/server/src/jobs/types.ts apps/server/test/integration/engine-games.test.ts
git commit -m "feat: create engine games without a challenge or a card"
```

---

### Task 5: Teaching playMove and finishGame about engine games

Four conditionals. Skipping the `edit_card` enqueue is mandatory, not cosmetic: the handler throws when `cardMessageId` is null (`apps/server/src/jobs/handlers/telegram.ts:135`), so every engine move would otherwise spawn a job that fails eight times.

**Files:**
- Modify: `apps/server/src/domain/games.ts:190-258` (`playMove`), `apps/server/src/domain/games.ts:90-136` (`finishGame`)
- Test: `apps/server/test/integration/engine-move-flow.test.ts`

**Interfaces:**
- Consumes: `isEngineGame`, `enqueueEngineMove`, `getEngineUser` (Tasks 3, 4).
- Produces: no new exports. `playMove` now nulls the deadline when the engine is next to move, enqueues `engine_move`, and skips the card and DM; `finishGame` skips the card and the Lichess import for engine games.

- [ ] **Step 1: Write the failing tests**

Create `apps/server/test/integration/engine-move-flow.test.ts`. The clockless case is Review Focus 2.

```ts
it('leaves no deadline for the engine and enqueues its move, with no card or DM job', async () => {
  const game = await createEngineGame(deps, {
    groupId: group.id, userId: alice.id, level: 'club', colour: 'white', timePerMove: 86_400,
  });
  await playMove(deps, {
    gameId: game.publicId, userId: alice.id, uci: 'e2e4', expectedPly: 0, clientMoveId: 'c1',
  });
  const after = await requireGameByPublicId(db, game.publicId);
  expect(after.deadlineAt).toBeNull();
  expect(after.reminderAt).toBeNull();
  const kinds = (await db.select().from(jobs)).map((job) => job.kind);
  expect(kinds).toContain('engine_move');
  expect(kinds).not.toContain('edit_card');
  expect(kinds).not.toContain('send_dm');
});

it('gives the human a deadline again once the engine has moved', async () => {
  const game = await createEngineGame(deps, {
    groupId: group.id, userId: alice.id, level: 'club', colour: 'white', timePerMove: 86_400,
  });
  await playMove(deps, {
    gameId: game.publicId, userId: alice.id, uci: 'e2e4', expectedPly: 0, clientMoveId: 'c1',
  });
  const engine = await getEngineUser(db);
  await playMove(deps, {
    gameId: game.publicId, userId: engine.id, uci: 'e7e5', expectedPly: 1, clientMoveId: 'e1',
  });
  const after = await requireGameByPublicId(db, game.publicId);
  expect(after.deadlineAt).not.toBeNull();
});

it('keeps a clockless engine game clockless for both sides', async () => {
  const game = await createEngineGame(deps, {
    groupId: group.id, userId: alice.id, level: 'club', colour: 'white', timePerMove: null,
  });
  await playMove(deps, {
    gameId: game.publicId, userId: alice.id, uci: 'e2e4', expectedPly: 0, clientMoveId: 'c1',
  });
  const engine = await getEngineUser(db);
  await playMove(deps, {
    gameId: game.publicId, userId: engine.id, uci: 'e7e5', expectedPly: 1, clientMoveId: 'e1',
  });
  const after = await requireGameByPublicId(db, game.publicId);
  expect(after.deadlineAt).toBeNull();
});

it('is never forfeited even with a deadline long past', async () => {
  const game = await createEngineGame(deps, {
    groupId: group.id, userId: alice.id, level: 'club', colour: 'black', timePerMove: 86_400,
  });
  await db.update(games).set({ deadlineAt: new Date(Date.now() - 86_400_000) })
    .where(eq(games.id, game.id));
  await forfeitOverdueGames(deps);
  expect((await requireGameByPublicId(db, game.publicId)).status).toBe('active');
});

it('writes no rating row and no Lichess import job when an engine game ends', async () => {
  const game = await createEngineGame(deps, {
    groupId: group.id, userId: alice.id, level: 'club', colour: 'white', timePerMove: 86_400,
  });
  await resign(deps, { gameId: game.publicId, userId: alice.id });
  const finished = await requireGameByPublicId(db, game.publicId);
  expect(finished.status).toBe('finished');
  expect(finished.lichessImportStatus).toBeNull();
  expect(await db.select().from(ratings)).toHaveLength(0);
  expect((await db.select().from(jobs)).map((job) => job.kind)).not.toContain('lichess_import');
});
```

Check `resign`'s exact signature in `apps/server/src/domain/games.ts:259` and match it.

- [ ] **Step 2: Run them to make sure they fail**

Run: `TEST_DATABASE_URL=… pnpm --filter @group-chess/server exec vitest run test/integration/engine-move-flow.test.ts`
Expected: FAIL — the deadline is set for the engine and `edit_card` is enqueued.

- [ ] **Step 3: Change playMove**

In `apps/server/src/domain/games.ts`, inside `playMove` after `const opponent = await requireUser(tx, opponentId);`:

```ts
    const engineNext = opponent.isEngine;
```

Change the `.set({ … })` of the `games` update so the two clock columns respect it:

```ts
        deadlineAt: engineNext ? null : deadlineExpression(timePerMove),
        reminderAt: engineNext ? null : reminderExpression(timePerMove, wantsDms(opponent)),
```

Then replace the two unconditional enqueues at the end of the transaction:

```ts
    if (engineNext) {
      // Spec §8: engine games post no card, and the engine has no DM to receive.
      await enqueueEngineMove(tx, moved);
    } else {
      if (!isEngineGame(moved)) {
        await enqueue(tx, {
          kind: 'edit_card',
          payload: { gameId: game.id },
          dedupKey: `card:g:${game.publicId}`,
        });
      }
      await enqueue(tx, {
        kind: 'send_dm',
        payload: { userId: opponentId, template: 'turn', gameId: game.id },
        dedupKey: `dm:${opponentId}:g:${game.publicId}:turn:${ply}`,
      });
    }
```

Import `enqueueEngineMove` and `isEngineGame` from `./engineGames`.

- [ ] **Step 4: Change finishGame**

In the same file, make the card and the import conditional. Replace the `importable` line and the `edit_card` enqueue:

```ts
  // Spec §8: engine games post no card and are never imported — the Lichess quota is shared across
  // the deployment and these games have no human opponent.
  const engineGame = isEngineGame(game);
  const importable = game.plyCount > 0 && end.endReason !== 'voided' && !engineGame;
```

and wrap the `edit_card` enqueue in `if (!engineGame) { … }`. Leave the two `send_dm` game_end enqueues alone: the handler already skips users with no Telegram id, and the human still wants theirs.

- [ ] **Step 5: Run them to make sure they pass**

Run: `TEST_DATABASE_URL=… pnpm --filter @group-chess/server exec vitest run test/integration/engine-move-flow.test.ts`
Expected: PASS

- [ ] **Step 6: Run the whole suite — this touched the move transaction**

Run: `export TEST_DATABASE_URL=… && pnpm test`
Expected: PASS. Every existing human-game test must still pass; a failure here means a conditional leaked into the human path.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/domain/games.ts apps/server/test/integration/engine-move-flow.test.ts
git commit -m "feat: skip cards, DMs, imports and deadlines for the engine side"
```

---

### Task 6: The engine_move job handler

**Files:**
- Create: `apps/server/src/jobs/handlers/engine.ts`
- Modify: `apps/server/src/jobs/handlers/index.ts`, `apps/server/src/main.ts:105-118`, `apps/server/src/metrics.ts`
- Test: `apps/server/test/integration/engine-job.test.ts`

**Interfaces:**
- Consumes: `Engine`, `BestMove` (Task 1); `playMove`, `requireGameById`, `abortGame` from `../../domain/games`; `getEngineUser` (Task 3); `legalDests` from `@group-chess/shared`.
- Produces: `engineJobHandlers(ctx: EngineHandlerContext): JobHandlers` where `EngineHandlerContext = { deps: Deps; engine: Engine; config: Config; metrics: Metrics }`; metrics `engineMoves`, `engineMoveFailures`, `engineIllegalMoves`, `engineMoveDuration`, `engineAvailable`.

- [ ] **Step 1: Write the failing tests**

Create `apps/server/test/integration/engine-job.test.ts`. Cases 3 and 5 are Review Focus 3 and 5.

```ts
it('plays the engine reply and hands the turn back', async () => {
  const engine = fakeEngine({ replies: [{ uci: 'e7e5' }] });
  const game = await startedEngineGame('white');           // helper defined in this file
  await playMove(deps, { gameId: game.publicId, userId: alice.id, uci: 'e2e4', expectedPly: 0, clientMoveId: 'c1' });
  await runEngineJob(engine, game.id);                     // helper: invokes the handler directly
  const after = await requireGameByPublicId(db, game.publicId);
  expect(after.plyCount).toBe(2);
  expect(engine.calls[0]!.level).toBe('club');
});

it('substitutes a legal move when the engine returns an illegal one, and counts it', async () => {
  const engine = fakeEngine({ replies: [{ uci: 'a1a8' }] });
  const game = await startedEngineGame('white');
  await playMove(deps, { gameId: game.publicId, userId: alice.id, uci: 'e2e4', expectedPly: 0, clientMoveId: 'c1' });
  await runEngineJob(engine, game.id);
  const after = await requireGameByPublicId(db, game.publicId);
  expect(after.status).toBe('active');
  expect(after.plyCount).toBe(2);
  const counted = await metrics.engineIllegalMoves.get();
  expect(counted.values[0]?.value).toBe(1);
});

it('completes without moving when the game already ended', async () => {
  const engine = fakeEngine();
  const game = await startedEngineGame('white');
  await playMove(deps, { gameId: game.publicId, userId: alice.id, uci: 'e2e4', expectedPly: 0, clientMoveId: 'c1' });
  await resign(deps, { gameId: game.publicId, userId: alice.id });
  await expect(runEngineJob(engine, game.id)).resolves.toMatchObject({ outcome: 'done' });
  expect(engine.calls).toHaveLength(0);
  expect((await requireGameByPublicId(db, game.publicId)).plyCount).toBe(1);
});

it('completes without moving when the engine reports a terminal position', async () => {
  const engine = fakeEngine({ replies: [{ none: true }] });
  const game = await startedEngineGame('white');
  await playMove(deps, { gameId: game.publicId, userId: alice.id, uci: 'e2e4', expectedPly: 0, clientMoveId: 'c1' });
  await expect(runEngineJob(engine, game.id)).resolves.toMatchObject({ outcome: 'done' });
  expect((await requireGameByPublicId(db, game.publicId)).plyCount).toBe(1);
});

it('asks for a retry, not silence, when the engine is unavailable', async () => {
  const engine = fakeEngine({ fail: new Error('spawn stockfish ENOENT') });
  const game = await startedEngineGame('white');
  await playMove(deps, { gameId: game.publicId, userId: alice.id, uci: 'e2e4', expectedPly: 0, clientMoveId: 'c1' });
  const result = await runEngineJob(engine, game.id);
  expect(result).toMatchObject({ outcome: 'retry_attempt' });
  expect((await requireGameByPublicId(db, game.publicId)).status).toBe('active');
});

it('aborts the game once the retry ladder is exhausted', async () => {
  const engine = fakeEngine({ fail: new Error('spawn stockfish ENOENT') });
  const game = await startedEngineGame('white');
  await playMove(deps, { gameId: game.publicId, userId: alice.id, uci: 'e2e4', expectedPly: 0, clientMoveId: 'c1' });
  const result = await runEngineJob(engine, game.id, { attempts: 8, maxAttempts: 8 });
  expect(result).toMatchObject({ outcome: 'fail' });
  expect((await requireGameByPublicId(db, game.publicId)).status).toBe('finished');
});

it('plays only once when the same ply is triggered twice', async () => {
  const engine = fakeEngine({ replies: [{ uci: 'e7e5' }, { uci: 'd7d5' }] });
  const game = await startedEngineGame('white');
  await playMove(deps, { gameId: game.publicId, userId: alice.id, uci: 'e2e4', expectedPly: 0, clientMoveId: 'c1' });
  await runEngineJob(engine, game.id);
  await runEngineJob(engine, game.id);
  expect((await requireGameByPublicId(db, game.publicId)).plyCount).toBe(2);
});
```

Write `startedEngineGame(colour)` as a local helper calling `createEngineGame`, and `runEngineJob(engine, gameId, jobOverrides?)` as a local helper that builds a `JobRow`-shaped object (copy the shape from `apps/server/test/integration/handlers.test.ts`) and calls `engineJobHandlers({ deps, engine, config, metrics }).engine_move!({ job, db, log })`.

- [ ] **Step 2: Run them to make sure they fail**

Run: `TEST_DATABASE_URL=… pnpm --filter @group-chess/server exec vitest run test/integration/engine-job.test.ts`
Expected: FAIL — `engineJobHandlers` does not exist.

- [ ] **Step 3: Add the metrics**

`Metrics` is a class whose counters are `readonly` fields built by its private `this.counter(...)`
helper. Add these as fields beside `miniappMoveFailures`, using that helper for the counters and the
same explicit form the class already uses for `moveLatency` and `sseStreams`:

```ts
  readonly engineMoves = this.counter('engine_moves_total', 'Engine moves played');
  readonly engineMoveFailures = this.counter(
    'engine_move_failures_total',
    'Engine move attempts that failed',
  );
  readonly engineIllegalMoves = this.counter(
    'engine_illegal_moves_total',
    'Illegal moves returned by the engine; alert on any increment',
  );
  readonly engineMoveDuration = new Histogram({
    name: 'engine_move_duration_seconds',
    help: 'Time to obtain an engine move',
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });
  readonly engineAvailable = new Gauge({
    name: 'engine_available',
    help: '1 when the engine binary answered at boot',
    registers: [this.registry],
  });
```

`Histogram` and `Gauge` are already imported in that file.

- [ ] **Step 4: Write the handler**

Create `apps/server/src/jobs/handlers/engine.ts`:

```ts
import { legalDests, sideToMove, type EngineLevel } from '@group-chess/shared';
import { z } from 'zod';
import type { Config } from '../../config';
import type { Deps } from '../../domain/deps';
import { getEngineUser } from '../../domain/engineGames';
import { abortGame, playMove, requireGameById } from '../../domain/games';
import type { GameRow } from '../../db/schema';
import type { Engine } from '../../engine/engine';
import type { Metrics } from '../../metrics';
import type { JobHandlers, JobResult } from '../types';

export type EngineHandlerContext = {
  deps: Deps;
  engine: Engine;
  config: Config;
  metrics: Metrics;
};

const PayloadSchema = z.object({ gameId: z.number().int() });

/** A uniformly random legal move, used only to recover from an illegal engine reply (spec §9, E7). */
function randomLegalMove(fen: string): string | null {
  const dests = [...legalDests(fen).entries()];
  if (dests.length === 0) return null;
  const [from, targets] = dests[Math.floor(Math.random() * dests.length)]!;
  const to = targets[Math.floor(Math.random() * targets.length)]!;
  // A pawn reaching the last rank must carry a promotion piece or the arbiter rejects the move.
  const promoting = /^[a-h]([27])$/.test(from) && /^[a-h](1|8)$/.test(to);
  return promoting ? `${from}${to}q` : `${from}${to}`;
}

/**
 * Spec §9: a sustained outage must not leave the game dead — but it must not become a random mover
 * either, since the player was told which level they chose. Aborted, not lost: the failure is ours,
 * and the game was unrated anyway.
 */
async function abortForUnavailableEngine(
  deps: Deps,
  game: GameRow,
  reason: string,
): Promise<JobResult> {
  const engineUser = await getEngineUser(deps.db);
  await abortGame(deps, { gameId: game.publicId, userId: engineUser.id });
  return { outcome: 'fail', error: reason };
}

export function engineJobHandlers(ctx: EngineHandlerContext): JobHandlers {
  const { deps, engine, config, metrics } = ctx;
  return {
    engine_move: async ({ job, log }): Promise<JobResult> => {
      const { gameId } = PayloadSchema.parse(job.payload);
      const game = await requireGameById(deps.db, gameId);
      if (game.status !== 'active' || game.engineLevel === null) return { outcome: 'done' };
      // Registered even when disabled, on purpose: an unhandled kind is retried forever without
      // counting an attempt (`jobs/worker.ts:119`), so a game started before the engine was turned
      // off would stall for ever instead of reaching §9's abort.
      if (!config.ENGINE_ENABLED) {
        metrics.engineMoveFailures.inc();
        return job.attempts + 1 >= job.maxAttempts
          ? await abortForUnavailableEngine(deps, game, 'the engine is disabled')
          : { outcome: 'retry_attempt', delayMs: 30_000, error: 'the engine is disabled' };
      }
      const engineUser = await getEngineUser(deps.db);
      const engineColour = game.whiteId === engineUser.id ? 'white' : 'black';
      if (sideToMove(game.fen) !== engineColour) return { outcome: 'done' };

      const started = process.hrtime.bigint();
      let reply;
      try {
        reply = await engine.bestMove(
          game.fen,
          game.engineLevel as EngineLevel,
          Math.max(config.ENGINE_MOVETIME_MS * 10, 5_000),
        );
      } catch (error) {
        metrics.engineMoveFailures.inc();
        const message = error instanceof Error ? error.message : String(error);
        if (job.attempts + 1 >= job.maxAttempts) {
          log.error({ gameId, err: error }, 'engine unavailable; aborting the game');
          return abortForUnavailableEngine(deps, game, message);
        }
        return { outcome: 'retry_attempt', delayMs: 5_000, error: message };
      } finally {
        metrics.engineMoveDuration.observe(Number(process.hrtime.bigint() - started) / 1e9);
      }
      if ('none' in reply) return { outcome: 'done' };

      let uci = reply.uci;
      try {
        await playMove(deps, {
          gameId: game.publicId,
          userId: engineUser.id,
          uci,
          expectedPly: game.plyCount,
          clientMoveId: `engine:${game.publicId}:${game.plyCount}`,
        });
      } catch (error) {
        const illegal = error instanceof Error && /illegal move/.test(error.message);
        if (!illegal) throw error;
        // Stockfish does not emit illegal moves, so this is almost certainly a bug in our own UCI
        // parsing. Recover so the game survives, but make sure it is visible (spec §9).
        metrics.engineIllegalMoves.inc();
        log.error({ gameId, fen: game.fen, bestmove: uci }, 'engine returned an illegal move');
        const fallback = randomLegalMove(game.fen);
        if (!fallback) return { outcome: 'done' };
        uci = fallback;
        await playMove(deps, {
          gameId: game.publicId,
          userId: engineUser.id,
          uci,
          expectedPly: game.plyCount,
          clientMoveId: `engine:${game.publicId}:${game.plyCount}:fallback`,
        });
      }
      metrics.engineMoves.inc();
      return { outcome: 'done' };
    },
  };
}
```

Check `abortGame`'s real signature at `apps/server/src/domain/games.ts:274` and match it; if it refuses a non-player or a particular state, use the call that ends the game as aborted with the engine as the actor.

- [ ] **Step 5: Wire it into main.ts**

In `apps/server/src/main.ts`, before the `JobWorker` construction:

```ts
  const engine = uciEngine(config);
  if (has('jobs') && config.ENGINE_ENABLED) {
    const probed = await engine.probe();
    metrics.engineAvailable.set(probed.available ? 1 : 0);
    if (!probed.available) {
      // Spec §9: a missing binary must not take down human correspondence games.
      log.error('the engine binary did not answer; bot games will queue and then abort');
    } else {
      log.info({ version: probed.version }, 'engine available');
    }
  }
```

and add to the `handlers` object — unconditionally, since the handler itself owns the disabled case:

```ts
        ...engineJobHandlers({ deps, engine, config, metrics }),
```

Export `engineJobHandlers` from `apps/server/src/jobs/handlers/index.ts` beside the others, and import `uciEngine` from `./engine/uci`.

- [ ] **Step 6: Run the tests to make sure they pass**

Run: `TEST_DATABASE_URL=… pnpm --filter @group-chess/server exec vitest run test/integration/engine-job.test.ts`
Expected: PASS

- [ ] **Step 7: Run every gate**

Run: `export TEST_DATABASE_URL=… && pnpm typecheck && pnpm lint && pnpm test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/jobs apps/server/src/main.ts apps/server/src/metrics.ts apps/server/test/integration/engine-job.test.ts
git commit -m "feat: add the engine_move job handler with illegal-move recovery"
```

---

### Task 7: The API endpoint and the picker DTO

**Files:**
- Modify: `packages/shared/src/protocol/dto.ts`, `packages/shared/src/protocol/requests.ts`
- Modify: `apps/server/src/api/routes/groups.ts:34-40`
- Test: `apps/server/test/integration/api-engine.test.ts`

**Interfaces:**
- Consumes: `createEngineGame` (Task 4); `EngineLevelSchema`, `ENGINE_LEVELS` (Task 1); `GameDtoSchema`, `requireMember`.
- Produces: `EngineGameRequestSchema` / `EngineGameRequest` (`{ level: EngineLevel; colour: ColourChoice; timePerMove: TimePerMove }`); `PlayersPickerDto.bot` of type `{ levels: EngineLevel[] } | null`; route `POST /api/groups/:g/engine-games`.

- [ ] **Step 1: Write the failing tests**

Create `apps/server/test/integration/api-engine.test.ts`, copying the authenticated-request preamble from `apps/server/test/integration/api-games.test.ts`.

```ts
it('offers the bot and its levels in the picker, and never as a player', async () => {
  const body = await getJson(`/api/groups/${group.publicId}/players`);
  expect(body.bot).toEqual({ levels: ['beginner', 'casual', 'club', 'strong'] });
  const engine = await getEngineUser(db);
  expect(body.players.map((player) => player.id)).not.toContain(String(engine.id));
});

it('creates a game and returns it', async () => {
  const response = await post(`/api/groups/${group.publicId}/engine-games`, {
    level: 'club', colour: 'white', timePerMove: 86_400,
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.rated).toBe(false);
});

it('refuses an unknown level with a 4xx, not a 500', async () => {
  const response = await post(`/api/groups/${group.publicId}/engine-games`, {
    level: 'grandmaster', colour: 'white', timePerMove: 86_400,
  });
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(response.status).toBeLessThan(500);
});

it('refuses a caller who is not a member of the group', async () => {
  const response = await postAs(outsider, `/api/groups/${group.publicId}/engine-games`, {
    level: 'club', colour: 'white', timePerMove: 86_400,
  });
  expect(response.status).toBe(403);
});

it('hides the bot when the engine is switched off', async () => {
  // Rebuild the API context with ENGINE_ENABLED false, the way the neighbouring tests vary config.
  const body = await getJson(`/api/groups/${group.publicId}/players`);
  expect(body.bot).toBeNull();
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `TEST_DATABASE_URL=… pnpm --filter @group-chess/server exec vitest run test/integration/api-engine.test.ts`
Expected: FAIL — `bot` is not in the DTO and the route is a 404.

- [ ] **Step 3: Extend the protocol**

In `packages/shared/src/protocol/dto.ts`, replace the picker schema. The bot is deliberately not a `PlayerRef`, so no screen can render it as a human (spec §8):

```ts
export const PlayersPickerDtoSchema = z.object({
  players: z.array(PlayerRefSchema),
  /** null when the engine is unavailable or switched off. */
  bot: z.object({ levels: z.array(EngineLevelSchema) }).nullable(),
});
```

Import `EngineLevelSchema` from `./enums`. In `packages/shared/src/protocol/requests.ts`:

```ts
export const EngineGameRequestSchema = z.object({
  level: EngineLevelSchema,
  colour: ColourChoiceSchema,
  timePerMove: TimePerMoveSchema,
});

export type EngineGameRequest = z.infer<typeof EngineGameRequestSchema>;
```

- [ ] **Step 4: Extend the routes**

In `apps/server/src/api/routes/groups.ts`, change the players route and add the new one:

```ts
  api.get('/groups/:g/players', async (c) => {
    const group = await memberGroup(c);
    const body: PlayersPickerDto = {
      players: await listKnownPlayers(db, group.id, { excludeUserId: c.get('user').id }),
      bot: ctx.config.ENGINE_ENABLED ? { levels: [...ENGINE_LEVELS] } : null,
    };
    return c.json(body);
  });

  api.post('/groups/:g/engine-games', validate('json', EngineGameRequestSchema), async (c) => {
    const group = await memberGroup(c);
    const body = c.req.valid('json');
    const game = await createEngineGame(ctx.deps, {
      groupId: group.id,
      userId: c.get('user').id,
      level: body.level,
      colour: body.colour,
      timePerMove: body.timePerMove,
    });
    return c.json(await getGameDto(db, game.publicId, c.get('user').id));
  });
```

If `ApiContext` does not already carry `config`, add it — check `apps/server/src/api/context.ts` and thread it from `main.ts` the way `membership` is. `listKnownPlayers` needs no change: the engine has no `group_members` row, so it cannot appear there.

- [ ] **Step 5: Run them to make sure they pass**

Run: `TEST_DATABASE_URL=… pnpm --filter @group-chess/server exec vitest run test/integration/api-engine.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/shared apps/server/src/api apps/server/test/integration/api-engine.test.ts
git commit -m "feat: expose the bot in the picker and add the engine-games endpoint"
```

---

### Task 8: Draw offers and rematch in engine games

Two paths reach an engine game from the game screen and both are wrong by default. `POST /api/games/:id/rematch` calls `createRematch`, which creates a *challenge* — against an opponent that never accepts, and with a `send_challenge_card` job that posts to the group, violating spec §8 twice. `offerDraw` records an offer nobody will ever answer. Spec §8 requires the bot to decline every draw offer and a rematch to create a new engine game directly.

**Files:**
- Modify: `packages/shared/src/protocol/dto.ts` (`GameDtoSchema`), `apps/server/src/domain/gameDto.ts`
- Modify: `apps/server/src/domain/draws.ts:27-53` (`offerDraw`)
- Modify: `apps/server/src/domain/challenges.ts` (`createRematch`)
- Modify: `apps/server/src/jobs/handlers/engine.ts` (Task 6)
- Test: `apps/server/test/integration/engine-draws-rematch.test.ts`

**Interfaces:**
- Consumes: `isEngineGame`, `enqueueEngineMove` (Tasks 3, 4); `declineDraw` from `../../domain/draws`.
- Produces: `GameDto.engineLevel` of type `EngineLevel | null`, which Task 9 uses to label the opponent and to rematch at the same level.

- [ ] **Step 1: Write the failing tests**

Create `apps/server/test/integration/engine-draws-rematch.test.ts`, with the same preamble as the other integration tests.

```ts
it('carries the level in the game DTO so the app can label and rematch', async () => {
  const game = await createEngineGame(deps, {
    groupId: group.id, userId: alice.id, level: 'strong', colour: 'white', timePerMove: 86_400,
  });
  const dto = await getGameDto(db, game.publicId, alice.id);
  expect(dto.engineLevel).toBe('strong');
});

it('leaves engineLevel null on a human game', async () => {
  const game = await insertGame(db, group.id, alice.id, bob.id, { fen: INITIAL_FEN });
  expect((await getGameDto(db, game.publicId, alice.id)).engineLevel).toBeNull();
});

it('has the bot decline a draw offer rather than leaving it pending', async () => {
  const engine = fakeEngine({ replies: [{ uci: 'e7e5' }] });
  const game = await createEngineGame(deps, {
    groupId: group.id, userId: alice.id, level: 'club', colour: 'white', timePerMove: 86_400,
  });
  await playMove(deps, { gameId: game.publicId, userId: alice.id, uci: 'e2e4', expectedPly: 0, clientMoveId: 'c1' });
  await offerDraw(deps, { gameId: game.publicId, userId: alice.id });
  expect((await requireGameByPublicId(db, game.publicId)).drawOfferBy).not.toBeNull();
  await runEngineJob(engine, game.id);
  const after = await requireGameByPublicId(db, game.publicId);
  expect(after.drawOfferBy).toBeNull();
  expect(after.status).toBe('active');
});

it('declines the offer even when it is the human to move, so no offer is left hanging', async () => {
  const engine = fakeEngine({ replies: [{ uci: 'e7e5' }] });
  const game = await createEngineGame(deps, {
    groupId: group.id, userId: alice.id, level: 'club', colour: 'white', timePerMove: 86_400,
  });
  await offerDraw(deps, { gameId: game.publicId, userId: alice.id });
  await runEngineJob(engine, game.id);
  const after = await requireGameByPublicId(db, game.publicId);
  expect(after.drawOfferBy).toBeNull();
  expect(after.plyCount).toBe(0);
  expect(engine.calls).toHaveLength(0);
});

it('refuses a rematch challenge for an engine game, creating no challenge and no card job', async () => {
  const game = await createEngineGame(deps, {
    groupId: group.id, userId: alice.id, level: 'club', colour: 'white', timePerMove: 86_400,
  });
  await resign(deps, { gameId: game.publicId, userId: alice.id });
  await expect(createRematch(deps, { gameId: game.id, userId: alice.id })).rejects.toBeInstanceOf(
    DomainError,
  );
  expect(await db.select().from(challenges)).toHaveLength(0);
  expect((await db.select().from(jobs)).map((job) => job.kind)).not.toContain(
    'send_challenge_card',
  );
});
```

Reuse `runEngineJob` from Task 6's test file by exporting it from a shared helper, or copy it — do not import across test files if the project does not already do that.

- [ ] **Step 2: Run them to make sure they fail**

Run: `TEST_DATABASE_URL=… pnpm --filter @group-chess/server exec vitest run test/integration/engine-draws-rematch.test.ts`
Expected: FAIL — `engineLevel` is not on the DTO, and `createRematch` happily creates a challenge.

- [ ] **Step 3: Add engineLevel to the game DTO**

In `packages/shared/src/protocol/dto.ts`, inside `GameDtoSchema`:

```ts
  /** The bot level when this is a game against the bot, otherwise null. */
  engineLevel: EngineLevelSchema.nullable(),
```

In `apps/server/src/domain/gameDto.ts`, map it in the function that builds the DTO from the row:

```ts
    engineLevel: game.engineLevel,
```

- [ ] **Step 4: Make an offer against the bot summon a decline**

In `apps/server/src/domain/draws.ts`, at the end of `offerDraw`'s transaction, after the update and before `return loadGameDto(tx, updated, input.userId);`:

```ts
    // Spec §8: the bot declines every offer. Enqueueing the engine job rather than declining inline
    // keeps one decline path, so the human sees the normal declined state over SSE.
    if (isEngineGame(updated)) await enqueueEngineMove(tx, updated);
```

Import `isEngineGame` and `enqueueEngineMove` from `./engineGames`. The offer is still recorded first, so the existing per-colour throttle (`lastDrawOfferPlyWhite`/`Black`) still stops repeat offers.

- [ ] **Step 5: Decline before considering a move in the handler**

In `apps/server/src/jobs/handlers/engine.ts`, immediately after the `sideToMove` guard is reached — but *before* it returns — restructure so the decline runs regardless of whose turn it is. Replace the turn guard with:

```ts
      const engineColour = game.whiteId === engineUser.id ? 'white' : 'black';
      // Spec §8: decline first, whosever turn it is, so an offer made on the human's turn is not
      // left pending until they happen to move.
      if (game.drawOfferBy !== null && game.drawOfferBy !== engineColour) {
        await declineDraw(deps, { gameId: game.publicId, userId: engineUser.id });
      }
      if (sideToMove(game.fen) !== engineColour) return { outcome: 'done' };
```

Import `declineDraw` from `../../domain/draws`. Note the handler reloads nothing after the decline: `declineDraw` only clears the offer columns, and `playMove` re-reads the game under its own lock.

- [ ] **Step 6: Refuse a rematch challenge for engine games**

In `apps/server/src/domain/challenges.ts`, in `createRematch`, after the `game.status !== 'finished'` check:

```ts
  // Spec §8: a bot rematch is a new engine game, created by the app through POST
  // /groups/:g/engine-games. Going through a challenge would post a card to the group and wait for
  // an acceptance that never comes.
  if (game.engineLevel !== null) {
    throw new DomainError('validation', 'use a new bot game for a rematch', {
      reason: 'engine_game',
    });
  }
```

- [ ] **Step 7: Run them to make sure they pass**

Run: `TEST_DATABASE_URL=… pnpm --filter @group-chess/server exec vitest run test/integration/engine-draws-rematch.test.ts`
Expected: PASS

- [ ] **Step 8: Run every gate — the DTO change touches the Mini App types**

Run: `export TEST_DATABASE_URL=… && pnpm typecheck && pnpm test`
Expected: PASS. A typecheck failure in the Mini App means a screen builds a `GameDto` literal that now needs `engineLevel`.

- [ ] **Step 9: Commit**

```bash
git add packages/shared apps/server/src apps/server/test/integration/engine-draws-rematch.test.ts
git commit -m "feat: decline bot draw offers and keep rematches out of challenges"
```

---

### Task 9: The Mini App

**Files:**
- Modify: `apps/miniapp/src/ui/screens/NewGame.tsx`
- Modify: `apps/miniapp/src/ui/game/GameView.tsx:294-300` (the rematch handler)
- Modify: `packages/shared/src/i18n/en.ts` (the `app.new.*` keys are around line 133)
- Test: `apps/miniapp/test/newGame.test.tsx` (create if absent)

**Interfaces:**
- Consumes: `PlayersPickerDto.bot`, `EngineGameRequest`, `ENGINE_LEVELS` (Tasks 1, 7); `GameDto.engineLevel` (Task 8).
- Produces: no new exports.

- [ ] **Step 1: Add the copy**

In `packages/shared/src/i18n/en.ts`, beside the existing `app.new.*` keys. The wording is constrained by the spec's §7: no rating numbers, and "the easiest level" is allowed where "suitable for beginners" is not.

```ts
  'app.new.bot': 'Play the bot',
  'app.new.bot_level': 'Bot level',
  'app.new.bot_unrated': 'Games against the bot are unrated.',
  'app.level.beginner': 'Easiest',
  'app.level.casual': 'Casual',
  'app.level.club': 'Club',
  'app.level.strong': 'Strong',
```

- [ ] **Step 2: Write the failing test**

Create `apps/miniapp/test/newGame.test.tsx`, copying the render/mock preamble from an existing screen test in `apps/miniapp/test/`.

```tsx
it('shows the bot row and its levels when the picker offers one', async () => {
  const { getByText } = renderNewGame({ players: [], bot: { levels: [...ENGINE_LEVELS] } });
  expect(getByText('Play the bot')).toBeTruthy();
  expect(getByText('Club')).toBeTruthy();
});

it('shows no bot row when the picker offers none', async () => {
  const { queryByText } = renderNewGame({ players: [], bot: null });
  expect(queryByText('Play the bot')).toBeNull();
});

it('forces rated off and disables the switch once the bot is selected', async () => {
  const { getByTestId, container } = renderNewGame({ players: [], bot: { levels: [...ENGINE_LEVELS] } });
  getByTestId('opponent-bot').click();
  const rated = container.querySelector('[data-rated] input') as HTMLInputElement;
  expect(rated.checked).toBe(false);
  expect(rated.disabled).toBe(true);
});

it('shows no rating number anywhere in the level control', () => {
  const { container } = renderNewGame({ players: [], bot: { levels: [...ENGINE_LEVELS] } });
  expect(container.textContent).not.toMatch(/\b\d{3,4}\b/);
});

it('posts to the engine-games endpoint with the chosen level', async () => {
  const post = vi.fn().mockResolvedValue({});
  const { getByTestId } = renderNewGame({ players: [], bot: { levels: [...ENGINE_LEVELS] } }, { post });
  getByTestId('opponent-bot').click();
  getByTestId('bot-level-strong').click();
  getByTestId('send').click();
  await vi.waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      expect.stringContaining('/engine-games'),
      expect.objectContaining({ level: 'strong' }),
      expect.anything(),
    ),
  );
});
```

The fourth case pins the spec's §7 requirement 1 — it is the test that fails if anyone later "helpfully" labels the levels with Elo numbers.

- [ ] **Step 3: Run it to make sure it fails**

Run: `pnpm --filter @group-chess/miniapp exec vitest run test/newGame.test.tsx`
Expected: FAIL — no bot row exists.

- [ ] **Step 4: Implement the screen changes**

In `apps/miniapp/src/ui/screens/NewGame.tsx`:

- Widen the selection state: `const [opponentId, setOpponentId] = useState<string | null | undefined>(undefined)` stays for humans; add `const [bot, setBot] = useState<EngineLevel | null>(null)`. Selecting the bot row sets `bot` to the first level and leaves `opponentId` as `undefined`; selecting any human or the open-challenge row sets `bot` to `null`.
- Render the bot row above the human rows, only when `players.data.bot` is non-null, with `data-testid="opponent-bot"`.
- When `bot !== null`, render a level list below it using the same `class="row"` pattern as the time options, each with `data-testid={`bot-level-${level}`}` and the label `t(`app.level.${level}`)`. Show `t('app.new.bot_unrated')` as a `class="hint"` line.
- `ready` becomes `(opponentId !== undefined || bot !== null) && !sending`.
- In `submit`, branch: when `bot !== null`, `await client.post(`/api/groups/${props.groupId}/engine-games`, { level: bot, colour, timePerMove }, GameDtoSchema)` and navigate to the new game; otherwise keep the existing challenge call unchanged.
- Pass `disabled={bot !== null}` to the rated `Switch` and force its value to `false` while the bot is selected. Check `apps/miniapp/src/ui/controls.tsx` for whether `Switch` accepts `disabled`; add the prop there if it does not.

- [ ] **Step 5: Run it to make sure it passes**

Run: `pnpm --filter @group-chess/miniapp exec vitest run test/newGame.test.tsx`
Expected: PASS

- [ ] **Step 6: Point the rematch button at a new bot game**

Task 8 made the server refuse `POST /api/games/:id/rematch` for an engine game, so the existing
button would now show an error. In `apps/miniapp/src/ui/game/GameView.tsx`, branch the `rematch`
handler on the DTO's new field:

```tsx
  const rematch = async (): Promise<void> => {
    try {
      if (game.engineLevel !== null) {
        const next = await client.post(
          `/api/groups/${game.groupId}/engine-games`,
          { level: game.engineLevel, colour: 'random', timePerMove: game.timePerMove },
          GameDtoSchema,
        );
        router.replace({ name: 'game', gameId: next.id });
        return;
      }
      await client.post(`/api/games/${gameId}/rematch`, {});
      toast(t('app.game.rematch_sent'));
```

Read the surrounding function first: use whatever the DTO actually calls the group and game
identifiers, and whatever navigation call the rest of that file uses, rather than these names if they
differ. Add a test to `apps/miniapp/test/` for the branch if the file has a GameView test harness;
if it does not, the end-to-end suite in Task 10 covers it.

- [ ] **Step 7: Check the bundle budget**

Run: `pnpm build && pnpm check:budget`
Expected: PASS, still inside the 120 KB gzipped budget.

- [ ] **Step 8: Commit**

```bash
git add apps/miniapp packages/shared
git commit -m "feat: offer the bot and its levels on the new game screen"
```

---

### Task 10: Packaging, docs, and the PRD amendment

**Files:**
- Modify: `Dockerfile`, `.github/workflows/e2e.yml`, `docs/running.md`, `docs/operations.md`, `docs/testing.md`, `docs/PRD.md`, `README.md`, `.env.example`, `scripts/check-licences.mjs`
- Create: `scripts/assert-engine.mjs`

**Interfaces:**
- Consumes: `uciEngine` (Task 2), `ENGINE_*` config (Task 1).
- Produces: nothing importable.

- [ ] **Step 1: Write the build-time assertion script**

Create `scripts/assert-engine.mjs`. It asserts liveness and legality only — never which move (spec §11).

```js
// Fails the image build when the packaged Stockfish is missing, netless or unparseable by our
// adapter. Asserts only that a legal move comes back, so it holds across every Stockfish version.
import { Chess } from 'chess.js';
import { uciEngine } from '../apps/server/src/engine/uci.ts';

const FEN = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
const engine = uciEngine({ ENGINE_PATH: process.env.ENGINE_PATH ?? 'stockfish', ENGINE_MOVETIME_MS: 200 });

const probed = await engine.probe();
if (!probed.available) {
  console.error('stockfish did not complete the uci handshake');
  process.exit(1);
}
const reply = await engine.bestMove(FEN, 'club', 10_000);
if (!('uci' in reply)) {
  console.error('stockfish returned no move for a position with legal moves');
  process.exit(1);
}
const board = new Chess(FEN);
const legal = board.moves({ verbose: true }).some((move) => {
  const uci = `${move.from}${move.to}${move.promotion ?? ''}`;
  return uci === reply.uci;
});
if (!legal) {
  console.error(`stockfish move ${reply.uci} is not legal in the test position`);
  process.exit(1);
}
console.log(`engine ok: ${probed.version ?? 'unknown version'}, replied ${reply.uci}`);
```

- [ ] **Step 2: Install Stockfish in the runtime image and run the assertion**

In `Dockerfile`, in the `runtime` stage before `USER node`:

```dockerfile
# Spec §12: the engine opponent needs a UCI binary. Pin the version, and prove at build time that it
# answers our adapter with a legal move — a broken or netless binary must fail here, not in
# production. Stockfish is GPL-3.0, compatible with this repository's GPL-3.0-or-later.
RUN apt-get update \
    && apt-get install -y --no-install-recommends stockfish \
    && rm -rf /var/lib/apt/lists/*
```

Pin the version by replacing `stockfish` with `stockfish=<version>` once you have read what `node:22-bookworm-slim` offers — run `docker run --rm node:22-bookworm-slim sh -c 'apt-get update -qq && apt-cache policy stockfish'` and use the candidate version. Then, still in the build, run the assertion with the dev dependencies available (do this in the `build` stage where `chess.js` and `tsx` are installed, installing stockfish there too, if the `--prod` runtime install leaves `chess.js` out):

```dockerfile
RUN node --import tsx scripts/assert-engine.mjs
```

- [ ] **Step 3: Verify the image builds and the assertion runs**

Run: `docker build -t group-chess:engine .`
Expected: the build log contains `engine ok:` with a version. If `apt-get` cannot find `stockfish`, stop and follow the spec's §12 fallback — install an official build and configure its network file path — rather than removing the assertion.

- [ ] **Step 4: Extend the image smoke job**

In `.github/workflows/e2e.yml`, in the `docker` job's probe step, add a check that the engine reported available. No runner installs Stockfish; this runs inside the built image:

```bash
curl -fsS "http://127.0.0.1:3000/metrics" | grep -E '^engine_available 1$'
```

- [ ] **Step 5: Amend the PRD**

In `docs/PRD.md` §3, change the non-goal line to drop engine opponents while leaving the rest:

```markdown
- Puzzles, vote chess, tournaments, seasons, variants, achievements.
```

Reword goal 5 so the engine is not excluded, keeping its point:

```markdown
5. **Simple and permanent.** Standard chess, no takebacks.
```

Add below the non-goals list:

```markdown
An engine opponent was originally on this list and was deliberately added to the product on
2026-09-21; see
[docs/superpowers/specs/2026-09-21-engine-opponent-design.md](superpowers/specs/2026-09-21-engine-opponent-design.md).
The remaining items above are still out of scope, in particular any in-app analysis (§7.8).
```

Add a `### 7.13 Bot opponent — P1` subsection stating: any group member can play the bot at one of four levels; bot games are unrated and never enter the leaderboard; nothing about them is posted to the group chat; no rating numbers are shown for the levels.

- [ ] **Step 6: Update the operational and developer docs**

- `docs/operations.md`: add `ENGINE_ENABLED`, `ENGINE_PATH`, `ENGINE_MOVETIME_MS` to the variables, and alerts for any increment of `engine_illegal_moves_total`, for `engine_available` at 0 while enabled, and for a sustained `engine_move_failures_total` rate. Add a runbook line: a missing binary degrades bot games only and never affects human games.
- `docs/running.md`: a short section saying the bot needs Stockfish on `PATH` locally (`brew install stockfish` / `apt install stockfish`) and that `ENGINE_ENABLED=false` turns it off without affecting anything else.
- `docs/testing.md`: state that no CI runner installs Stockfish, that the suite runs on a fake engine, and that the real binary is covered only by the Dockerfile assertion and the image smoke job. Add the rule: no test asserts a specific engine move, an evaluation, or a level's strength.
- `README.md`: add the three variables to the configuration table.
- `.env.example`: add the three variables, commented, with `ENGINE_ENABLED=true`.
- `scripts/check-licences.mjs`: make the closing log line state that it covers npm dependencies only, and add a comment naming Stockfish as a documented non-npm GPL-3.0 dependency shipped in the image.

- [ ] **Step 7: Run every gate**

Run: `export TEST_DATABASE_URL=… && pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build && pnpm check:budget && pnpm check:licences`
Expected: PASS

- [ ] **Step 8: Run the end-to-end suite**

Run: `pnpm e2e`
Expected: PASS. The harness uses the fake engine, so no binary is needed.

- [ ] **Step 9: Commit**

```bash
git add Dockerfile scripts .github docs README.md .env.example
git commit -m "feat: package the engine binary, amend the PRD, document the bot"
```

---

## Notes for the executor

- **The spec is the authority.** Where this plan and the spec disagree, stop and ask rather than choosing.
- **One deviation from the spec is already decided.** Spec §5 says the engine gets a `group_members` row per group. It does not need one: `listKnownPlayers` inner-joins `group_members`, so having no row is what keeps the engine out of the opponent picker for free, and nothing else requires membership for a player in a game (`requireGameAccess` short-circuits for players, and `membership.verify` is only ever called on the authenticated caller). Task 3's third test pins this. The spec's §5 bullet should be corrected to match.
- **Do not add a `/playbot` command.** The spec's §8 covers the surface through the Mini App only; a bot command was considered and left out.
- **If the `apt` package does not exist or ignores `Skill Level`**, that is spec §13's risk materialising. Stop and report it: the fix is a spec decision, not an implementation choice.
- **Two spec requirements had no obvious home and became Task 8.** Spec §8's "the bot declines every draw offer" and "a rematch creates a new engine game directly" are both reachable from the game screen today, and left alone they would each produce a card in the group chat or an offer nobody answers. If you are tempted to skip Task 8 because it looks like polish, it is not: it is the difference between §8 holding and a dangling challenge appearing in a group.
- **`Switch` may not accept `disabled`.** Check `apps/miniapp/src/ui/controls.tsx` before Task 9 Step 4; adding the prop there is part of that task, not a separate one.
