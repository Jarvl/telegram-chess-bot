# One Live DM per Game Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each player's DM chat with the bot holds at most one live message per game or challenge; new DMs for draw offers and results; flair on every name.

**Architecture:** A `dm_messages` table records every live DM. `send_dm` builds text from current state, sends, then (under the game/challenge row lock) replaces the live row and enqueues a `retire_dm` job for the previous message. `retire_dm` deletes a message under 47 h old, otherwise edits it to its stored stub; the same job also performs the silent "waiting" edit after the player moves. Domain triggers (move, draw offer, game end, challenge resolution, account deletion) call small helpers in `src/domain/dms.ts` inside their existing transactions.

**Tech Stack:** TypeScript, Drizzle ORM on PostgreSQL, grammY `Api`, Vitest with the fake Bot API (`test/helpers/fakeTelegram.ts`).

**Spec:** `docs/superpowers/specs/2026-09-29-dm-notifications-design.md`

## Global Constraints

- All paths below are relative to `apps/server/` unless they start with `packages/` or `docs/`.
- Integration runs need `TEST_DATABASE_URL` exported (see docs/testing.md); `pnpm vitest run …` commands run from `apps/server/`.
- Every person named in any DM or stub is rendered with `nameWithFlair` (`src/domain/users.ts`), never `displayName`.
- Delete-versus-stub threshold: `DM_DELETE_WINDOW_MS = 47 * 60 * 60 * 1000`; age `< 47 h` → `deleteMessage`, `≥ 47 h` → edit to stub with no keyboard.
- Edits never notify; only `sendMessage` for turn, reminder, draw offer, challenge and result DMs notifies.
- Bot games (`isEngineGame`) never produce DMs or rows. Abort, timeout-abort and voided games send no result DM.
- `send_dm` dedup key: `dm:{userId}:g:{gamePublicId}` for game DMs, `dm:{userId}:ch:{challengePublicId}` for challenge DMs, always enqueued with `mergePayload: true`.
- `retire_dm` dedup key: `dmmsg:{chatId}:{telegramMessageId}`, always with `mergePayload: true`, so a later retire overrides a pending waiting edit for the same message.
- Copy (en.ts keys, exact values):
  - `dm.draw_offer`: `{opponent} offers a draw · {lastMove} · {timeLeft} left`
  - `dm.draw_offer.no_clock`: `{opponent} offers a draw · {lastMove}`
  - `dm.draw_offer.first`: `{opponent} offers a draw · {timeLeft} left`
  - `dm.draw_offer.first_no_clock`: `{opponent} offers a draw`
  - `dm.draw_offer_line`: `{opponent} offers a draw.`
  - `dm.result.win`: `You won vs {opponent} · {reason}`
  - `dm.result.draw`: `Draw vs {opponent} · {reason}`
  - `dm.result.loss`: `You lost vs {opponent} · {reason}`
  - `dm.result.rating`: ` · {rating} ({change})`
  - `dm.waiting`: `✓ You played {move} · waiting for {opponent}`
  - `dm.stub.game_ended`: `Game vs {opponent} ended`
  - `dm.stub.challenge.accepted` / `.declined` / `.cancelled` / `.expired`: `Challenge from {challenger} accepted` (resp. `declined`, `cancelled`, `expired`)
  - `dm.stub.deleted`: `Game ended`
- Rating change label: `Math.round(after) − Math.round(before)` shown as `+8`, `−2` (U+2212), `±0`; rating shown with `ratingLabel(after, isProvisional(rdAfter))` from `@group-chess/shared`.

## Review Focus

1. **A player with DMs off moves, gets a draw offer, or finishes a game** — no rows, no Telegram calls, no errors. Tests in Tasks 6 and 7.
2. **A premove plays for its owner** — the owner's live DM gets the waiting edit and they receive no turn DM; the other player gets the turn DM. Test in Task 6.
3. **A second event for the same player and game arrives while `send_dm` is running** — the worker reruns the job with the merged payload and exactly one message goes out for the latest state. Test in Task 2 (merge) and Task 5 (content from state).
4. **A deleted opponent** — stubs and DMs say `Deleted player` with no flair. Test in Task 3.
5. **The game ends while the result recipient has DMs off** — both players' live rows are still retired. Test in Task 7.

---

### Task 1: `dm_messages` table

**Files:**
- Modify: `src/db/schema.ts` (new table after `games`)
- Create: `drizzle/0009_dm_messages.sql` via `pnpm --filter @group-chess/server db:generate` (plus the generated `drizzle/meta` files)
- Modify: `test/helpers/db.ts:19` (add `dm_messages` to the truncate list, before `games`)
- Test: `test/integration/db.test.ts`

**Interfaces:**
- Produces: `dmMessages` table and `type DmMessageRow = typeof dmMessages.$inferSelect`; `type DmKind = 'turn' | 'reminder' | 'draw_offer' | 'waiting' | 'challenge'`.

Columns: `id` (id()), `userId` bigint → users not null, `chatId` bigint not null (the user's Telegram id when sent; kept so retires work after Delete my data nulls it), `gameId` bigint → games null, `challengeId` bigint → challenges null, `telegramMessageId` bigint not null, `kind` text `$type<DmKind>()` not null, `stub` text not null (text to leave if the message can no longer be deleted), `sentAt` tz not null. Check `(game_id is null) <> (challenge_id is null)`; unique index `dm_messages_user_game` on `(user_id, game_id)` where `game_id is not null`; unique `dm_messages_user_challenge` on `(user_id, challenge_id)` where `challenge_id is not null`.

The `stub` and `chat_id` columns are additions to spec §1: storing the stub at write time removes any need to reconstruct the waiting line later.

- [ ] **Step 1: Write the failing tests** in `db.test.ts`: `it('allows one live DM per user and game')` inserts two rows for the same `(userId, gameId)` and expects the second to reject with a unique violation; `it('requires exactly one of game and challenge on a DM row')` expects a row with both null and a row with both set to reject.
- [ ] **Step 2: Run** `pnpm vitest run test/integration/db.test.ts` — expected FAIL (`dmMessages` not exported).
- [ ] **Step 3: Add the table** to `schema.ts`, run `db:generate`, rename the generated file to `0009_dm_messages.sql` (and its journal tag), update `truncateAll`.
- [ ] **Step 4: Run** the same command — expected PASS.
- [ ] **Step 5: Commit** `git commit -m "dm_messages: one live DM per user and game or challenge"`.

### Task 2: Payload-merging dedup in `enqueue`

**Files:**
- Modify: `src/jobs/queue.ts`
- Test: `test/integration/jobs.test.ts`

**Interfaces:**
- Produces: `EnqueueInput.mergePayload?: boolean` — on a dedup conflict with a pending job, sets `payload = jobs.payload || excluded.payload` in addition to the existing re-arm.

- [ ] **Step 1: Write the failing tests:**
  - `it('merges the payload of a re-armed job when asked')`: enqueue `{ kind: 'send_dm', dedupKey: 'k', payload: { template: 'turn', premovesCancelled: true }, mergePayload: true }`, then the same key with `{ template: 'draw_offer' }`; expect one pending row with payload `{ template: 'draw_offer', premovesCancelled: true }`.
  - `it('reruns a job re-armed with a merged payload while it was running')`: a handler that, on its first call, enqueues the same key with `{ n: 2 }` and records `job.payload.n`; after `worker.runOnce()` twice, the recorded values are `[1, 2]` and the job ends done.
- [ ] **Step 2: Run** `pnpm vitest run test/integration/jobs.test.ts` — expected FAIL.
- [ ] **Step 3: Implement** the option in `enqueue`'s `onConflictDoUpdate` branch (`payload: sql\`${jobs.payload} || excluded.payload\``). Without the flag behaviour is unchanged.
- [ ] **Step 4: Run** — expected PASS.
- [ ] **Step 5: Commit** `git commit -m "enqueue: optional payload merge on dedup"`.

### Task 3: DM copy and pure rules

**Files:**
- Modify: `packages/shared/src/i18n/en.ts` (keys from Global Constraints)
- Create: `src/telegram/dmText.ts`
- Create: `src/domain/dmRules.ts`
- Test: `test/unit/dmText.test.ts`, `test/unit/dmRules.test.ts`

**Interfaces:**
- Produces, `src/telegram/dmText.ts` (all names arrive already rendered with `nameWithFlair`):
  - `moveLabel(ply: number, san: string): string` (moved from `jobs/handlers/telegram.ts`)
  - `turnText(p: { opponent: string; lastMove: string | null; timeLeft: string | null; drawOffered: boolean; premovesCancelled: boolean }): string` — existing `dm.turn*` key, then `\n\n` + `dm.draw_offer_line`, then `\n\n` + `dm.premoves_cancelled`, each only when set.
  - `reminderText(p: { opponent: string; timeLeft: string }): string`
  - `drawOfferText(p: { opponent: string; lastMove: string | null; timeLeft: string | null }): string`
  - `resultText(p: { outcome: 'win' | 'draw' | 'loss'; opponent: string; endReason: EndReason; rating: { before: number; after: number; rdAfter: number } | null }): string` — reason via `t(\`end_reason.${endReason}\`)`.
  - `waitingText(p: { move: string; opponent: string }): string`
  - `gameEndedStub(opponent: string): string`, `challengeStub(challenger: string, status: 'accepted' | 'declined' | 'cancelled' | 'expired'): string`, `deletedStub(): string`
- Produces, `src/domain/dmRules.ts`:
  - `DM_DELETE_WINDOW_MS = 47 * 60 * 60 * 1000`
  - `canDelete(sentAt: Date, now: Date): boolean`
  - `resultRecipients(endReason: EndReason, endedBy: Colour | null): Colour[]` — `[]` for `abort`, `timeout_abort`, `voided`; both colours when `endedBy` is null; otherwise the opposite of `endedBy`.

- [ ] **Step 1: Write the failing tests:**
  - `turnText({ opponent: '@bob 👑', lastMove: '12. Nf3', timeLeft: '2 d', drawOffered: true, premovesCancelled: false })` → `'Your move vs @bob 👑 · 12. Nf3 · 2 d left\n\n@bob 👑 offers a draw.'`; with both flags → offer line before premoves line.
  - `drawOfferText` for all four combinations of `lastMove`/`timeLeft` null.
  - `resultText({ outcome: 'win', opponent: '@bob', endReason: 'resignation', rating: { before: 1504.4, after: 1512.3, rdAfter: 60 } })` → `'You won vs @bob · Resignation · 1512 (+8)'`; loss with before 1499, after 1490 → `(−9)`; draw with equal rounded → `(±0)`; `rating: null` → no rating part.
  - `waitingText({ move: '12… Nf6', opponent: '@tom 🔥' })` → `'✓ You played 12… Nf6 · waiting for @tom 🔥'`; `challengeStub('@alice', 'expired')` → `'Challenge from @alice expired'`.
  - `gameEndedStub(nameWithFlair(deletedUser))` → `'Game vs Deleted player ended'` (a deleted user with `flairWorn` set wears none).
  - `canDelete` at `sentAt + 46h59m` → true, at `sentAt + 47h` → false.
  - `resultRecipients('checkmate', 'white')` → `['black']`; `('timeout', null)` → `['white', 'black']`; `('draw_agreement', 'black')` → `['white']`; `('abort', 'white')`, `('timeout_abort', null)`, `('voided', null)` → `[]`.
- [ ] **Step 2: Run** `pnpm vitest run test/unit/dmText.test.ts test/unit/dmRules.test.ts` — expected FAIL.
- [ ] **Step 3: Implement** the keys and functions. `moveLabel` keeps today's output (`12... Nf6` for Black).
- [ ] **Step 4: Run** — expected PASS.
- [ ] **Step 5: Commit** `git commit -m "DM copy: draw offer, result, waiting line and stubs"`.

### Task 4: Live-row helpers and the `retire_dm` job

**Files:**
- Create: `src/domain/dms.ts`
- Create: `src/jobs/handlers/dm.ts`
- Modify: `src/jobs/types.ts` (add `'retire_dm'` to `JOB_KINDS`)
- Modify: `src/jobs/handlers/telegram.ts` (register `retire_dm: retireDm(ctx)` in `telegramJobHandlers`)
- Test: `test/integration/dm-messages.test.ts` (new; same setup as `telegram-handlers.test.ts`)

**Interfaces:**
- Consumes: `dmMessages`, `DmKind` (Task 1); `mergePayload` (Task 2); `canDelete` (Task 3).
- Produces, `src/domain/dms.ts` (every function runs inside the caller's transaction):
  - `recordDm(tx, row: { userId: number; chatId: number; gameId?: number; challengeId?: number; telegramMessageId: number; kind: DmKind; stub: string }): Promise<void>` — replaces the user's live row for that game/challenge (`sent_at = now()`) and retires the previous message, if any, with its own stored stub.
  - `retireGameDms(tx, gameId: number, stubFor?: (row: DmMessageRow) => string): Promise<void>` — removes every row for the game and enqueues a retire for each (stub defaults to the row's own).
  - `retireChallengeDms(tx, challengeId: number, stub: string): Promise<void>`
  - `retireUserDms(tx, userId: number, stub: string): Promise<void>`
  - `markWaiting(tx, p: { userId: number; gameId: number; text: string }): Promise<void>` — if a row exists: set `kind = 'waiting'`, `stub = text`, enqueue a `wait` action for its message. No row → nothing.
  - `dropUserDms(tx, userId: number): Promise<void>` — deletes rows, no jobs.
  - `retire_dm` payload: `{ userId: number; chatId: number; telegramMessageId: number; sentAt: string /* ISO */; action: 'retire' | 'wait'; text: string; gameId?: number }`, dedup key per Global Constraints.
- Produces, `src/jobs/handlers/dm.ts`: `retireDm(ctx: TelegramHandlerContext): JobHandler`.
  - `retire`: `canDelete(sentAt, dbNow)` → `deleteMessage(chatId, messageId)`; else `editMessageText(chatId, messageId, text, { reply_markup: { inline_keyboard: [] } })`.
  - `wait`: `editMessageText` with `text` and one `♟ Open game` button (`miniAppLink(config, { kind: 'game', gameId: publicId })`).
  - Failures go through `call`/`settle`; `blocked` also runs `setDmAllowed(false)` and `dropUserDms`.

- [ ] **Step 1: Write the failing tests:**
  - `it('replaces the live row and deletes the old message')`: `recordDm` twice for the same user/game with message ids 101 then 102; one row with 102; run worker; one `deleteMessage` call with `{ chat_id: 11, message_id: 101 }`.
  - `it('edits a message older than 47 hours to its stub')`: insert a row, `update dm_messages set sent_at = now() - interval '47 hours'`, `retireGameDms`; worker; no `deleteMessage`; `editMessageText` body `{ message_id, text: <stub>, reply_markup: { inline_keyboard: [] } }`.
  - `it('applies the waiting edit with an Open game button')`: `markWaiting` then worker → `editMessageText` with `text: '✓ You played 1. e4 · waiting for @bob'` and one `♟ Open game` button; row kind is `waiting`, stub equals the text.
  - `it('lets a retire override a pending waiting edit for the same message')`: `markWaiting` then `retireGameDms` before running the worker → exactly one Telegram call, a `deleteMessage`.
  - `it('treats a missing message as done')`: `fake.failNext('deleteMessage', { error_code: 400, description: 'Bad Request: message to delete not found' })` → job done.
  - `it('turns DMs off and forgets rows when the user blocked the bot')`: `failNext` 403 blocked on `editMessageText` → `dmAllowed` false, no rows for the user.
- [ ] **Step 2: Run** `pnpm vitest run test/integration/dm-messages.test.ts` — expected FAIL.
- [ ] **Step 3: Implement** `dms.ts`, `dm.ts`, the job kind and registration.
- [ ] **Step 4: Run** — expected PASS.
- [ ] **Step 5: Commit** `git commit -m "retire_dm: delete or stub a replaced DM, and the silent waiting edit"`.

### Task 5: `send_dm` records live rows, adds draw-offer and result templates, uses flair

**Files:**
- Modify: `src/jobs/handlers/dm.ts` (move `sendDm` and `dmContent` here from `telegram.ts`)
- Modify: `src/jobs/handlers/telegram.ts` (remove the moved code; register `send_dm: sendDm(ctx)` from `dm.ts`)
- Modify: `test/helpers/fakeTelegram.ts` (`onSend` hook, see Step 3)
- Test: `test/integration/telegram-handlers.test.ts` (`describe('send_dm')`)

**Interfaces:**
- Consumes: Task 3 text functions; Task 4 `recordDm`, `retire_dm` payload.
- Produces: `send_dm` payload `{ userId: number; template: 'turn' | 'reminder' | 'draw_offer' | 'result' | 'challenge'; gameId?: number; challengeId?: number; premovesCancelled?: boolean }`.

Content rules (build from current state, return `null` when nothing applies):
- `challenge`: as today, name via `nameWithFlair`; row kind `challenge`, stub `challengeStub(challenger, 'expired')` (overridden by the Task 8 triggers).
- `result`: game must be `finished` and not engine; outcome from `game.result` and the user's colour; rating from the user's colour's `*RatingBefore/After`, `*RdAfter` when `game.rated` and all non-null. Buttons Open game · Go to group. **No row is recorded.**
- `turn` / `reminder` / `draw_offer`: game `active` and it is the user's move, otherwise `null`. `draw_offer` falls back to `turn` text when the opponent's offer is no longer standing. `turn` sets `drawOffered` when `game.drawOfferBy` is the opponent's colour. Row kind = template, stub `gameEndedStub(opponent)`.

Send flow after `sendMessage` succeeds (not for `result`): one transaction that locks the game (`requireGameById(tx, id, { forUpdate: true })`) or challenge row `for update`, then rebuilds content:
- game no longer active / challenge no longer pending → no row; enqueue `retire` for the sent message with `gameEndedStub` / `challengeStub(challenger, status)`.
- game active but no longer the user's move → `recordDm` as `waiting` with `stub = waitingText(user's last move, opponent)` and enqueue a `wait` for it.
- otherwise `recordDm` with the template's kind and stub.

- [ ] **Step 1: Update and add tests:**
  - Existing expectations change to flair-aware names only where fixtures wear flair; set Bob's `flairWorn: ['rank_under_1200']` in `it('sends the turn DM with both buttons…')` and expect `'Your move vs Bob 🦍 · 1. e4 · 23 h left'`.
  - `it('records the turn DM as the live row')` → one `dm_messages` row, kind `turn`, `telegram_message_id` equal to the sent message id.
  - `it('adds the draw offer line when the opponent offered with their move')` → text ends `\n\nBob offers a draw.`
  - `it('sends the draw offer DM')` (template `draw_offer`, Alice to move, `drawOfferBy: 'white'` Bob) → `'Bob offers a draw · 1. e4 · 23 h left'`, row kind `draw_offer`.
  - `it('sends the result DM with the rating change and records no row')` → finished rated game, Alice black lost by resignation, ratings 1500→1491 → `'You lost vs Bob · Resignation · 1491 (−9)'`; zero rows.
  - `it('records a DM sent after the player already moved as waiting')`: set `fake.onSend` to insert Alice's reply move (`insertMove` + update `fen`/`plyCount`) → after the worker, row kind `waiting` and one `editMessageText` wait call.
  - `it('retires a DM that lands after the game ended')`: `fake.onSend` sets the game `finished` → no row, one `deleteMessage` for the sent message.
- [ ] **Step 2: Run** `pnpm vitest run test/integration/telegram-handlers.test.ts` — expected FAIL on the new cases.
- [ ] **Step 3: Implement.** For the two race tests add `onSend: (() => Promise<unknown>) | null` to `FakeTelegram`, awaited in `sendMessage` before answering (mirrors the existing `onFile`), and reset it in `reset()`.
- [ ] **Step 4: Run** `pnpm vitest run test/integration/telegram-handlers.test.ts` — expected PASS.
- [ ] **Step 5: Commit** `git commit -m "send_dm: live rows, draw offer and result DMs, flair in names"`.

### Task 6: Move, draw offer and reminder triggers

**Files:**
- Modify: `src/domain/games.ts` (`commitMove`)
- Modify: `src/domain/draws.ts` (`offerDraw`)
- Modify: `src/clock/scanners.ts` (`sendDueReminders`)
- Modify: `src/domain/challenges.ts` (`acceptChallenge` turn DM key only)
- Test: `test/integration/games.test.ts`, `test/integration/draws.test.ts`, `test/integration/premoves.test.ts`, `test/integration/scanners.test.ts`, `test/integration/challenges.test.ts`

**Interfaces:**
- Consumes: `markWaiting` (Task 4); `waitingText`, `moveLabel` (Task 3); `mergePayload` (Task 2).

Changes:
- `commitMove`, human games only: after the move insert, `markWaiting(tx, { userId: <mover id>, gameId, text: waitingText({ move: moveLabel(ply, san), opponent: nameWithFlair(opponent) }) })`. The recursive premove call does the same for the premove's owner. Turn DM dedup key becomes `dm:${opponentId}:g:${game.publicId}` with `mergePayload: true`.
- `offerDraw`: when the recipient (the other colour) is to move, enqueue `send_dm` `{ userId: recipient, template: 'draw_offer', gameId }` with the game key and `mergePayload: true`. When the offerer is to move, enqueue nothing.
- `sendDueReminders`: key `dm:${userId}:g:${game.publicId}`, `mergePayload: true`.
- `acceptChallenge`: key `dm:${white.id}:g:${game.publicId}`, `mergePayload: true`.

- [ ] **Step 1: Update and add tests:**
  - Update every dedup-key assertion listed in the spec (§5 item 8): `games.test.ts:77`, `premoves.test.ts:74,114,130,150`, `scanners.test.ts:84`, `challenges.test.ts:166` to the `dm:{u}:g:{pub}` form.
  - `games.test.ts` `it('marks the mover\'s live DM as waiting')`: insert a `dm_messages` row for Bob, Bob moves `e2e4` → row kind `waiting`, stub `'✓ You played 1. e4 · waiting for Alice'`, one pending `retire_dm` with `action: 'wait'`.
  - `games.test.ts` `it('does nothing for a mover with no live DM')` → no `retire_dm` job.
  - `premoves.test.ts` `it('marks the premove owner\'s DM as waiting and sends them no turn DM')`.
  - `draws.test.ts`: `it('sends a draw offer DM when the recipient is to move')` → one `send_dm` job, payload template `draw_offer`; `it('sends no DM for an offer by the player to move')` → no `send_dm`; `it('sends no draw offer DM in a bot game')` stays covered by the existing engine refusal.
- [ ] **Step 2: Run** `pnpm vitest run test/integration/games.test.ts test/integration/draws.test.ts test/integration/premoves.test.ts test/integration/scanners.test.ts test/integration/challenges.test.ts` — expected FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command — expected PASS.
- [ ] **Step 5: Commit** `git commit -m "DM triggers: waiting edit on move, draw offer DM, one DM key per game"`.

### Task 7: Game end — result DMs and retiring live rows

**Files:**
- Modify: `src/domain/games.ts` (`finishGame`, `commitMove`, `resign`, `applyTimeout`)
- Modify: `src/domain/draws.ts` (`acceptDraw`, `claimDraw`)
- Test: `test/integration/games.test.ts`, `test/integration/draws.test.ts`, `test/integration/scanners.test.ts`

**Interfaces:**
- Consumes: `retireGameDms` (Task 4); `resultRecipients` (Task 3).
- Produces: `finishGame(tx, game, end, now, endedBy: Colour | null = null): Promise<GameRow>`.

Callers pass `endedBy`: `commitMove` → mover's colour; `resign` → resigner; `acceptDraw` → acceptor; `claimDraw` → claimer; `applyTimeout` and `voidGame` → null; `abortGame` → the aborter (no DM either way); `deleteMyData` (Task 8) → the deleted user's colour.

In `finishGame`, for human games only: `retireGameDms(tx, game.id, row => row.kind === 'waiting' ? row.stub : gameEndedStub(<opponent of row.userId, nameWithFlair>))`, then for each colour in `resultRecipients(end.endReason, endedBy)` enqueue `send_dm` `{ userId, template: 'result', gameId }` with the game key and `mergePayload: true`.

- [ ] **Step 1: Write the failing tests:**
  - `games.test.ts` `it('sends the result DM to the player who did not resign')` → one `send_dm` job for the non-resigner, template `result`.
  - `games.test.ts` `it('sends the result DM to the mated player only')`.
  - `scanners.test.ts` `it('sends the result DM to both players on timeout')`.
  - `draws.test.ts` `it('sends the result DM to the offerer when the draw is accepted')`; `it('sends the result DM to the claimer\'s opponent')`.
  - `games.test.ts` `it('sends no result DM for an abort or a void')`.
  - `games.test.ts` `it('retires both players\' live DMs when the game ends, even with DMs off')`: rows for both players, the result recipient has `prefs.notifications = false`; resign → zero rows, two `retire_dm` jobs, the resigner's waiting row keeps its waiting stub, the other gets `'Game vs … ended'`.
  - Existing `engine-move-flow.test.ts` assertions that bot games enqueue no `send_dm` must still pass unchanged.
- [ ] **Step 2: Run** `pnpm vitest run test/integration/games.test.ts test/integration/draws.test.ts test/integration/scanners.test.ts test/integration/engine-move-flow.test.ts` — expected FAIL on the new cases.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command — expected PASS.
- [ ] **Step 5: Commit** `git commit -m "Game end: result DM to the player who did not end it, retire live DMs"`.

### Task 8: Challenge resolution and Delete my data

**Files:**
- Modify: `src/domain/challenges.ts` (`acceptChallenge`, `declineChallenge`, `cancelChallenge`, `expireChallenges`)
- Modify: `src/domain/account.ts` (`deleteMyData`)
- Test: `test/integration/challenges.test.ts`, `test/integration/users-groups.test.ts` (or wherever `deleteMyData` is tested: `grep -ln deleteMyData test/integration`)

**Interfaces:**
- Consumes: `retireChallengeDms`, `retireUserDms` (Task 4); `challengeStub`, `deletedStub` (Task 3); `finishGame(..., endedBy)` (Task 7).

Changes: each challenge transition calls `retireChallengeDms(tx, challenge.id, challengeStub(nameWithFlair(challenger), <new status>))` (accept → `accepted`, decline → `declined`, cancel → `cancelled`, expiry → `expired`; `deleteMyData`'s own challenge updates use the status it sets). `deleteMyData` calls `retireUserDms(tx, userId, deletedStub())` **first**, before its `finishGame` loop (so its rows get `Game ended`, not the game-end stub) and before the user row is anonymised; it passes the deleted user's colour as `endedBy` to `finishGame`.

- [ ] **Step 1: Write the failing tests:**
  - `challenges.test.ts`: for each of accept, decline, cancel, expire, a live challenge row for Bob → zero rows and one `retire_dm` with `text: 'Challenge from Alice <status>'`.
  - account test: `it('retires every live DM of a deleted user')` → rows for two games and a challenge are gone, three `retire_dm` jobs with `text: 'Game ended'`, each payload keeps the original `chatId`; the opponent gets a `result` `send_dm`.
- [ ] **Step 2: Run** `pnpm vitest run test/integration/challenges.test.ts <account test file>` — expected FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — expected PASS; then the whole suite `pnpm test` from the repo root with `TEST_DATABASE_URL` set — expected all green.
- [ ] **Step 5: Commit** `git commit -m "Retire challenge DMs on resolution and all DMs on Delete my data"`.

### Task 9: Docs

**Files:**
- Modify: `docs/PRD.md` §7.7 (DM bullet) and §7.13 (game-end line)

§7.7 DM bullet, replacement text: a DM when it becomes your move, when 10 % of the move time remains (8 h controls and up), when your opponent offers a draw while it is your move, when you are challenged, and when a game ends by something other than your own action; each game or challenge keeps at most one live bot message, older ones are deleted (or reduced to one line after two days); names carry worn flair. §7.13: "The game-end notification stays" → "The in-app game-end result stays; no DM is sent."

`docs/operations.md` has no job list, so spec §6's second bullet is dropped.

- [ ] **Step 1: Edit** the two PRD passages.
- [ ] **Step 2: Commit** `git commit -m "PRD: one live DM per game, draw offer and result DMs"`.
