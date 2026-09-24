# Premoves

Status: accepted for planning, 2026-09-24. Implements the premove behaviour of the Chess Goat
prototype (`Chess Goat Prototype.dc.html`: `onPremoveSquare`, `firePremove`, `premoveBoard`, the
premove stepper and the premove chips in the move strip). Replaces "No premoves" in §2 of the
[technical design](./2026-09-20-group-chess-technical-design.md). The prototype's Share Position
changes are not part of this spec.

## Why

A player who can see their reply coming wants to enter it now and put the phone down, not wait for
the opponent's move, then open the app again for a move they already chose. Premoves let them
queue a chain of moves while it is not their turn. The server plays each one the moment the
opponent's move lands, even with the app closed.

## Behaviour

- While it is the opponent's turn, a player can queue a **chain** of premoves. Each one is made on
  the **imagined position**: the real position with their earlier premoves applied.
- Queuing never asks for confirmation, whatever the Move confirmations setting says.
- A premove that promotes a pawn opens the usual promotion picker. The chosen piece is saved with
  the premove.
- Premoves are stored on the server. Only their owner can see them. The opponent and spectators
  cannot, not even when a premove is queued or removed.
- When the opponent moves, the server checks the **first** premove against the real position.
  - **Legal:** the server plays it in the same transaction. It counts as a normal move: it resets
    the clock and makes an offer by the opponent lapse. The owner gets no turn DM. The opponent
    gets the usual flow, with the turn DM and card edit (or the bot's reply).
  - **Illegal:** that premove and every one after it are dropped. The owner gets the usual turn
    DM with an extra line, "Your premoves were cancelled." The Mini App shows a toast if it is
    open. Bot games send no DM, as they already don't (engine spec §8).
- One premove plays per opponent move. The rest of the chain waits for the next reply.
- The queue is emptied when the game ends for any reason, and at most **10** premoves can be
  queued at once.
- Premoves work in bot games too. The bot's move triggers them the same way.

### Which squares a premove may target

Premoves use the **pattern rule**, as on Lichess. A piece may target any square its movement
pattern reaches from its square in the imagined position. The rule ignores blocking pieces, check,
and what occupies the target, because the opponent's move may change all of those before the
premove is checked for real.

| Piece | Targets |
|---|---|
| Pawn | One square forward; two forward from its start rank; one diagonally forward (either side), occupied or not |
| Knight | The eight L-shapes |
| Bishop, rook, queen | Every square on their lines to the board edge |
| King | The eight adjacent squares; plus castling, see below |

The only exception is the piece's own square. A target holding one of the player's own pieces is
allowed. The typical case is a recapture on a square the opponent is about to take.

**Castling.** The king may target g1/c1 (g8/c8 for Black) when it stands on e1 (e8) in the imagined
position, a rook of the same colour stands on h1/a1 (h8/a8), and the real position's castling
rights for that side survive the chain. Any earlier premove from or to e1, a1 or h1 (or the
matching Black squares) removes the rights it touches.

**Promotion.** A pawn target on the last rank requires a promotion piece (`q`, `r`, `b`, `n`). No
other premove may carry one.

**The imagined position** comes from applying each premove in turn:
- The piece moves from `from` to `to`, replacing whatever was on `to`.
- A promotion puts the chosen piece on `to`.
- A king moving two files from its start square also moves that side's rook, as in castling.
- There is no en passant removal. A pawn premoved diagonally to an empty square just moves there.

The imagined position can be illegal as chess, and that is expected. It is only a board layout.
Premoves are checked properly, with the arbiter, when they fire.

The pattern rule and the imagined position live in one pure module,
`packages/shared/src/chess/premove.ts`, which uses no chess.js. The server validates with it and
the Mini App offers targets with it, so a square the board accepts is always one the server
accepts.

## Server

### Data

Migration `0004_premoves` adds:

```sql
ALTER TABLE games ADD COLUMN premoves text[] NOT NULL DEFAULT '{}';
```

`premoves` is an ordered list of UCI strings (`e7e5`, `e2e1q`). Its owner is always the side
**not** to move. A premove can only be queued when it is not your turn, and a queue that reaches
its owner's turn is played or cleared in that same transaction. So the owner does not need its own
column.

`schema.ts` adds the column to `games`. The row is already locked `FOR UPDATE` by every
transaction that touches premoves, so no new locking is needed.

### API

Both routes are for the game's players only. They lock the row with `lockActiveGame`, so a
deadline that has passed forfeits first, as it does for every other action. Both return the
caller's `GameDto`.

**Neither route bumps `games.version` or calls `bus.publish`.** A publish would push an event to
every open stream on the game, including the opponent's. Even with nothing visible in its DTO,
the event's timing would show when the other player premoves.

`POST /api/games/:id/premoves` with body `PremoveRequestSchema = { uci, expectedPly }`:

| Check, in order | Error |
|---|---|
| The game is over | `stale_state` (from `lockActiveGame`) |
| It is the caller's turn | `not_your_turn` (they should make the move instead) |
| `expectedPly !== plyCount` | `stale_state`, `{ plyCount }` |
| The queue already has 10 | `limit_exceeded`, `{ reason: 'premove_limit' }` |
| `from` does not hold the caller's piece in the imagined position, the pattern rule does not reach `to`, or the promotion suffix is missing or not allowed | `illegal_move` |

If every check passes, the premove is appended and the updated DTO is returned.

`DELETE /api/games/:id/premoves?from=k&expectedPly=n` keeps the first `k` premoves and drops the
rest. `from=0` clears the queue. It uses the same turn, ply and game-over checks as above. A `k`
beyond the queue length is a no-op.

### Firing: inside the move transaction

`playMove`'s transaction body is split out as `commitMove(tx, locked, colour, uci, clientMoveId)`.
It does everything the body does today: insert the move row, update the game, finish it if the
move ended it, and handle the card, DM and engine enqueue. It also takes `notifyOpponent` and
`premovesCancelled` flags (described below). `playMove` becomes the lock, the idempotency check,
the ply and turn checks, then `commitMove`.

After `commitMove` plays a move by X and the game continues, it looks at the queue, which belongs
to X's opponent Y:

1. **Empty:** the side effects are unchanged: card edit and Y's turn DM, or the engine enqueue.
2. **First premove legal** (arbiter `applyMove` on the real position and position keys): skip Y's
   turn DM. The card edit still happens because it is deduped per game. Remove the first premove
   and call `commitMove` again for Y with that UCI and
   `clientMoveId = premove:<publicId>:<ply>`. That inner call does X's side effects: the deadline,
   the reminder, the card, X's turn DM or the engine enqueue, and a lapse of any offer by X. It
   also checks the queue again, which is now empty for X, so the recursion is at most one level
   deep.
3. **First premove illegal:** clear the queue. Y's turn DM is enqueued with
   `premovesCancelled: true`, keeping the same dedup key `dm:<Y>:g:<id>:turn:<ply>`. In a bot
   game, where no turn DM is sent, the queue is still cleared and the Mini App toast is the only
   notice.

If a premove ends the game (checkmate, stalemate, a fivefold or 75-move draw, insufficient
material), `finishGame` runs as for any other move. `finishGame` sets `premoves = '{}'`. A normal
move by the queue's owner also clears the queue as a safeguard, although the invariant above says
that cannot happen.

A premove plays even when a threefold or 50-move claim was open to its owner. Premoving means
committing to the move.

`bus.publish` is called once at the end of `playMove`, as now. The opponent's client gets both
moves in one snapshot.

### Engine job

After `playMove`, the `engine_move` handler checks whether the engine is still to move and treats
yes as a stall, which leads to retries and eventually an abort. When the human's premove fires
inside the engine's `playMove`, the engine is to move again at a later ply, and the
`engine_move` job for that ply (deduped per ply) is already enqueued. The check becomes: **the
game is active, the engine is to move, and `plyCount` still equals the ply this job was started
for.**

### DTO

`GameDto` gains `premoves: string[]`. It holds the viewer's own queue when the viewer is the
player not to move, and `[]` for everyone else, spectators included. `buildGameDto` fills it
from `game.premoves`. `GameDtoSchema` declares it `.default([])` so older payloads still parse.

### DM

The `send_dm` payload schema in `jobs/handlers/telegram.ts` gains
`premovesCancelled: z.boolean().optional()`. When it is true, the turn DM text is followed by a
blank line and `t('dm.premoves_cancelled')`. The buttons are unchanged.

## Mini App

### State

`GameStore` gains:

- `premoves: Signal<string[]>`: the DTO's queue, including optimistic appends and truncations.
- `premoveStep: Signal<number | null>`: `null` is the end of the chain, `0` is the current
  position, and `k` is the position after premove `k`.
- `premoveMode` (computed): the game is active, the viewer is a player, it is not their turn,
  they are on the latest ply (`isLatest`), and no move is pending.
- `boardView` (computed): in premove mode, the imagined position after `premoveStep ?? n`
  premoves, with the real last move highlighted. Otherwise it is `position`. `position` itself
  stays the real position, so the clock, check haptics, Share (which sends the real ply) and
  `sideToMove` are unaffected.
- `premoveSquares` (computed): `[from, to]` of the premove being viewed, or `null` at step 0 and
  outside premove mode.
- `dests`: in premove mode at the end of the chain, the pattern-rule targets for the viewer's
  pieces on the imagined position. It is empty at earlier steps. Outside premove mode it is
  unchanged.
- `canMove`: true in premove mode at the end of the chain, as well as on the viewer's turn.

`apply(next)` also treats a DTO whose `premoves` differ from the current ones as new. The premove
endpoints return a DTO with the same version, and this is what lets it through. When `plyCount`
moves on, `premoveStep` resets to `null`.

`state/premoves.ts` holds the Mini App's pure helpers: the chip label for each premove, built from
the imagined position before it (`Nf3`, `Nxf3`, `exd5`, `e8=Q`, `O-O`), and the diff checks used
below.

### Board

Premoves use chessground's normal `movable` path, not its `premovable`:

- `premovable` holds a single premove, and setting another replaces it.
- Its targets would come from chessground's own copy of the pattern rule and could disagree with
  the server's.
- It expects the page to play the premove when the turn changes. Ours plays on the server.

In premove mode the board is given the imagined position, `turnColor` = the viewer, and
`movable = { colour: viewer, dests: premove dests }`.

- `BoardAdapter` gains `setHighlights(squares: string[])`, which draws the viewed premove's two
  squares in `--pm-sq`. The implementation uses chessground's `highlight.custom` if 9.2 has it.
  If it doesn't, the fallback is a CSS class on the matching `square` elements.
- The board wrapper gets a `premove` class in premove mode, which turns the destination dots
  `--pm` blue.
- A tap on the board while viewing an earlier step (`premoveStep !== null`) moves the view to the
  end of the chain, as in the prototype. Pieces cannot be lifted there.

### Queuing (`GameView.onDrop`)

On the viewer's turn, a drop goes through the move machine, unchanged. In premove mode:

1. If the drop is a promotion (pawn to the last rank), the existing picker opens. Cancelling it
   restores the board.
2. The UCI is appended to `store.premoves` optimistically, and `POST /premoves` is sent with
   `{ uci, expectedPly: plyCount }`. Drops are ignored while a premove request is in flight. The
   board's `movable` is set to none for that time.
3. On success, `applyState(dto)` runs. On failure, the optimistic entry is removed and the game
   reloads. A network failure also shows the offline toast. A `stale_state` usually means the
   opponent moved first, and the reload shows the result.

A successful queue plays the light haptic. No Telegram button is shown and no confirmation is
asked.

### Move strip (`MoveList`)

In premove mode, after the real moves, each premove adds a hint-coloured `…` for the opponent's
reply and then a chip with the premove's label. Move numbers continue across both.

- A chip is outlined in `--pm` with `--pm` text. The chip for the step being viewed is filled
  `--pm` with white text.
- Tapping a chip views that step. Tapping the last real move views step 0. That move loses its
  current-move emphasis while a premove is being viewed.
- The strip scrolls to its end when a premove is added.

### Stepper (`ui/game/PremoveBar.tsx`)

It shows under the move strip only in premove mode with a non-empty queue:

```
[◀]  Current position | Premove k of n   [Remove]  [▶]
```

- ◀ and ▶ step through 0…n, and each is dimmed at its end.
- The label is `--text` at step 0 and `--pm` otherwise.
- **Remove** shows for k ≥ 1. It sends `DELETE /premoves?from=k-1&expectedPly=…`, truncates the
  queue optimistically, and moves the view to step k−1. Failures are handled as for queuing.
- Stepping plays the selection haptic, and Remove plays the light one.

### Notices

`diffNotices` gains `premoves_cancelled`. It fires when `plyCount` went up, the previous
`premoves` was not empty, the next is empty, and the move at `prev.plyCount + 2` is not the
previous first premove, or that move does not exist. `GameView` shows
`toast(t('app.game.premoves_cancelled'))` and `tg.hapticNotify('warning')`. A premove that played
comes through as the existing `opponent_moved` notice, with its light haptic.

### Theme

`styles.css` and `tg/theme.ts` gain `--pm`, `--pm-sq` and `--pm-soft`, taken from the prototype:

| Token | Light | Dark |
|---|---|---|
| `--pm` | `#2481cc` | `#6ab2f2` |
| `--pm-sq` | `rgba(36,129,204,.42)` | `rgba(106,178,242,.45)` |
| `--pm-soft` | `#e6f1fa` | `rgba(106,178,242,.14)` |

The Remove button uses the `--pm-soft` background with `--pm` text.

## Copy

`packages/shared/src/i18n/en.ts`:

| Key | Text |
|---|---|
| `dm.premoves_cancelled` | `Your premoves were cancelled.` |
| `app.game.premoves_cancelled` | `Premoves cancelled` |
| `app.game.premove_current` | `Current position` |
| `app.game.premove_step` | `Premove {k} of {n}` |
| `app.game.premove_remove` | `Remove` |
| `app.game.premove_prev` | `Previous premove` (aria label) |
| `app.game.premove_next` | `Next premove` (aria label) |
| `app.settings.move_confirmations_help` | Appends ` Premoves never ask.` |

## Rollout

- Migration 0004 only adds a column with a default, so it is safe to run ahead of the code.
- The server and Mini App ship in one image and deploy together.
- An old Mini App bundle still in a webview cache ignores `premoves`. The schema default covers
  payloads from before the change.
- There is no feature flag.

## Out of scope

- Premoving while a move waits for Confirm move. That can't happen, because it is then the
  player's own turn.
- Reordering or editing a premove in the middle of the chain. Remove, then queue it again.
- Syncing chain edits live to the owner's *other* open devices. Premove edits don't publish, so
  another device catches up on the next real move or a reload. That is the cost of not leaking
  timing to the opponent.
- Share Position changes from the same prototype revision.
- Metrics.

## Testing

**Shared unit (`packages/shared`), `premove.test.ts`:**
- The pattern targets for each piece, which ignore blockers and include own-occupied targets.
- Pawn diagonals to empty squares.
- Castling: allowed and blocked by lost rights, a moved king or a missing rook.
- Promotion suffix rules.
- The imagined position through a chain, covering capture-overwrite, promotion and castling rook
  moves.

**Server integration (`apps/server/test/integration/premoves.test.ts`):**
- Queue, truncate and clear.
- Each rejection in the POST table, and DELETE's turn and ply checks.
- The 10-premove limit.
- A legal premove fires. The owner gets no turn DM and X does. The moves are ordered correctly
  with the right `clientMoveId`.
- An illegal premove clears the queue and enqueues the flagged DM. A bot game gets no DM.
- Privacy: the opponent's and a spectator's DTOs show `[]`, and a premove edit neither publishes
  nor bumps the version.
- A premove that checkmates finishes the game. Resign, abort, timeout and void clear the queue.
- A premove fires after the engine's move. The engine job does not report a stall and the next
  `engine_move` is enqueued. Extend `engine-move-flow.test.ts`.

**Mini App unit:**
- Store: premove mode, steps, `boardView`, dests at the end of the chain versus earlier steps,
  and `apply` on a changed `premoves`.
- `diffNotices` `premoves_cancelled`, fired and cancelled.
- Chip labels.
- `MoveList` chips and `…`.
- `PremoveBar` stepping and Remove.
- The optimistic append and rollback in `GameView`.

**Playwright (`apps/miniapp/e2e/premove.spec.ts`):**
- Queue two premoves on the opponent's turn with no confirm buttons, even with confirmations set
  to Always.
- Step back and forth, and Remove the second.
- The opponent's move over SSE plays the first.
- A cancelled chain shows the toast.

## Docs to update in the same change

- `docs/PRD.md` §7.4: "Who can move" gains the premove exception, and a **Premoves** bullet
  summarises the Behaviour section.
- `docs/superpowers/specs/2026-09-20-group-chess-technical-design.md` §2: "No premoves" points to
  this spec.
