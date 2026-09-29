# Flair Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make flair retroactive: a `backfill_flair` job, enqueued at boot for catalog flair whose backfill version is pending, credits every player with each flair at the first counted game that earns it.

**Architecture:** The catalog gains a `backfill` version per flair; a `flair_backfills` table records which versions have completed and replaces `flair_introductions`. Boot enqueues one job per pending set; the job walks each player's counted games with the existing `ruleHolds`, upserts the earliest qualifying game per flair without locking, sweeps deleted players, then records completion. Live awards drop the introduction window.

**Tech Stack:** TypeScript, pnpm workspaces, Drizzle ORM + drizzle-kit, PostgreSQL, Vitest, zod.

**Spec:** [docs/superpowers/specs/2026-09-29-flair-backfill-design.md](../specs/2026-09-29-flair-backfill-design.md). Read it before each task; section numbers below (§n) refer to it. "Flair spec" means [2026-09-29-flair-design.md](../specs/2026-09-29-flair-design.md).

## Global Constraints

- Integration tests need `TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/group_chess_test_flair_backfill`. Create that database once (`docker exec <db container> psql -U postgres -c "create database group_chess_test_flair_backfill"`); other worktrees share `group_chess_test` and truncate each other's rows.
- Run server tests with `pnpm vitest run --project @group-chess/server <path>` from the repo root; shared tests with `--project @group-chess/shared`.
- Backfill version: `flair.backfill ?? 1`; a `backfill` present in the catalog is an integer ≥ 2.
- Dedup key: `flair:backfill:` + pairs as `id@version`, sorted by id, joined with `,`.
- Older-build guard returns `{ outcome: 'retry', delayMs: 30_000 }`.
- The backfill never takes a row lock, never touches `users.flair_worn`, and never deletes a `user_flair` row except in the deleted-user sweep.
- Upsert moves an award only when `excluded.earned_at < user_flair.earned_at`.
- Code comments cite spec sections the way existing flair code does ("Backfill spec §4.2: …", "flair spec §1.3").
- Commit messages start `Flair backfill: ` and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- **A player with hundreds of counted games and no flair left to find.** The walk must stop as soon as the candidates are exhausted, and must not read moves for games where no `won`/`lost` candidate could hold. Pinned in Task 3 (move-load counting test).
- **A flair already held from a *later* game.** The backfill must move it to the earlier game, not insert a duplicate or leave it. The live award must not undo that on the next game (it skips held flair). Pinned in Task 4.
- **A game voided after the backfill credited it.** The award stays on the voided game (flair spec: voids keep flair), and a re-run of the backfill must not move it *later* to the next qualifying game. Pinned in Task 4 (the `<` guard).
- **Existing live-award tests assumed only the flair they introduced could be awarded.** With every flair a candidate, a test whose game also satisfies another rule will now show an extra award. Treat any new extra row as a finding to explain, not an assertion to paper over. Pinned in Task 2.
- **Rolling deploy.** Migration `0008` drops `flair_introductions` while old-build `award_flair` jobs may still read it; those jobs fail and retry until a new-build worker takes them. Pinned in Task 5 by the older-build guard test for the backfill job; the `award_flair` retry is accepted, not tested.

---

### Task 1: Backfill versions in the catalog

**Files:**
- Modify: `packages/shared/src/flair/catalog.ts`
- Test: `packages/shared/test/flair/catalog.test.ts`

**Interfaces:**
- Produces: `FlairDefinition.backfill?: number`; `flairBackfillVersion(flair: FlairDefinition): number`, exported from `@group-chess/shared` (check `packages/shared/src/index.ts` re-exports the catalog module wholesale; add it if not).

- [ ] **Step 1: Write the failing tests** in `catalog.test.ts`:

```ts
it('gives every flair a backfill version, 1 unless its entry says otherwise', () => {
  expect(flairBackfillVersion({ id: 'x', emoji: '🧪', category: 'feat', rule: total('draw', 1) })).toBe(1);
  expect(flairBackfillVersion({ id: 'x', emoji: '🧪', category: 'feat', rule: total('draw', 1), backfill: 3 })).toBe(3);
});

it('writes a backfill version only when it is an integer of at least 2', () => {
  for (const flair of FLAIR as readonly FlairDefinition[])
    if (flair.backfill !== undefined) {
      expect(Number.isInteger(flair.backfill)).toBe(true);
      expect(flair.backfill).toBeGreaterThanOrEqual(2);
    }
});
```

- [ ] **Step 2: Run** `pnpm vitest run --project @group-chess/shared packages/shared/test/flair/catalog.test.ts`. Expected: FAIL, `flairBackfillVersion` is not exported.

- [ ] **Step 3: Implement.** Add `backfill?: number` to `FlairDefinition` with the doc comment from §1, and `flairBackfillVersion`. In the module's header comment, replace "awards and introduction dates are keyed by id" with "awards and backfill versions are keyed by id", and "Editing a rule only affects future awards" with "Editing a rule only affects future awards; raise `backfill` to apply a loosened rule to past games (backfill spec §1)".

- [ ] **Step 4: Run** the same command. Expected: PASS.

- [ ] **Step 5: Commit** `Flair backfill: a backfill version per catalog flair`.

---

### Task 2: Retroactive live awards; `flair_backfills` replaces `flair_introductions`

This removes the introduction window everywhere. Dropping the table forces every reader to change in the same commit.

**Files:**
- Modify: `apps/server/src/db/schema.ts` (drop `flairIntroductions`, add `flairBackfills`)
- Create: `apps/server/drizzle/0008_flair_backfill.sql` + `meta/0008_snapshot.json` + `_journal.json` entry (generated)
- Delete: `apps/server/src/flair/introductions.ts`
- Modify: `apps/server/src/flair/rules.ts`, `apps/server/src/flair/history.ts`, `apps/server/src/flair/award.ts`, `apps/server/src/main.ts:96-97`
- Modify tests: `test/helpers/db.ts`, `test/e2e/harness.ts`, `test/unit/flair-rules.test.ts`, `test/integration/flair-history.test.ts`, `test/integration/flair-award.test.ts`, `test/integration/db.test.ts`, `test/integration/main.test.ts`

**Interfaces:**
- Produces:
  - `flairBackfills` table: `flairId: text().primaryKey()`, `version: integer().notNull()`, `completedAt: tz().notNull().defaultNow()`; `type FlairBackfillRow`.
  - `CountedGame` gains `side: Colour` (the side this player had).
  - `export const COUNTED` in `history.ts` (the existing condition, now exported).
  - `loadCountedGames(tx: DbOrTx, userId: number, window?: { through?: Pick<GameRow, 'id' | 'finishedAt'> }): Promise<CountedGame[]>`. No `from`; with no `through` it returns the player's whole counted history.

- [ ] **Step 1: Update the tests to the new behaviour.**
  - `flair-rules.test.ts`: the `game()` helper gains `side: 'white'` in its defaults. No other change.
  - `flair-history.test.ts`: delete the `recordFlairIntroductions` describe and its imports. Drop `from:` from every `loadCountedGames` call, and assert `side` in the first test:
    ```ts
    const rows = await loadCountedGames(db, alice.id, { through: loss });
    expect(rows.map((r) => [r.id, r.result, r.side, r.rated, r.ratingAfter])).toEqual([
      [first.id, 'win', 'white', true, null],   // the day-1 game, now included: bind it to `first`
      [win.id, 'win', 'white', true, 1612.4],
      [draw.id, 'draw', 'black', false, null],
      [loss.id, 'loss', 'black', true, 1590.2],
    ]);
    ```
    Add: `it('returns the whole counted history when no game bounds it')`: calling with no window also returns the day-9 game last.
  - `flair-award.test.ts`: delete `introduce`, `LAUNCH`, the `flairIntroductions` import, every `await introduce(...)` line, and the comment above `beforeEach`. Delete the three tests under the "Each flair sees only games from its own introduction" comment, the comment itself, and `counts only games that finished after a flair was introduced, even toward a streak`. Add:
    ```ts
    it('counts every earlier game toward a streak, however long ago', async () => {
      const { group, alice, bob } = await players();
      const wins: GameRow[] = [];
      for (let d = 2; d <= 6; d += 1) wins.push(await finished(group.id, alice.id, bob.id, d, '1-0'));
      // Only the fifth game's job runs, as if the first four ended before this deploy.
      await awardFlairForGame(db, wins[4]!.id);
      expect(await earned(alice.id)).toEqual([['win_streak_5', wins[4]!.id]]);
    });
    ```
    Leave every other assertion as it is (see Review Focus).
  - `db.test.ts`: the "flair award holds its players' rows" test drops `loadIntroductions` from its steps and comment. The table list replaces `'flair_introductions'` with `'flair_backfills'` (keep alphabetical order: it goes before `'games'`).
  - `main.test.ts`: delete `records every catalog flair as introduced` and the `flairIntroductions` import (Task 5 adds the boot test).

- [ ] **Step 2: Run** `pnpm vitest run --project @group-chess/server test/unit/flair-rules.test.ts test/integration/flair-history.test.ts test/integration/flair-award.test.ts test/integration/db.test.ts`. Expected: FAIL (typecheck/`side` missing, `flair_backfills` missing, the new streak test earns nothing).

- [ ] **Step 3: Schema and migration.** In `schema.ts`, replace `flairIntroductions` with `flairBackfills` (above). Run `pnpm --filter @group-chess/server exec drizzle-kit generate --name flair_backfill`. Check that the SQL is a `DROP TABLE "flair_introductions"` plus a `CREATE TABLE "flair_backfills"`, with no other statements. In `test/helpers/db.ts`, replace `flair_introductions` with `flair_backfills` in the truncate list and in the comment above it (the award job no longer reads it; keep it before `users`).

- [ ] **Step 4: History and rules.** Add `side: Colour` to `CountedGame`, filled from `white` in `loadCountedGames`. Make `window.through` optional and drop `from` and its `gte` condition; update the doc comment. Export `COUNTED`, with the comment "`isCountedGame` as a condition on `games`; the backfill lists players by it (backfill spec §4.2)."

- [ ] **Step 5: Live award (§5).** In `award.ts`, remove `introductions` from `Scoring` and its load. Candidates become `FLAIR.filter((flair) => !held.has(flair.id))`. Load `loadCountedGames(tx, userId, { through: game })` and pass `history: counted` unfiltered. Update the doc comments that cite §1.5. Delete `introductions.ts`. In `main.ts`, remove the import and the `recordFlairIntroductions` call with its comment. In `e2e/harness.ts`, `wipe` becomes a plain `truncateAll(db)` (inline it and drop the comment's introduction rationale).

- [ ] **Step 6: Run** the Step 2 command, then `pnpm typecheck`. Expected: PASS, no type errors.

- [ ] **Step 7: Commit** `Flair backfill: live awards count a player's whole history; flair_backfills replaces flair_introductions`.

---

### Task 3: The walk

A pure function over one player's history, so it can be unit-tested with a spy for moves.

**Files:**
- Create: `apps/server/src/flair/walk.ts`
- Test: `apps/server/test/unit/flair-walk.test.ts`

**Interfaces:**
- Consumes: `ruleHolds`, `CountedGame` (with `side`) from Task 2; `StoredMove` from `patterns.ts`; `FlairEntry` from shared.
- Produces:
  ```ts
  export async function earliestQualifying(
    history: readonly CountedGame[],          // oldest first
    candidates: readonly FlairEntry[],
    movesOf: (gameId: number) => Promise<readonly StoredMove[]>,
  ): Promise<Map<FlairId, CountedGame>>       // each candidate that holds → the first game it holds at
  ```

- [ ] **Step 1: Write the failing tests** (reuse the `game()` shape from `flair-rules.test.ts`, with `side`; `play`/`LINES` from `test/helpers/chess.ts` for moves):
  - `credits each flair to the first game its rule holds at`: five rated wins then a sixth. `win_streak_5` maps to game 5, not 6.
  - `evaluates every game against the history up to it only`: `draws_10` over 12 draws maps to the 10th.
  - `leaves out a flair whose rule never holds`: `scholars_mate_loss` over wins gives an empty map.
  - `reads moves only where a won or lost candidate could hold`: history `[win, draw, loss, win]`; candidates `en_passant_win` + `draws_10`. A spy `movesOf` returns `[]`. Expect it to be called with exactly the ids of the two wins. Then, with only `draws_10`, expect it never to be called.
  - `reads a game's moves once however many candidates need them`: candidates `en_passant_win` + `queenside_castle_win`; one win. The spy is called once.
  - `stops once every candidate is found`: `en_passant_win` is found at game 1 (its moves are `LINES.enPassant`, White). The spy is not called for games 2 and 3.

- [ ] **Step 2: Run** `pnpm vitest run --project @group-chess/server test/unit/flair-walk.test.ts`. Expected: FAIL, the module is missing.

- [ ] **Step 3: Implement `earliestQualifying`.** Walk `history` by index. At each game, compute whether moves are needed: some remaining candidate has `rule.kind === 'won'` and the game is a `win`, or `'lost'` and a `loss`. If so, `await movesOf(game.id)` (memoize per game id); otherwise use `[]`. Evaluate each remaining candidate with `ruleHolds(flair.rule, { game, history: history.slice(0, i + 1), moves, side: game.side })`. Record and remove the ones that hold, and return as soon as none remain. Header comment: "Backfill spec §4.2 steps 3–4; correct because a rule depends only on the game and earlier ones (flair spec §1.6)."

- [ ] **Step 4: Run** the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit** `Flair backfill: find each flair's earliest qualifying game`.

---

### Task 4: Backfilling players and recording completion

**Files:**
- Create: `apps/server/src/flair/backfill.ts`
- Test: `apps/server/test/integration/flair-backfill.test.ts`

**Interfaces:**
- Consumes: `earliestQualifying` (Task 3); `loadCountedGames`, `COUNTED` (Task 2); `flairBackfills` (Task 2); `flairBackfillVersion`, `flairById` (Task 1); `listMoves` from `domain/games.ts`.
- Produces:
  ```ts
  export type BackfillPair = { id: string; version: number };
  export type BackfillSummary = { players: number; added: Record<string, number>; moved: Record<string, number> };
  export async function pendingBackfills(db: DbOrTx): Promise<BackfillPair[]>;         // catalog order
  export async function backfillPlayer(db: DbOrTx, userId: number, flair: readonly FlairEntry[])
    : Promise<{ added: string[]; moved: string[] }>;
  export async function runFlairBackfill(
    db: Db,
    pairs: readonly BackfillPair[],
    options?: { backfillOne?: typeof backfillPlayer },   // test seam; defaults to backfillPlayer
  ): Promise<BackfillSummary>;
  ```

- [ ] **Step 1: Write the failing tests.** Reuse the `players`/`finished`/`earned`/`worn` helpers from `flair-award.test.ts`. Copy them in; don't extract shared helpers in this task.
  - `pendingBackfills`:
    - with an empty table, it returns every catalog id at version 1, in catalog order;
    - a row at the current version drops that id;
    - a row below the catalog's version keeps the id pending at the catalog's version: insert `draws_10` at version 0 and expect `{ id: 'draws_10', version: 1 }` in the result;
    - a row for `retired_flair` has no effect.
  - `backfillPlayer`:
    - `awards each rule kind from history at the first game that earned it`: one player, with games covering 👑 (`LINES.enPassant`), 🔥 (five rated wins), 🤝 (ten draws), 🪤 (as the loser of `LINES.scholarsMateQh5`) and a rung (`whiteRatingAfter: 1612`). Assert `earned()` pairs and each row's `earnedAt` equals its game's `finishedAt`.
    - `fills no worn slots`: `worn()` is still `[]` afterwards.
    - `moves a held flair to an earlier game, and leaves it when there is none`: seed `user_flair` (`en_passant_win`, a later game) and (`draws_10`, the true 10th draw). After the backfill, the first points to the earlier en passant win and the second is unchanged. `moved` is `['en_passant_win']`.
    - `never moves an award to a later game`: seed an award at a game that no longer counts (voided), with a later qualifying game present. The row keeps the voided game.
    - `changes nothing when run again`: a second call returns `{ added: [], moved: [] }`.
  - `runFlairBackfill`:
    - `skips the bot and deleted players, and sweeps rows of players deleted meanwhile`: seed a `user_flair` row for a deleted user. After the run it is gone, and a deleted user with qualifying games has none.
    - `records the pairs after a complete run`: after `runFlairBackfill(db, [{ id: 'draws_10', version: 1 }])`, `flair_backfills` holds `draws_10` at version 1.
    - `records nothing when a player fails, and keeps earlier players' awards`: two players who each drew ten. Pass `{ backfillOne }`, which delegates to `backfillPlayer` for the first user id and throws `new Error('boom')` for the second. The run rejects with `boom`, the first player holds `draws_10`, and `flair_backfills` is empty.
    - `keeps the higher version when recording`: with an existing row at 3 and a run for version 1, the row stays at 3.
    - `returns counts per flair`: `added.draws_10 === 2` for two players who both drew ten.

- [ ] **Step 2: Run** `pnpm vitest run --project @group-chess/server test/integration/flair-backfill.test.ts`. Expected: FAIL, the module is missing.

- [ ] **Step 3: Implement `pendingBackfills`.** Read all rows. Return `FLAIR` entries whose row is missing or whose row's `version < flairBackfillVersion(flair)`, as `{ id, version: flairBackfillVersion(flair) }`.

- [ ] **Step 4: Implement `backfillPlayer`.** Load `loadCountedGames(db, userId)`, call `earliestQualifying` with `movesOf = (id) => listMoves(db, id)`, and upsert in one statement:
  ```ts
  db.insert(userFlair).values(rows)
    .onConflictDoUpdate({
      target: [userFlair.userId, userFlair.flairId],
      set: { gameId: sql`excluded.game_id`, earnedAt: sql`excluded.earned_at` },
      setWhere: sql`excluded.earned_at < ${userFlair.earnedAt}`,
    })
    .returning({ flairId: userFlair.flairId, inserted: sql<boolean>`xmax = 0` })
  ```
  Rows returned with `inserted` go to `added`; the others go to `moved`. Return early with empty lists when nothing was found. `listMoves` lives in `domain/games.ts`, which imports `flair/history.ts`. Importing it from `backfill.ts` is fine; just don't import `backfill.ts` from `history.ts`.

- [ ] **Step 5: Implement `runFlairBackfill`.** Map the pairs to catalog entries with `flairById`; `canRunBackfill` in Task 5 guarantees they all exist. List eligible user ids: `users` with `is_engine = false`, `deleted_at is null`, and `exists` a game with that user as white or black matching `COUNTED`, ordered by id. Call `backfillPlayer` for each and accumulate the summary. Then sweep: `delete from user_flair using users where user_flair.user_id = users.id and users.deleted_at is not null`. Then upsert `flairBackfills` for every pair, with `set: { version: sql\`greatest(${flairBackfills.version}, excluded.version)\`, completedAt: sql\`now()\` }`.

- [ ] **Step 6: Run** the Step 2 command. Expected: PASS.

- [ ] **Step 7: Commit** `Flair backfill: backfill players and record completed versions`.

---

### Task 5: The job, its guard, and enqueueing at boot

**Files:**
- Modify: `apps/server/src/flair/backfill.ts` (add enqueue + guard)
- Modify: `apps/server/src/jobs/types.ts` (`JOB_KINDS` gains `'backfill_flair'` after `'award_flair'`)
- Modify: `apps/server/src/jobs/handlers/flair.ts`, `apps/server/src/jobs/handlers/index.ts`, `apps/server/src/main.ts`
- Test: `apps/server/test/integration/flair-backfill.test.ts` (new describes), `apps/server/test/integration/main.test.ts`

**Interfaces:**
- Consumes: Task 4's exports.
- Produces:
  ```ts
  export function backfillDedupKey(pairs: readonly BackfillPair[]): string;
  export function canRunBackfill(pairs: readonly BackfillPair[]): boolean;   // every id known, version ≤ this build's
  export async function enqueueFlairBackfill(db: DbOrTx): Promise<void>;
  export function backfillFlairHandler(deps: Deps): JobHandler;              // in jobs/handlers/flair.ts
  ```

- [ ] **Step 1: Write the failing tests.**
  - `backfillDedupKey([{ id: 'rank_1200', version: 1 }, { id: 'draws_10', version: 2 }])` equals `'flair:backfill:draws_10@2,rank_1200@1'`.
  - `canRunBackfill`: true for `[{ id: 'draws_10', version: 1 }]`; false for `retired_flair@1` and for `draws_10@2`.
  - `enqueueFlairBackfill`, `enqueues one job for the pending set, and none when nothing is pending`. On an empty `flair_backfills`, calling it twice leaves exactly one `backfill_flair` job, whose payload is `{ flair: pendingBackfills() }` and whose dedup key is `backfillDedupKey` of it. After the rows are recorded at current versions, a third call adds nothing.
  - The handler, driven by `new JobWorker({ db, log, handlers: coreJobHandlers(deps), workerId: 'w' }).runOnce()` as in `flair-award.test.ts`:
    - `backfills from the job and records the pairs`: a player with ten draws ends up holding `draws_10`, and `flair_backfills` has the payload's rows.
    - `leaves a job from a newer build for a newer worker`: enqueue with payload `{ flair: [{ id: 'retired_flair', version: 1 }] }`. After `runOnce`, the job is not done, its `attempts` is unchanged, its `run_at` is about 30 s ahead, and `flair_backfills` is empty.
  - `main.test.ts`: `it('enqueues a backfill of every catalog flair at boot')`. A `backfill_flair` job exists (done or not) with dedup key `backfillDedupKey(FLAIR.map((f) => ({ id: f.id, version: flairBackfillVersion(f) })))`.

- [ ] **Step 2: Run** `pnpm vitest run --project @group-chess/server test/integration/flair-backfill.test.ts test/integration/main.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** `backfillDedupKey` sorts a copy by id. `enqueueFlairBackfill` returns when `pendingBackfills` is empty; otherwise it calls `enqueue(db, { kind: 'backfill_flair', payload: { flair: pairs }, dedupKey, rearm: false })`. Use `rearm: false` so a second boot doesn't reset a job that is retrying. The handler parses `z.object({ flair: z.array(z.object({ id: z.string(), version: z.number().int() })) })`, returns the §4.1 retry when `!canRunBackfill`, otherwise calls `runFlairBackfill(deps.db, pairs)` and logs the summary with `log.info({ ...summary }, 'flair backfill done')`. Register it in `coreJobHandlers` as `backfill_flair`. In `main.ts`, call `await enqueueFlairBackfill(db)` where `recordFlairIntroductions` was, with the comment "Backfill spec §3: flair not yet backfilled at this build's versions is queued; boot does not wait for it."

- [ ] **Step 4: Run** the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit** `Flair backfill: enqueue the backfill job at boot`.

---

### Task 6: Spec updates and the full suite

**Files:**
- Modify: `docs/superpowers/specs/2026-09-29-flair-design.md`

- [ ] **Step 1: Edit the flair spec** exactly as the backfill spec's §8 lists: the status line, the prototype-departure bullet, §1.5, §1.7, §2, §3.1, §3.2 steps 3.2–3.4, the §6 row, and §9. Link to `./2026-09-29-flair-backfill-design.md`.

- [ ] **Step 2: Run the full check suite** from the repo root: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm check:budget && pnpm check:licences`. Expected: everything passes. Test count is the baseline minus the deleted introduction tests plus the new ones, with no failures.

- [ ] **Step 3: Grep for leftovers:** `grep -rn -i "introduc" apps/server/src apps/server/test packages/shared/src` finds nothing flair-related.

- [ ] **Step 4: Commit** `Flair backfill: flair spec points at the backfill`.
