# Group Chess — Product Requirements Document

| | |
|---|---|
| **Product** | Group Chess (working title) — a Telegram bot for playing and watching chess inside group chats |
| **Status** | Draft v0.1, for review |
| **Date** | 2026-09-20 |
| **Next step** | Technical requirements and architecture document |

---

## 1. Summary

Group Chess turns any Telegram group into a chess club. Anyone in the group can challenge anyone else, play straight from the chat on a live-updating board, and everyone else can watch games in progress or replay any game from the group's history. Around that core it adds what makes a club fun: per-group ratings and leaderboards, a daily puzzle, "vote chess" where the whole group plays as one side against an engine, tournaments and seasons, post-game analysis, predictions for spectators, and achievements.

The bot is built around what the Telegram platform does well today: one board message per game that is edited in place, inline keyboards for moves and actions, bot reactions for moments of drama, forum topics for organisation, and an optional Mini App (opened from the group through direct links) for a drag-and-drop board, replays and stats. The bot runs with privacy mode on and never reads the group's ordinary conversation.

## 2. Problem and opportunity

- Group chats already contain the people you want to play with. Existing chess bots are mostly private-chat or inline-message toys: no shared history, no spectators, no group identity.
- Playing on Lichess or Chess.com means leaving the chat, creating accounts, and sharing links. The social moment (trash talk, kibitzing, a leaderboard everyone cares about) is lost.
- Telegram's platform has matured: message editing, reactions, topics, `copy_text` buttons, Mini Apps with fullscreen and sharing. A chess bot designed for these features can feel native rather than bolted on.

## 3. Goals and non-goals

### Goals

1. **Frictionless play in the group.** A challenge takes one command or one tap. A move takes two taps or a short reply. No accounts, no links, nothing to install.
2. **Spectating by default.** Every game is visible to the whole group as it happens, and every finished game can be found and replayed later.
3. **A club, not just a board.** Ratings, leaderboards, puzzles, tournaments, achievements and vote chess give the group reasons to come back.
4. **Clean, quiet UI.** One message per game, edited in place. The bot never floods the chat.
5. **Trustworthy.** Privacy mode stays on; the bot stores game data only. Admins control the settings.

### Non-goals (for now)

- Real-time blitz or bullet chess. Telegram's edit latency and per-group rate limits make sub-minute clocks unreliable. The minimum supported clock is per-move time of one minute; the sweet spot is correspondence style (hours or days per move).
- A general-purpose chess server. No cross-platform accounts, no federation with Lichess or Chess.com beyond "open in analysis" links and PGN export.
- Anti-cheat detection. Ratings are group-local and for fun. Admins can void games.
- Channels. The product targets groups and supergroups. Channel comment threads are out of scope.

## 4. Users

| Persona | What they want | Key moments |
|---|---|---|
| **The player** | Start a game fast, move without leaving the chat, know when it's their turn, not lose on time by accident | Challenge, move, "your move" nudge, game end |
| **The spectator** | See what's happening, jump to a live game, replay the drama, predict the result, kibitz | `/games`, jump-to-board, replay, predictions |
| **The group admin** | Add the bot in a minute, keep the chat tidy, set defaults, run a tournament, reset a season | `/settings`, topics, pinning, tournaments |
| **The casual member** | Enjoy the daily puzzle and the leaderboard without ever playing a full game | Daily puzzle, achievements, leaderboard |

Group sizes range from 3 friends to clubs of several hundred. The design must work for both: quiet for the small group, organised (topics, per-game threads) for the big one.

## 5. Design principles

1. **One message per game.** The board is a single photo message whose image, caption and keyboard are edited on every move. Nothing else about a game is posted except a short, self-cleaning "your move" nudge.
2. **Buttons show only what is legal.** Move pickers list only movable pieces and legal destinations. Actions (draw, resign, claim draw, accept takeback) appear only when they apply.
3. **Everyone sees the same thing; only the right person can act.** Board messages are shared. Taps by anyone other than the player to move get a polite toast, never an error message in the chat.
4. **Never spam the group.** Nudges are deleted or collapsed when they are no longer relevant. Lists and viewers are paginated in a single message. Reminders are edits, not new messages.
5. **No spoilers during a live game.** The bot never shows engine evaluations, hints or "blunder" reactions for an in-progress game between humans. Analysis is post-game only.
6. **Privacy mode on.** The bot only receives commands, replies to its own messages and messages that mention it. It does not log chat content.
7. **Works without the Mini App.** The Mini App is the premium experience, but every feature needed to play, watch and browse works with buttons and text in the group.

## 6. Core user journeys

### 6.1 Add the bot to a group

1. Admin adds `@<bot>` to the group (any member can, if the group allows).
2. The bot posts a single welcome card: what it does, `/play` to start, `/help` for everything else, and a "Settings" button for admins.
3. If the group is a forum (topics enabled), the welcome asks whether games should go in the current topic, a dedicated "♟ Chess" topic (the bot creates it if it may), or wherever the challenge was made.

Acceptance: a brand-new group can start a game within 60 seconds of adding the bot, with no configuration.

### 6.2 Challenge someone

1. Alice replies to a message from Bob with `/play`, or sends `/play @bob`, or just `/play` for an open challenge.
2. The bot posts a challenge card with the time control and colour, and **Accept** / **Decline** buttons (only Bob can accept a direct challenge; anyone but Alice can accept an open one).
3. On accept, the challenge card becomes the live board (the same message is edited), White is nudged, and the game is listed in `/games`.

Acceptance: the whole flow is 1 command + 1 tap. Challenges expire after 24 hours. A user cannot have more than 3 pending outgoing challenges per group.

### 6.3 Make a move

1. Bob taps **♟ Move** on the board (or on his nudge). The keyboard becomes a list of his movable pieces (e.g. `♘g1`, `♙e2`).
2. Bob taps a piece, then a destination square. Promotions ask for the piece. The move is validated and played.
3. The board image, caption and keyboard are updated in place; Bob's nudge disappears; Alice gets a new nudge.

Alternative: Bob replies to the board or nudge with `Nf3`, or sends `/m Nf3`.

Acceptance: the updated board is visible within 2 seconds (p95). Illegal or ambiguous input produces a one-line reply with the legal options, never a silent failure.

### 6.4 Watch a game

1. Carol sends `/games`. The bot shows a paginated list of active games with a **Watch** button per game.
2. **Watch** jumps to the live board message (a message link). From the board Carol can open the Mini App view, copy the FEN, or predict the result.
3. The board keeps updating in place, so Carol can just keep it open.

### 6.5 Replay an old game

1. Carol sends `/history` (optionally `/history @alice`). The bot shows a paginated list of finished games with result, opening and date, and a **▶ Replay** button per game.
2. **▶ Replay** opens a replay viewer: a board message with ⏮ ◀ ▶ ⏭ controls and the move list. Anyone can drive it. It closes itself after 10 minutes idle.
3. **PGN** sends the file; **Open in app** opens the same game in the Mini App with a scrubber and post-game analysis.

## 7. Functional requirements

Priorities: **P0** = launch, **P1** = fast follow (weeks after launch), **P2** = later, **P3** = ideas worth keeping.

### 7.1 Onboarding and help — P0

- Welcome card on join, `/help` with a compact command list and a **Full guide** link.
- `/start` in a private chat enables DM notifications and shows the user's cross-group profile.
- The bot's description, short description and command menu (via BotFather-equivalent API calls) are set so the group's command autocomplete is useful.

### 7.2 Challenges and matchmaking — P0

- Direct challenge by reply-to-message, by `@username`, or by text mention. Because the Bot API cannot resolve a `@username` to a user the bot has never seen, unknown usernames fall back to an open challenge with a note.
- Open challenge ("anyone?") accepted by the first taker.
- Options: colour (white, black, random; default random), time control (see 7.3), rated or casual (default rated), variant (P2).
- Challenge card is edited into the board on accept; cancelled cards are edited to "cancelled" rather than deleted (keeps history readable).
- **Rematch** button at game end creates a reversed-colour challenge pre-accepted by the presser and waiting on the opponent.
- Limits: 3 pending challenges per user per group; a user declined by the same person 3 times in a row cannot challenge them for 24 hours (anti-pestering).
- P1: `/play bot <level>` to play the engine (7.9). P2: `/play @bob 960`, `/play @bob koth` for variants (7.12).

### 7.3 Gameplay and rules — P0

- Full FIDE rules: legal move generation, castling, en passant, promotion, check, checkmate, stalemate, threefold and fivefold repetition, 50- and 75-move rules, insufficient material. All validated server-side by a mature chess library.
- **Time controls** are "time per move" (Fischer-style correspondence): `1h`, `8h`, `1d` (default), `3d`, `7d`, and `none` (casual, abandoned after 14 days of silence). Clock per move resets on each move. Minimum offered in the UI is 1 hour; `/play ... 5m` etc. is allowed as an expert option down to 1 minute.
- **Draw offers**: offer via button; the opponent sees **Accept draw** / **Decline** on their next turn; the offer expires when they move. Claim draw appears when a threefold or 50-move claim is available; fivefold, 75-move and insufficient material end the game automatically.
- **Resign** requires a confirmation tap. **Abort** (no rating change) is available to either side before both players have made a move.
- **Timeout**: forfeit on the clock. If the player to move has never moved in the game, the game is aborted instead of lost. A single reminder is issued at 50% and again at 10% of the move time for controls of 8 hours or more.
- **Takeback** (P1): request via button, opponent accepts or declines; maximum 3 per game; admins can disable for rated games.
- A user may have up to 5 active games per group (admin-configurable). The same pair can have at most 2 games running at once.
- Opening detection: each position is matched against an ECO database and the opening name is shown in the caption once known.

### 7.4 Move input — P0

- **Two-tap picker** in the group: **♟ Move** → movable pieces (buttons labelled with piece glyph and square, e.g. `♘g1`) → legal destinations → promotion piece if needed. Includes **◀ Back** and **✖ Cancel**. The picker collapses automatically after 90 seconds of inactivity.
- Only the player to move can operate the picker. Anyone else gets a toast: "It's Bob's move".
- **Text input**: reply to the board or the nudge with SAN (`Nf3`, `O-O`, `exd5`, `e8=Q`) or UCI (`g1f3`). Also `/m Nf3` anywhere in the group; if the user has several games where it is their move, `/m 42 Nf3` selects the game. Input is normalised (`nf3`, `0-0`, `e8q` all accepted).
- Errors: a short reply quoting the input ("`Nf3` is not legal here — legal knight moves: Nh3, Na3") using reply quotes.
- P1: while a piece is selected, the board image shows the selected piece and dots on its legal destinations.
- P1: Mini App drag-and-drop board (7.13).

### 7.5 Live board and notifications — P0

**Board message** (one per game, edited in place):

- Photo: rendered board, coordinates, last-move highlight, check highlight, White at the bottom by default (per-game option: flip to the side to move).
- Caption: game number, players with colours and ratings, move number and last move, whose move and time remaining, opening name, and result when finished. Kept well under the 1024-character caption limit.
- Keyboard (see section 8.3): actions for players and spectators; contextual rows for pending offers.
- Board images are cached by position and highlight so repeated positions reuse the already-uploaded file.

**Nudge** (short message, one per move):

- "♟ Bob, your move · Game #42 vs Alice · 12. Nf3 · ⏱ 1d" with a text mention so Bob is notified even without a username, plus **Open board ↑** (message link) and **♟ Move** (opens the picker right there, so Bob never has to scroll).
- The previous nudge is deleted when the next move is made (or edited down to a single line if it is older than 48 hours and the bot lacks delete rights, see section 10).
- Admin settings: nudge on every move (default), only after N hours without a move, or off.

**Bump**: an admin setting to re-post the board (deleting the old one) every N moves, for busy groups where the board scrolls away. Default off; the nudge's jump link covers most cases.

**DM notifications** (P1): users who have started the bot privately can receive "your move" DMs with a link to the board, time-out warnings, and challenge notifications. Quiet hours (P2).

**Reactions** (P0, cheap delight): the bot reacts to the final move message or the board with 🎉 on checkmate, 🤝 on an agreed draw, 🏆 when a tournament is decided, and 👏 when a game ends after 60+ moves. Never during a live game between humans in a way that leaks evaluation.

**Blindfold mode** (P1): the board image is sent with the media spoiler flag, so players and spectators must tap to reveal it. Moves must be typed. Rated separately or casual only.

### 7.6 Spectating — P0

- `/games`: paginated list of active games in this group ("#42 Alice vs Bob · move 12 · Bob to move · 9h left"), each with **Watch** (message link) and **Open in app** buttons. Sorted by most recent move.
- **Watch** works in supergroups (message links). In basic groups the button re-posts the board instead (see section 10).
- **Copy FEN** (`copy_text` button) on every board.
- **Analyse** button: opens the position on Lichess analysis (no account needed) in the browser.
- **Pin active games** (admin option): the bot pins the board when a game starts and unpins on completion (needs pin rights).
- Spectator predictions (P1): **🔮 Predict** → White / Black / Draw. Players cannot predict their own game. Correct predictions score 3 points if made before move 10, 1 point after. A "Pundit" leaderboard (7.7) ranks predictors. Predictions are revealed at game end ("4 of 6 called it").
- Watcher count (P2): number of distinct users who tapped Watch or opened the game in the app.

### 7.7 History, ratings and stats — P0

- `/history [@user] [page]`: paginated finished games with result, move count, opening, date; **▶ Replay**, **PGN** per game.
- Replay viewer: board message with ⏮ ◀ ▶ ⏭ and a move list, drivable by anyone, auto-closed after 10 minutes idle. **Open in app** for the scrubber view.
- `/pgn 42`: send the PGN file of any game in this group.
- **Ratings**: Glicko-2 per group (start 1500, provisional marker until settled), plus a global rating per user across groups. Only standard rated games count. Rating change is shown at game end ("Alice 1520 → 1534").
- `/leaderboard` (`/top`): paginated, admin-configurable minimum games (default 3); shows rating, W/D/L, streak. Tabs (buttons): **Rating · Activity · Puzzles · Pundits**.
- `/stats [@user]`: rating, record, head-to-head with the requester, favourite opening, longest game, achievements.
- **Seasons** (P2): admins can end a season; final standings are posted and pinned, champion gets a title, ratings optionally soft-reset.

### 7.8 Puzzles — P1

- **Daily puzzle** posted at an admin-set local time in the configured topic: board image, "White to play and win", difficulty, and a **Solve** button.
- Solving happens privately so the group is not spoiled: **Solve** opens the Mini App or a DM with the bot where the user enters moves. Multi-move puzzles require the full line.
- The group message is edited with a live tally ("✅ 3 solved: Alice, Bob, Carol · ⏳ reveal in 6h"). The solution and the source game are revealed after 12 hours or when the admin-set solver count is reached.
- `/puzzle` for an on-demand puzzle at any time; per-user puzzle rating and streaks; a group puzzle streak (days in a row with at least one solver).
- Source: an openly licensed puzzle database (e.g. Lichess's CC0 puzzle set); difficulty adapts to the solver's puzzle rating.
- P2: **Puzzle from your game** — the biggest blunder in a finished game becomes a group puzzle a day later.

### 7.9 Play the bot — P1

- `/play bot [1-8]`: an engine opponent at a chosen level, played in the group so others can watch and kibitz. Unrated. Engine moves within a few seconds. Levels map to a capped engine strength; the top level is honest ("this will crush you").
- **Beat the bot ladder** (P2): each player's highest beaten level shown in stats.

### 7.10 Vote chess — P1

- `/votechess [level] [window]`: the whole group plays one side against the engine. Each move has a voting window (default 6 hours, minimum 30 minutes).
- Members suggest candidate moves with the picker or by replying with SAN; the board keyboard lists the top candidates with vote counts; one vote per user, changeable until the deadline. The plurality move is played at the deadline (earliest suggestion wins ties). If nobody votes, the window extends once, then the game is paused.
- The board shows the voting deadline, the current tally and who is leading the "most influential voter" count. A game summary at the end credits the voters.
- P3: **Group vs group** across two chats that both use the bot.

### 7.11 Post-game analysis — P1

- At game end an engine pass produces: accuracy per player, counts of inaccuracies/mistakes/blunders, the key moment (largest evaluation swing) rendered as a board image with the better move, and an evaluation graph image.
- Delivered as an **📊 Analysis** button on the finished board that expands into a single analysis message (edited into place, not spammed) with the graph and key moment.
- **Game of the week** (P2): each week the bot posts the group's most dramatic or highest-quality game with its analysis, using the week's finished games.
- Never for in-progress games.

### 7.12 Variants and formats — P2

- Chess960, King of the Hill, Three-check, Atomic, Crazyhouse (all supported by common chess libraries). Unrated by default; admins may enable rated variant pools.
- **Hand and Brain**: two-player teams in the group; the "brain" names a piece type, the "hand" chooses the move. Fun with four people and a lot of spectators.
- **Simul**: one player faces several group members at once; the board messages are grouped and the simul giver gets a single nudge listing all games where it is their move.

### 7.13 Mini App — P1

The Mini App is the polished surface for anything that is clumsy with buttons. It is optional; every core flow works without it.

- **Launch points**: **Open in app** URL buttons on boards, lists and puzzles use direct links (`t.me/<bot>/<app>?startapp=<payload>`), which work from inside group chats. The bot's main Mini App (profile button and attachment menu) opens the lobby. `/app` posts a launch button.
- **Views**: game (drag-and-drop and tap-tap moves, legal-move hints, optional move confirmation, flip, move list, clocks, draw/resign), lobby (my games across groups, "my move" list, open challenges), history and replay (scrubber, analysis graph, key moments), puzzles, profile and stats, settings (timezone, notifications, board theme and piece set).
- **Identity**: the app trusts only Telegram's signed launch data; a user can act only as themselves. Moves made in the app update the group board within the same latency target.
- **Platform features used**: fullscreen mode for the board, haptic feedback on move, capture and check, theme parameters for automatic dark mode, the back button and main button ("Confirm move"), cloud storage for preferences, **share** to post a game card or puzzle to any chat via a prepared inline message, and the home-screen shortcut prompt for frequent users.
- **Live updates**: the app reflects opponent moves without refresh (push channel defined in the tech doc).

### 7.14 Tournaments — P2

- Admin creates a tournament with `/tournament`: format (round robin up to 8 players, Swiss with N rounds, or a ladder where anyone can challenge the player one rung above), time control, join deadline. A **Join** button on the announcement collects players.
- The bot pairs rounds automatically, creates the games with the right colours, and maintains one pinned standings message that is edited after every result.
- Missed games count as forfeits after the round deadline; the admin can extend a round or withdraw a player.
- The winner gets a 🏆 title shown in the leaderboard and stats for the season, and optionally (P3) a Telegram gift funded by the group admin.

### 7.15 Achievements — P1

Unlocked per user, announced by editing the game-end message ("🏅 Alice unlocked *Underdog*") and listed in `/stats`. Initial set (about 20), for example: First Blood (first win), Hat-trick (three wins in a row), Underdog (beat someone rated 200+ higher), Marathon (a 100-move game), Pawn Storm (promote a pawn), Holy Hell (capture en passant), Smothered (smothered mate), Iron Nerves (win a game with under 1% of clock left), Prophet (five correct predictions), Streak Master (7-day puzzle streak), Club Legend (100 games in one group).

### 7.16 Group settings and admin controls — P0

`/settings` (group admins only) opens an inline menu edited in place:

- Default time control; rated by default; allow open challenges; allow casual-only variants (P2).
- Nudge style (every move / after N hours / off); bump board (off / every N moves); pin active games.
- Where games go: current topic / dedicated topic / one topic per game (P2, forums only).
- Daily puzzle: on/off, local time, topic.
- Leaderboard minimum games; season controls (P2).
- Max concurrent games per user; maximum move time offered.
- Language (English at launch; strings externalised for translation).
- Moderation: void a game (`/void 42`), delete a game from history, block a user from starting games in this group.

### 7.17 Privacy, safety and abuse — P0

- Privacy mode stays enabled. The bot processes only commands, replies to its messages, mentions and callback taps. Nothing else is stored.
- Stored per user: Telegram user id, first name, username (for display), games, ratings, achievements, notification preferences. `/forgetme` in a DM anonymises the user in all games and deletes preferences.
- Rate limits on challenges and commands per user; cooldowns after repeated declines; admins can block users from the bot in their group.
- No gambling mechanics. Any monetisation (P3) is cosmetic or "support the project" only.

## 8. UX specification

### 8.1 Message anatomy: the live board

```
[ board image: 8x8, coordinates, last move highlighted, king in check highlighted ]

♟ Game #42 · 1 day/move · Rated
⚪ Alice (1520)  vs  ⚫ Bob (1498)
Move 12 · last: 12. Nf3 · ⚫ Bob to move · ⏱ 23h 41m
Italian Game (C50)

[ ♟ Move ]        [ 🤝 Draw ]      [ 🏳 Resign ]
[ 📱 Open in app ] [ 📋 Copy FEN ] [ 🔮 Predict ]
```

Contextual rows appear only when relevant, e.g. `[ 🤝 Accept draw ] [ ✖ Decline ]` for the opponent while an offer stands, `[ ⚖ Claim draw ]` when a threefold claim is available, `[ ↶ Accept takeback ] [ ✖ ]` for a pending takeback.

### 8.2 Message anatomy: the nudge

```
♟ Bob, your move · #42 vs Alice · 12. Nf3 · ⏱ 1d
[ ♟ Move ]  [ Open board ↑ ]
```

Deleted once Bob moves. In basic groups (no message links) the second button is omitted.

### 8.3 Keyboard states for the move picker

1. **Idle**: the two rows shown in 8.1.
2. **Piece selection**: buttons for each movable piece, four per row, sorted by piece value then file: `♔e1 ♕d1 ♖a1 ♖h1 / ♗c1 ♘g1 ♙a2 ♙b2 / …` then `[ ✖ Cancel ]`.
3. **Destination**: legal squares for the chosen piece, up to six per row, e.g. `e3 e4`, then `[ ◀ Back ] [ ✖ Cancel ]`.
4. **Promotion**: `[ ♕ ] [ ♖ ] [ ♗ ] [ ♘ ]` then `[ ◀ Back ]`.
5. After a legal move the keyboard returns to idle on the updated board.

Rules: never more than 8 buttons per row; the picker collapses after 90 seconds idle; taps from anyone other than the player to move answer with a toast; callback payloads are compact ids, never chess data that the client could tamper with.

### 8.4 Game end

The board caption is rewritten with the result line (e.g. "Checkmate — Alice wins · 1-0 · 34 moves · Alice 1520 → 1534, Bob 1498 → 1484"), the keyboard becomes `[ 🔁 Rematch ] [ 📊 Analysis ] [ 📄 PGN ] [ 📱 Replay in app ]`, the bot reacts to the board, and the game is unpinned. Achievements unlocked by the game are appended as one line.

### 8.5 Lists

`/games`, `/history`, `/leaderboard`: one message, up to 5 entries per page with a button per entry, pagination row `[ ◀ ] [ 2 / 7 ] [ ▶ ]`, filter row where relevant (`All · Mine · @user`). Lists edit in place when paged; a new list message is only created when the command is sent again.

### 8.6 Board rendering

- 1024×1024 PNG (WebP where accepted), light and dark friendly colour scheme, clear piece set with a licence that permits redistribution (confirm in the tech doc).
- Highlights: last move (from and to squares), check (king square), selected piece and legal targets (P1 during picking).
- Orientation: White at the bottom by default; per-game "flip to side to move" option; the Mini App always shows the viewer's own side at the bottom.
- Accessibility: `/board 42 text` returns a monospace Unicode board and the move list, useful for screen readers and low bandwidth. Captions always include the last move in SAN.

### 8.7 Copy and tone

Short, friendly, chess-literate. Standard notation everywhere (SAN in captions, "1-0", "½-½"). Emoji used as icons on buttons and status lines, not as decoration in prose. No exclamation-mark spam. Errors say what is legal next.

### 8.8 Command reference (launch set)

| Command | Purpose |
|---|---|
| `/play [@user] [time] [white/black/random] [rated/casual]` | Challenge someone, or open challenge with no user. Reply-to-message also works. |
| `/play bot [1-8]` | Play the engine (P1). |
| `/accept`, `/decline`, `/cancel` | Respond to or cancel a challenge (buttons do the same). |
| `/m <move>` or `/move [game] <move>` | Make a move by text. Replying to the board with the move also works. |
| `/draw`, `/resign`, `/abort`, `/takeback` | Game actions (buttons do the same). |
| `/games` | Active games in this group. |
| `/history [@user]` | Finished games, with replay. |
| `/pgn <game>` | PGN file of a game. |
| `/board <game> [text]` | Re-post a board, optionally as text. |
| `/stats [@user]`, `/leaderboard` | Ratings and records. |
| `/puzzle` | A puzzle now (P1). |
| `/votechess [level] [window]` | Start a vote-chess game (P1). |
| `/tournament` | Tournament menu (P2). |
| `/app` | Open the Mini App (P1). |
| `/settings` | Admin settings. |
| `/help` | Help. |
| `/start`, `/tz`, `/forgetme` | Private chat: enable DMs, set timezone, delete data. |

## 9. Telegram platform feature map

How each product feature maps to platform capabilities, with the group-chat caveat that matters. Bot API version tags reflect knowledge as of mid-2026; this session could not reach the official changelog, so **verify each tag against core.telegram.org/bots/api-changelog during technical design**.

| Product feature | Platform capability | Notes and caveats |
|---|---|---|
| Live board edited in place | `editMessageMedia`, `editMessageCaption`, `editMessageReplyMarkup` | A bot may edit its own messages indefinitely. Cache uploaded board images by position and reuse the file id to avoid re-uploads. |
| Move picker, all actions | Inline keyboards, callback queries, `answerCallbackQuery` toasts | Callback payload is limited to 64 bytes: use game and move ids. Toast text limited to about 200 characters. |
| Text moves under privacy mode | Commands, replies to bot messages, mentions | Privacy mode delivers replies to the bot's own messages and commands. That is why "reply with `Nf3`" works without reading the chat. |
| Jump to board (Watch, Open board ↑) | Message links for supergroups (`t.me/c/<id>/<msg>`, or `t.me/<group>/<msg>` for public groups) | Not available in basic groups. Fallback: re-post the board. Recommend supergroups in the help text. |
| Self-cleaning nudges | `deleteMessage` | A bot can delete its own group messages only within 48 hours unless it is an admin with delete rights. Fallback: edit the stale nudge to one line. |
| Mention the player to move | Text mentions (`tg://user?id=`) | Works for users without a username. |
| Copy FEN | `copy_text` inline button (Bot API 7.11) | Limited to 256 characters, so FEN yes, PGN no. PGN is sent as a file. |
| Bot reactions on events | `setMessageReaction` (Bot API 7.0) | Standard emoji only. Receiving reaction updates would require admin rights; not needed at launch. |
| Reply quoting the bad input | Reply parameters with `quote` (Bot API 7.0) | Also allows a DM to quote and link to a group message ("your move" DMs). |
| Games in topics | Forum topics, `message_thread_id` (Bot API 6.3), `createForumTopic` | Creating a dedicated topic needs the manage-topics right. |
| Blindfold mode | Media spoiler (`has_spoiler`, Bot API 6.4) | Tap-to-reveal board image. |
| Mini App from a group | Direct-link Mini Apps (`t.me/<bot>/<app>?startapp=`) via URL buttons; main Mini App on the bot profile | Inline `web_app` buttons only work in private chats, so groups must use direct links. Launch data includes the user and the start payload for authentication. |
| Mini App polish | Fullscreen, haptics, theme params, back and main buttons, cloud storage, home-screen shortcut, `shareMessage` with `savePreparedInlineMessage` (Bot API 8.0) | Sharing a game or puzzle card to any chat from the app. |
| Share a game to another chat | `switch_inline_query_chosen_chat` (Bot API 6.7), inline mode | P2: inline challenge cards in chats where the bot is not a member (the bot can edit those via inline message id but cannot post new messages). |
| Puzzle solving without spoilers | DM deep link (`t.me/<bot>?start=<payload>`) from `answerCallbackQuery` url, or the Mini App | The bot can only DM users who have started it. |
| Pin active games | `pinChatMessage` / `unpinChatMessage` | Needs pin rights. Optional. |
| DM notifications | Private chat messages, cross-chat reply quotes | Only after the user has pressed Start in a private chat. |
| Vote chess tallies | Inline keyboards with live counts, or native polls (`sendPoll`, `poll_answer`) | Keyboards allow any legal candidate and one vote per user; polls cap the option count. Keyboards are the default. |
| Champion rewards (P3) | Telegram Stars payments (Bot API 7.4), gifts (`sendGift`, Bot API 8.0), emoji status via Mini App permission (Bot API 8.0) | All optional; gifts cost Stars from the bot balance; emoji status requires Premium. |
| Command menu, descriptions | `setMyCommands` (with group scope), `setMyDescription`, `setMyShortDescription` | Group-scoped commands keep DM and group menus different. |

Considered and not used:

- **Message effects** (Bot API 7.4) are private-chat only, so no confetti in the group. Reactions are the group-safe equivalent.
- **Telegram HTML5 Games** (`sendGame`) work in groups but are an older, high-score-oriented platform with fewer capabilities than Mini Apps.
- **Checklists** (Bot API 9.1) are available to business accounts only, so tournament to-do lists cannot use them.
- **Custom emoji** in bot messages require a Fragment-purchased username, so piece glyphs use standard Unicode.
- **Bot API 9.x additions** (business account management, gift upgrades, channel direct messages, suggested posts) do not apply to a group bot. Re-check the changelog for anything newer than 9.2 before the tech spec.

## 10. Platform constraints that shape the design

| Constraint | Product implication |
|---|---|
| About 20 messages per minute per group, edits included | One message per game, no per-move board re-posts by default, nudge edits instead of new reminders, image caching. Busy clubs may need per-game topics. |
| Privacy mode | No free-text move detection; moves are commands, replies or picker taps. Puzzles are solved privately. |
| No member list API; usernames cannot be resolved unless previously seen | Challenge by reply is the most reliable path; unknown `@username` falls back to an open challenge. |
| Callback data of 64 bytes | Short ids in buttons; the server holds picker state. |
| Caption limit of 1024 characters | The move list lives in the replay viewer and the app, not the caption. |
| 48-hour delete limit without admin rights | Nudges older than 48 hours are edited, not deleted. Recommend granting delete rights during onboarding. |
| Inline `web_app` buttons are private-chat only | Direct-link Mini App buttons in groups. |
| Message links need a supergroup | Suggest converting basic groups; fallback re-posts the board. |
| Bots cannot DM users who never started them | DM notifications are opt-in via Start; group nudges remain the default. |
| Notifications are not triggered by edits | Turn changes need a new message (the nudge) or a DM; the board edit alone would be silent. |

## 11. Non-functional requirements

- **Latency**: board updated within 2 seconds of a move (p95); Mini App reflects opponent moves within 3 seconds.
- **Availability**: 99.5% monthly. Clocks and forfeits must be correct across restarts (no lost timers).
- **Scale target for v1**: 10,000 groups, 2,000 concurrent games, 200 moves per minute at peak, with headroom to grow 10×.
- **Data**: games kept indefinitely unless deleted by an admin or anonymised on request; daily backups; export on request.
- **Engine work** (analysis, bot opponent, vote chess) runs off the request path with bounded depth and time; live moves never wait on the engine.
- **Localisation**: all user-facing strings externalised; English at launch.
- **Observability**: per-group and per-feature usage metrics, error rates, edit-rate-limit hits, engine queue depth.
- **Cost**: board rendering and image caching must keep per-move cost negligible; analysis depth is tunable.

## 12. Success metrics

| Metric | Target after 3 months |
|---|---|
| Groups that play at least one full game in their first week | 60% of groups that add the bot |
| Games completed (not abandoned) | 75% of games started |
| Median time from challenge to first move | under 10 minutes |
| Spectator actions per game (Watch taps, app opens, predictions) | 3+ |
| Weekly active groups after 4 weeks | 40% of activated groups |
| Daily puzzle participation in groups with it enabled | 20% of members solving weekly |
| Move-input errors per 100 moves (illegal, ambiguous) | under 3 |

## 13. Release plan

1. **Alpha (P0)**: challenges, full rules, picker and text moves, live board and nudges, `/games`, `/history`, replay, PGN, ratings, leaderboard, settings, reactions. Run in two or three friendly groups. Exit criteria: 50 completed games, no rule bugs, no rate-limit incidents.
2. **Beta (P1)**: Mini App, daily puzzle, play the bot, vote chess, post-game analysis, predictions, DM notifications, achievements, takebacks, blindfold. Open to anyone; listed publicly.
3. **v1.1 (P2)**: tournaments and seasons, variants, hand and brain, simul, watcher counts, puzzle from your game, game of the week, inline challenge cards, per-game topics.
4. **Later (P3)**: group-vs-group vote chess, cosmetic themes and "support the project" via Stars, champion gifts and emoji status, cross-group leagues.

## 14. Open questions

1. **Name and handle.** "Group Chess" is a working title.
2. **Engine hosting.** Self-hosted Stockfish workers versus a cloud evaluation API. Affects vote chess, bot opponent and analysis costs.
3. **Global rating.** Keep one cross-group rating per user, or make ratings strictly per group with a separate global "profile" record?
4. **Minimum clock.** Ship 1 hour as the smallest option in the UI, with faster clocks as an expert flag, or expose 5 and 15 minutes per move by default?
5. **Rated variants.** Separate rating pools per variant, or variants always casual?
6. **Monetisation.** None at launch. Decide whether P3 "support" features are worth the added complexity and trust considerations.
7. **Data retention.** Indefinite versus a rolling window for groups that go inactive for a year.
8. **Languages.** Which languages come second, and whether the Mini App and group UI localise together.

## Appendix A. Message mockups

Challenge (direct):

```
⚔️ Alice challenges Bob!
⏱ 1 day per move · Rated · colours random
[ ✅ Accept ] [ ❌ Decline ]
```

Challenge (open):

```
⚔️ Alice is looking for a game — anyone?
⏱ 1 day per move · Rated
[ ✅ Accept ] [ ✖ Cancel ]
```

Active games list:

```
♟ Active games (3)
#42 Alice vs Bob · move 12 · Bob to move · 23h left        [ 👁 Watch ] [ 📱 ]
#41 Carol vs Dan · move 30 · Carol to move · 2h left      [ 👁 Watch ] [ 📱 ]
#40 Group vs Engine (lvl 4) · voting closes in 4h         [ 👁 Watch ] [ 📱 ]
[ ◀ ] [ 1 / 1 ] [ ▶ ]
```

Daily puzzle:

```
[ board image ]
🧩 Daily puzzle · Wed 17 Sep · ★★★☆☆ (1750)
White to play and win.
✅ Solved by 3: Alice, Bob, Carol · ⏳ solution in 6h
[ 🧩 Solve ] [ 📋 Copy FEN ]
```

Game end:

```
[ board image ]
♟ Game #42 · 1 day/move · Rated
⚪ Alice (1520 → 1534)  vs  ⚫ Bob (1498 → 1484)
Checkmate — Alice wins · 1-0 · 34 moves · Italian Game (C50)
🔮 4 of 6 predicted this · 🏅 Alice unlocked *Underdog*
[ 🔁 Rematch ] [ 📊 Analysis ] [ 📄 PGN ] [ 📱 Replay in app ]
```

## Appendix B. Idea backlog (unprioritised)

- Commentator mode for vote chess and bot games only (engine already knows), one line per move.
- Weekly digest message: games played, biggest upset, puzzle champion, streaks.
- "Move of the day" across all groups (anonymised) as a shareable card.
- Voice-note move input transcribed to SAN.
- Sticker pack of the bot's reactions and titles.
- Coaching mode: post-game "one thing to work on" derived from repeated mistake patterns.
- Cross-group leagues between clubs that opt in.
- Opening trainer: the bot plays a chosen opening line against you in a DM.
- Spectator "clutch meter": how close the game is by material and mobility, shown only in replays.
