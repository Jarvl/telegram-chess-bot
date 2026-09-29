# Chess Goat: flair backfill

Status: accepted for planning, 2026-09-29. Builds on [flair](./2026-09-29-flair-design.md) and
replaces its introduction window (§1.5 there).

## What this is

Flair is awarded for a player's whole history, not only for games that finished after the flair
shipped. A **backfill** walks every player's counted games and awards what they already qualify
for. It runs on its own after a deploy, like a database migration: each flair is backfilled once,
recorded as done, and never again unless its entry asks for it.

Tom has won five rated games in a row since August. The deploy that ships this finishes, and a few
seconds later 🔥 is on his Flair screen, earned "vs @maya · Sep 3", the game that made it five.

**Goals**

- Every player holds every flair their full history qualifies for, credited to the first game
  that earned it.
- Adding a flair needs no manual step: the next deploy backfills it.
- A flair whose rule was loosened can be re-backfilled by bumping a number in its catalog entry.
- Boot is never slowed or blocked, and nothing takes a user row lock.

| In scope | Out of scope |
|---|---|
| Retroactive flair: the introduction window is removed for backfills and live awards alike | Revoking flair when a rule is tightened, a game is voided or ratings are rebuilt |
| `backfill` versions in the catalog and the `flair_backfills` table (§1, §2) | Filling worn slots from a backfill |
| The `backfill_flair` job, enqueued at boot (§3, §4) | A notice or DM for backfilled flair |
| Moving an award to an earlier qualifying game (§4.2) | An admin command to trigger a backfill by hand |

Delivered as one PR against `main`.

## 1. The catalog

`FlairDefinition` in `packages/shared/src/flair/catalog.ts` gains an optional field:

```ts
export type FlairDefinition = {
  id: string;
  emoji: string;
  category: FlairCategory;
  rule: FlairRule;
  /** The backfill version (backfill spec §1). Absent means 1; bump it to backfill this flair again. */
  backfill?: number;
};
```

`flairBackfillVersion(flair)` returns `flair.backfill ?? 1`. A catalog test checks that every
`backfill` present is an integer of at least 2 (1 is the default and is left out).

- **Adding a flair:** nothing beyond the flair spec's §1.7. It is pending at version 1 and the next
  deploy backfills it.
- **Loosening a rule:** edit the rule and raise `backfill` by one. The next deploy re-runs that
  flair for everyone. A backfill only adds awards or moves them earlier (§4.2), so bumping after
  tightening a rule does nothing useful; tightening affects only future awards.
- **Changing an emoji or description:** no bump.

## 2. Data

Migration `0008_flair_backfill`:

**`flair_backfills`**: which backfills have completed.

| Column | Type | Notes |
|---|---|---|
| `flair_id` | text, primary key | A catalog id |
| `version` | integer, not null | The highest version completed |
| `completed_at` | timestamptz, not null, default `now()` | When it last completed |

**`flair_introductions` is dropped.** With every flair retroactive it has no reader.
`recordFlairIntroductions` and `loadIntroductions` are deleted.

A catalog flair is **pending** when `flair_backfills` has no row for its id, or the row's `version`
is below `flairBackfillVersion(flair)`. `pendingBackfills(db)` in `apps/server/src/flair/backfill.ts`
returns the pending `{ id, version }` pairs in catalog order. Rows for ids no longer in the catalog
are ignored.

On the first deploy of this change, all 14 flair are pending at version 1.

## 3. Enqueueing at boot

`startServer` calls `enqueueFlairBackfill(db)` right after migrations, in every role, where it now
calls `recordFlairIntroductions`. If `pendingBackfills` is empty it does nothing. Otherwise it
enqueues:

- kind `backfill_flair` (added to `JOB_KINDS`, registered in `coreJobHandlers`);
- payload `{ flair: [{ id, version }, …] }`, the pending pairs;
- dedup key `flair:backfill:` followed by the pairs as `id@version`, sorted by id and joined with
  commas.

Replicas booting the same build compute the same pairs and the same key, so they collapse into one
job. A later deploy with a different pending set gets a different key and its own job, rather than
being absorbed by one already running for an older set. Two jobs whose sets overlap are harmless
(§4.2 is idempotent).

Enqueueing is one insert. Boot does not wait for the backfill.

## 4. The `backfill_flair` job

The logic lives in `apps/server/src/flair/backfill.ts`; `jobs/handlers/flair.ts` gains
`backfillFlairHandler`.

### 4.1 Guarding against an older build

A worker still running the previous build during a rolling deploy may lease the job. Before doing
anything, the handler checks every payload pair against its own catalog. If an id is not in it, or
the payload's version is above `flairBackfillVersion` for that id, it returns
`{ outcome: 'retry', delayMs: 30_000 }` so a worker on the new build takes the job. It never
records a pair it could not evaluate.

### 4.2 The walk

The job lists the eligible players: not the bot, not deleted, and with at least one counted game.
It processes them one at a time in ascending id order. Nothing is locked, and each player's writes
are a single statement.

For each player:

1. **Candidates** are the payload's flair, held or not. For a flair they hold, the walk looks for
   an earlier qualifying game than the one on record.
2. **Load** all their counted games, oldest first, with `loadCountedGames` (flair spec §1.3). It no
   longer takes a `from` bound.
3. **Walk** the games in order. At game `i`, evaluate each remaining candidate with the shared
   `ruleHolds`, given `game = games[i]` and `history = games[0..i]`. The first game where a
   candidate holds earns it; it leaves the candidates. Stop when none are left or the games run
   out. This is correct because a rule's answer depends only on the game and earlier games (flair
   spec §1.6).
4. **Moves are loaded lazily.** A game's moves are read only when a `won` or `lost` candidate could
   hold there (the player's result is a win or a loss respectively), and are kept for the rest of
   this player's walk. `held`, `streak` and `total` never read moves.
5. **Write** what was found in one statement:
   ```sql
   insert into user_flair (user_id, flair_id, game_id, earned_at) values …
   on conflict (user_id, flair_id) do update
     set game_id = excluded.game_id, earned_at = excluded.earned_at
     where excluded.earned_at < user_flair.earned_at
   ```
   A new flair is inserted. A held flair moves to the earlier game if one was found, and is
   otherwise left as it is. Nothing is ever deleted.

**Worn slots are never touched.** Backfilled flair shows as earned on the Flair screen, and the
player chooses whether to wear it. Live awards keep filling free slots (flair spec §3.3).

Comparing on `earned_at` alone is enough: two games that finished at the same instant give the
same `earned_at`, and then the row on record stays.

### 4.3 Finishing

After the last player:

1. **Sweep.** Delete `user_flair` rows whose user is deleted. The walk takes no lock, so it can
   insert a row for a player whose Delete my data commits at the same moment. Nobody could see such
   a row (a deleted account cannot sign in again, and `toPlayerRef` draws no flair for it), but
   Delete my data promises to remove flair, and the sweep keeps that promise.
2. **Record.** Upsert a `flair_backfills` row for each payload pair, with
   `version = greatest(flair_backfills.version, excluded.version)` and `completed_at = now()`.
3. **Log** the players scanned and the awards added and moved per flair, at `info`.

`flair_backfills` is written only here, so a backfill that did not finish stays pending.

## 5. Live awards

`awardFlairForGame` (flair spec §3.2) drops the introduction window:

- Candidates are every catalog flair the player does not hold (step 3.2 there).
- It loads the player's full counted history up to and including this game, and evaluates each
  candidate on it unwindowed (steps 3.3 and 3.4 there).
- It still locks both players' rows and fills free worn slots, as before.

After this change, a game that ends before the backfill reaches its players may earn a flair from
pre-deploy history (a streak running since last month, say). The live award credits that game;
when the backfill reaches the player it finds the earlier game and moves the award there (§4.2). So
which game is credited does not depend on which ran first. Whether the flair is worn does: a live
award fills a free slot and a backfill does not, so a flair earned this way is worn only when the
live award got there first.

## 6. Error handling

| Case | Behaviour |
|---|---|
| Two replicas boot the same build | Same dedup key: one job |
| A deploy while a backfill is running | A different pending set and key: its own job. Overlapping work is idempotent |
| An older build's worker leases the job | `retry` after 30 s (§4.1). Nothing is recorded |
| A rule or detector throws for one player | The job retries with the queue's backoff, then fails and is logged (`jobs_failed_total{kind="backfill_flair"}`). Players already processed keep their awards. The pairs stay pending and the next boot enqueues them again |
| The job is retried after a partial run | The walk rewrites nothing that is already right, so players already processed are unchanged |
| A player deletes their data during the backfill | The sweep removes any row inserted after their deletion (§4.3) |
| A live award and the backfill for the same player at once | Both write `user_flair` with conflict handling. The earliest qualifying game wins (§5) |
| A flair removed from the catalog | Never pending; its `flair_backfills` row is ignored |
| `backfill` bumped | That flair is re-evaluated for everyone. Awards are added or moved earlier, never removed |
| A game voided after it earned flair | The flair is kept (unchanged from the flair spec) |

## 7. Testing and gates

- **Shared unit tests:** `backfill`, when present, is an integer of at least 2;
  `flairBackfillVersion` defaults to 1.
- **Server integration tests (PostgreSQL):**
  - `pendingBackfills`: no row, an older version, the current version, and a row for an id no
    longer in the catalog;
  - boot enqueues `backfill_flair` with the pending pairs and the dedup key of §3, only when
    something is pending, and two boots make one job;
  - the backfill awards each rule kind from history (`held`, `won`, `lost`, `streak`, `total`),
    credited to the first qualifying game with its `finished_at`;
  - a streak that runs across the deploy is earned;
  - backfilled flair fills no worn slots;
  - a held flair moves to an earlier qualifying game, and stays when there is none;
  - a rerun of a completed backfill changes nothing;
  - a version bump awards a newly qualifying player and keeps existing awards;
  - the bot and deleted players are skipped, and the sweep removes a deleted player's rows;
  - moves are read only for games where a `won` or `lost` candidate could hold;
  - a payload with an unknown id or a higher version returns `retry` and records nothing;
  - `flair_backfills` is written only after the last player;
  - a live award now counts games from before the deploy.
- **Removed:** the flair spec's introduction tests (boot records introductions; games before an
  introduction do not count; windowing by introduction in the evaluator tests).
- **Gates:** the full check suite passes (lint, format, typecheck, tests, bundle budget, licences).

## 8. Changes to the flair spec

- **Status line:** notes that the backfill spec replaces the introduction window.
- **§ "Where this spec departs from the prototype":** the bullet "Flair counts only games that
  finish after it ships" is replaced: flair counts a player's whole history.
- **§1.5:** replaced by a pointer to this spec.
- **§1.7:** "It becomes earnable from the first game that ends after it ships" becomes "the next
  deploy backfills it"; "Changing a rule" gains "bump `backfill` to apply a loosened rule to past
  games".
- **§2:** `flair_introductions` is marked as dropped by migration `0008`.
- **§3.1:** replaced by a pointer to §3 here.
- **§3.2:** steps 3.2 to 3.4 lose the introduction window.
- **§6:** the "A game ends before its flair's introduction is recorded" row is removed.
- **§9:** the Backfill item is removed.
