# Chess Goat: one live DM per game

Status: accepted for planning, 2026-09-29. Changes the DM part of PRD §7.7.

## What this is

Today every turn change sends a new "Your move" DM and nothing ever removes the old ones. A player
with a few 3-day games has a private chat with the bot full of out-of-date messages, which is the
kind of noise that gets a bot muted. At the same time, the events a player most needs to hear
about when they are away — a draw offer, a game that ended — send no DM at all.

After this change the chat holds **at most one live message per game or challenge**. When
something needs the player, the bot sends a new message, so Telegram notifies them, and removes
that game's previous one. The game's last message is its result.

Maya and Tom play a 3-day game. Tom moves; Maya's phone buzzes with "Your move vs @tom 👑 · 12. Nf3
· 2d 23h left". She plays 12… Nf6 the next morning, and that message quietly becomes "✓ You played
12… Nf6 · waiting for @tom 👑". When Tom replies, a fresh "Your move" arrives and the old line
disappears. When Tom resigns a week later, Maya gets "You won vs @tom 👑 · Resignation · 1512 (+8)"
and the game leaves nothing else behind.

**Goals**

- One live bot message per game (and per challenge) in each player's DM chat.
- Every DM that asks something of the player still notifies them.
- Players hear about draw offers and about games that end while they are away.
- Names in DMs carry worn flair, as they do in the group.

| In scope | Out of scope |
|---|---|
| The `dm_messages` table and the `retire_dm` job (§1, §3) | Per-type notification settings, quiet hours, time zones |
| Replacing, silently editing and retiring DMs (§2) | Nudging users who have DMs off |
| New DMs: draw offer, game over (§4) | DMs for challenge accepted / declined / expired, or draw declined |
| Flair in every DM name (§4) | Accept / Decline or Rematch buttons inside DMs |
| | Any DM for bot games (unchanged: none, §4.4) |
| | Changes to the Mini App |

## 1. Data: `dm_messages`

Migration `0009_dm_messages.sql`. A row is a DM that is **still live**: the bot will later
replace, edit or retire it.

| Column | Type | Notes |
|---|---|---|
| `id` | identity | |
| `user_id` | bigint → `users` | the recipient |
| `game_id` | bigint → `games`, null | exactly one of `game_id`, `challenge_id` is set |
| `challenge_id` | bigint → `challenges`, null | |
| `telegram_message_id` | bigint | in the user's private chat |
| `kind` | text | `turn`, `reminder`, `draw_offer`, `waiting`, `challenge` |
| `sent_at` | timestamptz | when Telegram accepted the message; drives the 47-hour rule |

Constraints: a check that exactly one of `game_id` / `challenge_id` is set; unique
`(user_id, game_id)` and unique `(user_id, challenge_id)`, each partial on its column being not
null. Result DMs are final and get no row.

## 2. Lifecycle

### 2.1 Sending (the `send_dm` job)

1. Build the message from the game's **current** state (§4). If nothing applies any more — the
   game ended, it is not this user's move, the challenge is no longer pending — send nothing and
   finish.
2. Send it.
3. In one transaction that locks the game (or challenge) row `for update`, the same lock every
   trigger in §2.4 takes:
   - Read the user's live row, replace it with the new message's id, kind and `sent_at`, and
     enqueue `retire_dm` for the old message if there was one. A result DM deletes the row
     instead of replacing it and retires the old message the same way.
   - **Race check.** Rebuild the message from the locked state. If the game has meanwhile ended
     or the challenge is no longer pending, write no row and retire the message just sent. If the
     user has meanwhile moved, write the row as `waiting` and enqueue the §2.2 edit for it.

**Bursts.** If the user's live DM for the game is a turn, reminder or draw offer sent under
10 seconds ago, a new turn, reminder or draw-offer DM edits that message to the new text instead of
sending another, so two events close together notify once.

The send job's dedup key becomes one per user and game, `dm:{userId}:g:{gamePublicId}` (challenge
DMs keep `dm:{userId}:ch:{challengePublicId}`). When a second event for the same user and game
arrives while a send is still pending, the pending job is re-armed with the **newer payload**, so
only one message goes out. Since the content is built from current state at send time, a draw
offer that arrives with a move shows up as the extra line on the turn DM (§4.1).

### 2.2 When the user moves

In the same transaction as the user's move (including a premove the server plays for them),
enqueue a silent edit of their live row for that game: the text becomes the **waiting line**
(§4.3), the keyboard keeps only **♟ Open game**, and the row's kind becomes `waiting`. Edits never
notify and bot messages can be edited at any age. If the user has no live row (DMs off, or they
moved before any DM went out), nothing happens.

### 2.3 Retiring (the `retire_dm` job)

Payload: `{ userId, telegramMessageId, sentAt, stub }`, where `stub` is the one-line text to
leave behind if the message cannot be deleted (§4.3).

- Under **47 hours** since `sent_at`: `deleteMessage`.
- Otherwise: `editMessageText` to `stub`, with no keyboard.

Telegram lets a bot delete its own messages only for 48 hours; 47 leaves room for queue lag. The
threshold is one named constant.

"Message to delete/edit not found" and "bot was blocked" count as done, as for every Telegram job
today. `retire_dm` is not tied to a row: the row has already been replaced or removed when it is
enqueued, so a retry can never touch the newer message.

### 2.4 Triggers

| Event | Recipient | New DM (notifies) | Old live row |
|---|---|---|---|
| Opponent moves; it is your move | you | turn | retired |
| 10 % of the move time left (unchanged rule) | player to move | reminder | retired |
| Draw offered while **you** are to move | you | draw offer | retired |
| Draw offered by a player who is to move | — | none now; it rides on your next turn DM | — |
| You move (or a premove plays for you) | you | — | silently edited to the waiting line (§2.2) |
| Game ends, not by your own action (§4.2) | you | result | retired |
| Game ends by your own action | you | — | retired |
| Game ends by abort, timeout-abort or admin void | both | — | retired |
| You are challenged | you | challenge (unchanged) | — |
| Challenge accepted, declined, cancelled or expired | the challenged player | — | retired |
| Delete my data | you | — | all your rows retired |
| Telegram reports the bot blocked | you | — | all your rows deleted, no Telegram calls |

"Retired" means the row is removed and `retire_dm` is enqueued for its message, in the same
transaction as the event. Declining a draw sends nothing and leaves the draw-offer DM as it is;
the next move turns it into the waiting line.

## 3. Failure handling

- **DMs off or blocked.** `wantsDms` is unchanged; nothing is sent and no row is written. A
  `blocked` failure on send or retire still sets `dmAllowed = false` and now also deletes the
  user's rows.
- **User deleted the message.** Edit or delete answers "not found"; the job is done.
- **Sent, but the row write failed.** The job deletes the message it just sent before failing,
  so the retry's send leaves one message, not two. The unique indexes guarantee at most one row
  per game.
- **429.** Existing `retry_after` handling. Retires are not urgent.
- **Game ends between a send and its row write.** The row write and every trigger lock the same
  game row, so they serialise; the race check (§2.1 step 3) retires a message that lands after
  the end instead of recording it.

## 4. Messages

Every name is `nameWithFlair` (`👑` etc. after the handle), including in stubs. Deleted players and
the bot wear none. A stub's flair is fixed when it is written.

### 4.1 Notifying DMs

| Kind | Text | Buttons |
|---|---|---|
| turn | `Your move vs {opponent} · {lastMove} · {timeLeft} left` (and the three existing variants) | ♟ Open game · Go to group |
| turn, with a pending offer from the opponent | the turn text, a blank line, `{opponent} offers a draw.` | same |
| turn, premoves cancelled | the turn text, a blank line, `Your premoves were cancelled.` (unchanged) | same |
| reminder | `{timeLeft} left for your move vs {opponent}` (unchanged) | same |
| draw offer | `{opponent} offers a draw · {lastMove} · {timeLeft} left` (drop parts as the turn variants do) | same |
| challenge | `{challenger} challenges you · {timePerMove} · {rated}` (unchanged) | ♟ Open |

### 4.2 Result DM

Sent to each player who did not cause the ending:

| End reason | Receives |
|---|---|
| checkmate, stalemate, insufficient material, fivefold, 75-move | the player who did not make the final move |
| threefold / 50-move claim | the claimer's opponent |
| draw agreement | the player who offered |
| resignation (including by Delete my data) | the player who did not resign |
| timeout | both players |
| abort, timeout-abort, voided | nobody |

Text: `You won vs {opponent} · {reason}`, `Draw vs {opponent} · {reason}` or
`You lost vs {opponent} · {reason}`, followed for rated games by ` · {rating} ({±change})`, the
same numbers as the game-end screen. `{reason}` uses the existing `end_reason.*` strings. Buttons:
♟ Open game · Go to group. Rematch stays in the app, one tap away.

### 4.3 Waiting line and stubs

| Situation | Text |
|---|---|
| Waiting line (§2.2), and its stub | `✓ You played {lastMove} · waiting for {opponent}` |
| turn / reminder / draw offer retired unanswered (game ended) | `Game vs {opponent} ended` |
| challenge retired | `Challenge from {challenger} {accepted / declined / cancelled / expired}` |
| Delete my data | `Game ended` (no names) |

The waiting line's stub is the same line without its button, so in slow games the only leftovers
are single `✓ You played …` lines above the current message.

### 4.4 Bot games

Unchanged: no DMs of any kind, so no rows. PRD §7.13's "the game-end notification stays" refers to
the in-app result, and is reworded to say so.

## 5. Testing

On real PostgreSQL with the fake Bot API. `TelegramApi` and `fakeTelegram` gain `deleteMessage`.

**Unit**

- Every DM and stub text, with and without flair; deleted player and bot wear none.
- Delete versus stub at 46 h 59 m and 47 h 00 m.
- Result text for every row of §4.2, rated and casual, and no message for abort, timeout-abort
  and void.

**Integration**

1. Turn → move → turn: the waiting-line edit, then a new DM and a `deleteMessage` for the old one.
2. The same past 47 hours: the old message is edited to its stub; no `deleteMessage`.
3. A reminder replaces the turn DM.
4. A draw offer while the recipient is to move sends a draw DM; an offer by the player to move
   followed by their move sends one turn DM with the offer line.
5. Resignation, timeout (both players), draw agreement and checkmate send the result DM to the
   right players and retire every live row for the game; result DMs leave no row.
6. The challenge DM is retired on accept, decline, cancel and expiry.
7. "Not found" on retire; `blocked` on send removes all rows; a move before the turn DM is sent
   sends nothing; a move just after it records the row as `waiting` and edits it; Delete my data retires all rows.
8. Existing DM assertions in `games.test.ts`, `draws.test.ts`, `challenges.test.ts`,
   `premoves.test.ts` and `telegram-handlers.test.ts` updated for flair and the new dedup key.

## 6. Docs

- PRD §7.7: replace the DM bullet with the one-live-message rule, the draw-offer and result DMs,
  and flair in names. §7.13: reword the game-end line (§4.4).
- `docs/operations.md`: add `retire_dm` to the job list and the `dm_messages` table.
