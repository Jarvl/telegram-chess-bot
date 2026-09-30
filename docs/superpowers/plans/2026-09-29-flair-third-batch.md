# Flair third batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add eight flair (🐢 🕊️ 👬 👶 💩 🗑️ 😈 🐔), two rule kinds (`ended`, `against`), two move patterns (`marathon`, `pacifist_mate`), and make every streak rated.

**Architecture:** The catalog in `packages/shared` gains builders and entries; the server's `CountedGame` carries each game's end reason and opponent id so the new evaluators stay pure functions of the game and earlier games (spec §1.6). Award and backfill pick the new flair up with no changes; the next deploy backfills them.

**Tech Stack:** TypeScript, pnpm workspaces, Vitest, Drizzle on PostgreSQL.

**Spec:** [docs/superpowers/specs/2026-09-29-flair-design.md](../specs/2026-09-29-flair-design.md) §1.1–§1.8 and §7 (amended in `bfbdf6e`).

## Global Constraints

- Ids, emoji, categories, rules and descriptions exactly as spec §1.2 (the eight new rows); ids are permanent.
- Display order: feats end `… draws_10, marathon_win, pacifist_mate, rival_5`; dubious reads `scholars_mate_loss, bongcloud_win, loss_streak_3, loss_streak_5, loss_streak_10, nemesis_5, resigned`.
- Every `streak` is rated; `streak(result, length)` takes no options. `total` keeps `{ rated }`, defaulting to false.
- `against` and `ended` read no moves; the backfill walk (`walk.ts`) must not load moves for them.
- No migration: `end_reason`, `white_id` and `black_id` already exist on `games`.
- Integration tests: export `TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/group_chess_test_flair3` after `docker exec <db container> psql -U postgres -c "create database group_chess_test_flair3"` (the shared test database collides with other worktrees). Run `pnpm install` once in this worktree first.

## Review Focus

- **Test fixtures that default to a resignation** would hand 🐔 to every loser in existing award and backfill tests → the fixture default becomes `'timeout'` (Task 4).
- **Five or more fixture games between the same two players** would add 👬 (and 😈, loss streaks) to existing exact-list assertions → those expectations are updated to include them, not filtered (Task 4).
- **The sixth game against a nemesis is a win**: `against(5, 'loss')` must not hold at a game without the result (Task 2 unit test).
- **A casual loss inside a rated losing run** neither breaks nor extends 👶 💩 🗑️ (Task 1 unit test).
- **An opponent who deleted their data** still counts toward 👬 and 😈 for the other player (Task 4 integration test).

---

### Task 1: Every streak is rated

**Files:**
- Modify: `packages/shared/src/flair/catalog.ts` (the `FlairRule` streak member, `streak()`, the 🌡️ 🔥 🌋 entries, the rule doc comment)
- Modify: `apps/server/src/flair/rules.ts` (`streak` evaluator, `passesFilter` comment)
- Test: `packages/shared/test/flair/catalog.test.ts`, `apps/server/test/unit/flair-rules.test.ts`

**Interfaces:**
- Produces: `FlairRule` member `{ kind: 'streak'; result: PlayerResult; length: number }` and `streak(result: PlayerResult, length: number): FlairRule`.

- [ ] **Step 1: Update the tests**

In `catalog.test.ts`, replace `'leaves streaks and totals unrated unless asked'` with:

```ts
it('makes every streak rated, and leaves totals unrated unless asked', () => {
  expect(total('draw', 10)).toEqual({ kind: 'total', result: 'draw', count: 10, rated: false });
  expect(streak('win', 5)).toEqual({ kind: 'streak', result: 'win', length: 5 });
});
```

and change the second-batch rows' `streak('win', 3, { rated: true })` / `streak('win', 10, { rated: true })` to `streak('win', 3)` / `streak('win', 10)`.

In `flair-rules.test.ts`, change existing `streak(..., { rated: … })` calls to the two-argument form (delete any case asserting an unrated streak), and add:

```ts
it('runs a losing streak over rated games only, a casual loss neither extending nor breaking it', () => {
  const casual = { rated: false };
  const run = [game(1, 'loss'), game(2, 'loss', casual), game(3, 'loss'), game(4, 'win', casual)];
  expect(ruleHolds(streak('loss', 3), at(run.slice(0, 3)))).toBe(false);
  expect(ruleHolds(streak('loss', 3), at([...run, game(5, 'loss')]))).toBe(true);
  // Scored at a casual game, a streak never holds.
  expect(ruleHolds(streak('loss', 2), at(run.slice(0, 2)))).toBe(false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/shared/test/flair/catalog.test.ts apps/server/test/unit/flair-rules.test.ts`
Expected: FAIL (the builder still returns `rated`; typecheck errors on the two-argument calls are fine).

- [ ] **Step 3: Implement**

Remove `rated` from the streak member and from `streak()`; drop `{ rated: true }` from the three entries (their `backfill` stays absent). In `rules.ts` the `streak` evaluator filters on `past.rated` directly; `passesFilter` stays for `total` only. Update the `FlairRule` doc comment to say streaks are always rated.

- [ ] **Step 4: Verify**

Run: `pnpm vitest run packages/shared/test/flair apps/server/test/unit && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "Flair: every streak is rated"`

### Task 2: `ended` and `against` rule kinds

**Files:**
- Modify: `packages/shared/src/flair/catalog.ts` (`FlairRule`, builders)
- Modify: `apps/server/src/flair/rules.ts` (`CountedGame`, `EVALUATORS`)
- Modify: `apps/server/src/flair/history.ts` (`loadCountedGames` select and map)
- Test: `apps/server/test/unit/flair-rules.test.ts`, `apps/server/test/unit/flair-walk.test.ts`, and every other `CountedGame` fixture the typecheck flags

**Interfaces:**
- Consumes: `EndReason` from `@group-chess/shared`.
- Produces:
  - `FlairRule` members `{ kind: 'ended'; result: PlayerResult; reason: EndReason }` and `{ kind: 'against'; count: number; result: PlayerResult | null }`.
  - `ended(result: PlayerResult, reason: EndReason): FlairRule`; `against(count: number, result?: PlayerResult): FlairRule` (absent → `null`).
  - `CountedGame` gains `endReason: EndReason | null` and `opponentId: number`.

- [ ] **Step 1: Write the failing tests**

Extend the `game()` fixtures in `flair-rules.test.ts` and `flair-walk.test.ts` with defaults `endReason: 'checkmate', opponentId: 100`. Add to `flair-rules.test.ts`:

```ts
describe('ended', () => {
  it('holds for the result and the reason together', () => {
    const resigned = game(1, 'loss', { endReason: 'resignation' });
    expect(ruleHolds(ended('loss', 'resignation'), at([resigned]))).toBe(true);
    expect(ruleHolds(ended('loss', 'resignation'), at([game(1, 'win', { endReason: 'resignation' })]))).toBe(false);
    expect(ruleHolds(ended('loss', 'resignation'), at([game(1, 'loss', { endReason: 'timeout' })]))).toBe(false);
    expect(ruleHolds(ended('loss', 'resignation'), at([game(1, 'loss', { endReason: null })]))).toBe(false);
  });
});

describe('against', () => {
  const vs = (id: number, opponentId: number, result: PlayerResult = 'win') =>
    game(id, result, { opponentId, rated: id % 2 === 0 });
  it('counts only games against this game’s opponent, rated or casual', () => {
    const fourVs7 = [vs(1, 7), vs(2, 8), vs(3, 7), vs(4, 7), vs(5, 9), vs(6, 7)];
    expect(ruleHolds(against(5), at(fourVs7))).toBe(false);
    expect(ruleHolds(against(5), at([...fourVs7, vs(7, 7, 'draw')]))).toBe(true);
    // Scored at a game against someone else, the count is theirs.
    expect(ruleHolds(against(5), at([...fourVs7, vs(7, 7), vs(8, 8)]))).toBe(false);
  });
  it('with a result, counts only those games and needs this game to have it', () => {
    const losses = [1, 2, 3, 4].map((id) => vs(id, 7, 'loss'));
    expect(ruleHolds(against(5, 'loss'), at([...losses, vs(5, 7, 'win'), vs(6, 7, 'loss')]))).toBe(true);
    expect(ruleHolds(against(5, 'loss'), at([...losses, vs(5, 7, 'loss'), vs(6, 7, 'win')]))).toBe(false);
    expect(ruleHolds(against(5, 'loss'), at([...losses, vs(5, 8, 'loss')]))).toBe(false);
  });
});
```

Add to `flair-walk.test.ts`:

```ts
it('reads no moves for ended and against candidates', async () => {
  const movesOf = movesSpy();
  await earliestQualifying(games('win', 'loss', 'draw'), flair('resigned', 'rival_5'), movesOf);
  expect(movesOf).not.toHaveBeenCalled();
});
```

(`flair()` looks ids up in `FLAIR`; until Task 4 adds `resigned` and `rival_5`, build these two candidates inline as `{ id, emoji, category, rule: ended('loss', 'resignation') }` / `rule: against(5)` and switch to `flair()` in Task 4.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run apps/server/test/unit/flair-rules.test.ts apps/server/test/unit/flair-walk.test.ts`
Expected: FAIL (`ended`/`against` not exported).

- [ ] **Step 3: Implement**

Add the builders and members in `catalog.ts`, and extend the `FlairRule` doc comment with one line each (copy the spec §1.4 wording). In `rules.ts`, add the two fields to `CountedGame` with doc comments and add the `ended` and `against` evaluators (for `against`, count `history` entries with `opponentId === game.opponentId` and, when `rule.result` is set, that result; `game.result` must equal `rule.result` when it is set). In `history.ts`, select `blackId` and `endReason` and map `opponentId: white ? row.blackId : row.whiteId`, `endReason: row.endReason`. `walk.ts` needs no change; confirm its `needsMoves` expression does not list the new kinds.

- [ ] **Step 4: Verify**

Run: `pnpm typecheck && pnpm vitest run apps/server/test/unit`
Expected: PASS. Fix any other `CountedGame` literal the typecheck flags by adding the two fields.

- [ ] **Step 5: Commit** — `git commit -m "Flair: ended and against rule kinds"`

### Task 3: `marathon` and `pacifist_mate` patterns

**Files:**
- Modify: `packages/shared/src/flair/catalog.ts` (`MovePattern`)
- Modify: `apps/server/src/flair/patterns.ts` (`DETECTORS`)
- Modify: `apps/server/test/helpers/chess.ts` (new FEN and line)
- Test: `apps/server/test/unit/flair-patterns.test.ts`

**Interfaces:**
- Produces: `MovePattern` gains `'marathon' | 'pacifist_mate'`; `chess.ts` exports `CAPTURE_PROMOTION_MATE_FEN = 'k6r/6P1/1K6/8/8/8/8/8 w - - 0 1'` (White mates by `g7h8q`, SAN `gxh8=Q#`) and `LINES.foolsMate = ['f2f3', 'e7e5', 'g2g4', 'd8h4']` (Qh4# at ply 4) plus `LINES.enPassantThenMate`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('marathon', () => {
  const plies = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ ply: i + 1, uci: 'a1a1', san: 'Ka1', fenAfter: '' }));
  it('sees a game past move 100, for either side', () => {
    expect(madePattern('marathon', plies(200), 'white')).toBe(false);
    expect(madePattern('marathon', plies(201), 'white')).toBe(true);
    expect(madePattern('marathon', plies(201), 'black')).toBe(true);
  });
});

describe('pacifist_mate', () => {
  it('sees a mate by a side that never captured, whatever the opponent took', () => {
    expect(madePattern('pacifist_mate', from(LINES.foolsMate), 'black')).toBe(true);
    // White captured on d5 at ply 3; Black still never did.
    expect(madePattern('pacifist_mate', from(LINES.mateAfterLosingAPawn), 'black')).toBe(true);
    // The mated side made no capture either, but gave no mate.
    expect(madePattern('pacifist_mate', from(LINES.foolsMate), 'white')).toBe(false);
  });
  it('ignores a mate after any capture of the side’s own', () => {
    const own = [
      from(LINES.scholarsMateQh5), // Qxf7#
      play(CAPTURE_PROMOTION_MATE_FEN, 'g7h8q'), // gxh8=Q#
      from(LINES.enPassantThenMate),
    ];
    for (const moves of own) {
      expect(gaveMate(moves, 'white')).toBe(true);
      expect(madePattern('pacifist_mate', moves, 'white')).toBe(false);
    }
  });
  it('ignores a game without a mate', () =>
    expect(madePattern('pacifist_mate', from(LINES.bongcloud), 'white')).toBe(false));
});
```

`LINES.enPassantThenMate`: a legal line from the initial position in which White captures en passant (e.g. starting with `LINES.enPassant`) and later mates without a further capture. Find it with `play()` — the `gaveMate(…) === true` guard above fails if the line is not a mate — and comment the mating ply as the other lines do.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run apps/server/test/unit/flair-patterns.test.ts`
Expected: FAIL (unknown pattern).

- [ ] **Step 3: Implement**

Add the two patterns to `MovePattern` and `DETECTORS`, each with a one-line comment in the style of its neighbours: `marathon` is `moves.length > 200`, ignoring `side`; `pacifist_mate` is `gaveMate(moves, side)` and no move `isBy(move, side)` whose SAN includes `x`.

- [ ] **Step 4: Verify**

Run: `pnpm vitest run apps/server/test/unit && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "Flair: marathon and pacifist_mate patterns"`

### Task 4: The eight flair

**Files:**
- Modify: `packages/shared/src/flair/catalog.ts` (`FLAIR`), `packages/shared/src/i18n/en.ts`
- Regenerate: `apps/server/src/images/flairEmoji.ts` via `node scripts/vendor-snapshot-art.mjs`
- Test: `packages/shared/test/flair/catalog.test.ts`, `apps/server/test/integration/flair-award.test.ts`, `apps/server/test/integration/flair-backfill.test.ts`, `apps/server/test/unit/flair-walk.test.ts`, and any other test the new awards change (`apps/miniapp/test/flair.test.tsx` if it counts the catalog)

**Interfaces:**
- Consumes: `ended`, `against` (Task 2); `won('marathon')`, `won('pacifist_mate')` (Task 3); two-argument `streak` (Task 1).
- Produces: `FlairId` gains `marathon_win`, `pacifist_mate`, `rival_5`, `loss_streak_3`, `loss_streak_5`, `loss_streak_10`, `nemesis_5`, `resigned`.

- [ ] **Step 1: Write the failing catalog test**

Add `'holds the third batch in display order, with its rules and descriptions'` in the shape of the second-batch test, with these rows (category, id, code points, rule, text):

```
feat    marathon_win    1F422       won('marathon')               Win a game longer than 100 moves
feat    pacifist_mate   1F54A FE0F  won('pacifist_mate')          Checkmate without making a single capture
feat    rival_5         1F46C       against(5)                    Play the same person five times
dubious loss_streak_3   1F476       streak('loss', 3)             Lose three rated games in a row
dubious loss_streak_5   1F4A9       streak('loss', 5)             Lose five rated games in a row
dubious loss_streak_10  1F5D1 FE0F  streak('loss', 10)            Lose ten rated games in a row
dubious nemesis_5       1F608       against(5, 'loss')            Lose five games to the same person
dubious resigned        1F414       ended('loss', 'resignation')  Resign a game
```

and assert the feat ids end `['draws_10', 'marathon_win', 'pacifist_mate', 'rival_5']` and the dubious ids equal the Global Constraints order.

- [ ] **Step 2: Write the failing integration tests** in `flair-award.test.ts`

First change `finished()`'s default `endReason` from `'resignation'` to `'timeout'`, with the comment "No flair reads a timeout, so only a test that asks for a resignation earns 🐔." Do the same in `flair-backfill.test.ts`'s fixture if it defaults to a resignation. Then add:

- `'awards 🐔 to the player who resigned, and nothing to the winner'`: one `'1-0'` game with `over: { endReason: 'resignation' }`; `earned(bob)` equals `[['resigned', game.id]]`; `earned(alice)` has no `resigned`.
- `'awards 😈 at the fifth loss to one person, games against others between'`: a third user `carol`; Alice loses to Bob on days 2–5, loses to Carol on day 6, beats Bob on day 7, loses to Bob on day 8; award each in order; `nemesis_5` is Alice's, at the day-8 game; she earns no `nemesis_5` at any earlier game.
- `'awards 👬 to both players at their fifth game together'`: five games Alice vs Bob with mixed results and colours; both earn `rival_5` at the fifth game.
- `'awards 🗑️ at the tenth rated loss in a row, with 👶 at the third and 💩 at the fifth'`.
- `'counts games against a player who deleted their data'`: five games Alice vs Bob, Bob's data deleted (as in `'skips a player who deleted their data'`) before the fifth is awarded; Alice earns `rival_5` at the fifth.

- [ ] **Step 3: Run to verify failure**

Run: `pnpm vitest run packages/shared/test/flair apps/server/test/integration/flair-award.test.ts`
Expected: FAIL on the new tests only.

- [ ] **Step 4: Implement**

Add the eight entries to `FLAIR` at the positions above (the dubious ones after `bongcloud_win`, the feats after `draws_10`) and the eight `flair.<id>` strings to `en.ts` in the same order. Run `node scripts/vendor-snapshot-art.mjs` (it fetches Noto SVGs from GitHub) and check `flairEmoji.ts` now has a key for every id.

- [ ] **Step 5: Update existing expectations**

Run: `pnpm vitest run apps/server/test packages/shared/test apps/miniapp/test`
For each existing test that now fails only because a new flair is earned (typically `rival_5` after five fixture games between the same pair, or a loss streak for the fixture's loser), add the new award to the expected list at the game that earns it; do not filter it out. In `flair-backfill.test.ts`'s `'awards each rule kind from history…'`, also add one resigned loss and five games against one opponent if they are not already implied, so `added` covers `resigned` and `rival_5`. Switch the Task 2 walk test to `flair('resigned', 'rival_5')`.

- [ ] **Step 6: Verify**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm format:check`
Expected: all PASS.

- [ ] **Step 7: Commit** — `git commit -m "Flair: third batch (🐢 🕊️ 👬 👶 💩 🗑️ 😈 🐔)"`

### Task 5: Full gates

- [ ] **Step 1:** Run `pnpm test && pnpm typecheck && pnpm lint && pnpm format:check && pnpm check:budget && pnpm check:licences`. Expected: all pass.
- [ ] **Step 2:** Render the visual samples (`apps/server/test/visual/render-samples.ts`, as its header describes) with a player wearing 🕊️ 🗑️ 🐔 and confirm the three emoji draw on the share image.
- [ ] **Step 3:** Open the Mini App's Flair screen at 390 px (`pnpm e2e` covers it) and confirm the two sections list the new flair in order with no overflow.
