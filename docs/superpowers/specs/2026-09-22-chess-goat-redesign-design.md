# Chess Goat: the Mini App redesign

Status: accepted for planning, 2026-09-22. Source design: the Claude Design project "Mini app
design improvement", file `Chess Goat Prototype.dc.html`, at its default variants
(`lobbyLayout: mine`, `homeList: dim`). Builds on the
[tab navigation spec](./2026-09-22-miniapp-tab-navigation.md); nothing about routing between
tabs, deep launches or the BackButton changes here.

## What this is

The Mini App gets the Chess Goat identity and the prototype's visual design on every screen,
plus the two small pieces of data the design needs that the API does not send today (a
thumbnail position per game, and which player is the bot) and one new page (the group
leaderboard).

| In scope | Out of scope |
|---|---|
| Brand, palette, typography and board colours, light and dark | The Telegram Stars tip jar (its own spec next: invoice endpoint, `pre_checkout_query`, `successful_payment`, the Support card) |
| Every screen restyled to the prototype: Games, Groups, Lobby, Game, New game, Settings | Board-theme and piece-set preferences (`Prefs.boardTheme`, `Prefs.pieceSet` stay unused) |
| A new Leaderboard page off the lobby | Renaming packages (`@group-chess/*`), the README, the PRD or other docs |
| `GameSummary` gains `fen`, `lastMove`, `engineLevel`; `PlayerRef` gains `isBot` | Telegram profile photos in avatars (not in the API) |
| Telegram chrome: header/background/bottom-bar colours, SettingsButton, native popups, closing confirmation, selection haptics | The prototype's own board, move rules and "Telegram calls" log panel (they illustrate; chessground and the server's rules stay) |
| "Chess Goat" wherever users see the name, including the PGN `[Event]` tag | |

Delivered as one PR.

## 1. Foundation

### Tokens

`tg/theme.ts` keeps reading Telegram's `themeParams` for the neutrals, with the existing
per-scheme fallbacks, and maps them onto the design's two surfaces: the **page** is
`secondary_bg_color` and **cards** sit on `bg_color`, as in Telegram's own settings screens.
The existing variables (`--bg`, `--secondary-bg`, `--text`, `--hint`, `--link`,
`--destructive`) keep their names and sources; `--page` and `--card` are aliases for the
last two surfaces so the new CSS reads like the design.

On top of the neutrals a fixed **Chess Goat accent set**, chosen by `colorScheme` and
re-applied on `themeChanged`:

| Token | Light | Dark | Used for |
|---|---|---|---|
| `--acc` | `#2e7d4f` | `#4cbb7a` | Primary buttons, selected tiles, switch track, active tab |
| `--acc-ink` | `#ffffff` | `#06200f` | Text on `--acc` |
| `--acc-text` | `#256b42` | `#6fd197` | Accent text: links in copy, "To move", active tab label, rank number |
| `--acc-soft` | `#e3f1e7` | `rgba(76,187,122,.16)` | Selected rows, your leaderboard row, current move chip, "Draw offered" |
| `--move` | `#e0b94a` | `#e8c35a` | "Your move" pill and clock, tab and group badges |
| `--move-ink` | `#2a2000` | `#2a2000` | Text on `--move` |
| `--move-soft` | `#fbf3dc` | `rgba(232,195,90,.12)` | The player bar while it is your move |
| `--move-text` | `#8a6a00` | `#ecc964` | "Your move" as text; rank #1 |
| `--urgent` | `#d14e4e` | `#ef5b5b` | Pill and clock once the urgency rule fires |
| `--hero-bg` | `linear-gradient(135deg,#236140,#153a26)` | `linear-gradient(135deg,#1f4a33,#11281b)` | Result card |
| `--hero-ink` / `--hero-sub` | `#f5f0dc` / `#bcd3c2` | `#f5f0dc` / `#a9c7b3` | Result card text |
| `--bl` / `--bd` | `#f0ead2` / `#7d9f6b` | `#e6dfc3` / `#6e9160` | Light and dark squares |
| `--lm` | `rgba(224,185,74,.6)` | `rgba(232,195,90,.6)` | Last-move squares |
| `--sel` | `rgba(46,125,79,.55)` | `rgba(76,187,122,.6)` | Selected square |
| `--dot` | `rgba(21,58,38,.4)` | `rgba(12,40,24,.45)` | Move-destination dots and capture rings |
| `--sep` / `--sep-strong` | `--hint` at 18% / 45% | same | Row separators; unchecked radio and off switch |

The urgency rule is the existing one (`state/clock.ts` `isUrgent`: remaining ≤ max(10% of the
time per move, one hour)).

### Brand

- `goat-mark.png` (round avatar crop, `object-position: 50% 30%`) and `goat-banner.jpg`
  (16:9, a JPEG re-encode at its native 640 px) come from the design project into the Mini
  App's assets, re-encoded so neither exceeds 60 KB. The banner is `loading="lazy"`.
- `<title>Chess Goat</title>` in `apps/miniapp/index.html`.
- `app.settings.about` reads "…Chess Goat is free software under the GPL-3.0-or-later."
- The PGN `[Event]` default in `packages/shared/src/chess/pgn.ts` becomes `"Chess Goat"`, so
  Lichess imports and PGN downloads carry the name users know.
- The author handle (`Jarvl`) and repository (`Jarvl/telegram-chess-bot`) live in one
  constants module in the Mini App.

### Typography

DM Serif Display, for display text only: screen titles, the group name in the lobby, the
result card title and the rank number in the leaderboard chip. It is vendored as a Latin
subset `woff2` with its OFL-1.1 licence text beside it, declared with `font-display: swap`
and falling back to Georgia. It is not an npm dependency, so the licence gate is unaffected,
and nothing is fetched from Google Fonts. Everything else stays in the system font stack.

### Board

Chessground and the cburnett pieces stay. `chessground.brown.css` is replaced by a small
override: squares from `--bl`/`--bd`, last move `--lm`, selected square `--sel`, destination
dots and capture rings in `--dot`, and coordinates in the opposite square's colour.

### Tab bar

The active tab gets a 60×32 pill of `--acc-soft` behind its icon, and icon and label turn
`--acc-text` (label weight 600). The Games badge turns `--move` on `--move-ink`, so red is
left meaning urgent or destructive. Icons and the badge's count rules are unchanged.

## 2. Data

All changes are additive fields on existing DTOs. No new endpoints.

| DTO | New field | Source |
|---|---|---|
| `GameSummary` | `fen: string` | `games.fen`, already selected |
| `GameSummary` | `lastMove: Uci \| null` | `moves.uci` where `moves.ply = games.ply_count`, a primary-key lookup (`(game_id, ply)`) added to `gameSummaryRows`; `null` when `ply_count = 0` |
| `GameSummary` | `engineLevel: EngineLevel \| null` | `games.engineLevel`, mirroring `GameDto.engineLevel` |
| `PlayerRef` | `isBot: boolean` | `users.isEngine`, via `toPlayerRef` |

`isBot` lets any screen draw the bot as the goat mark and show its level instead of a rating,
including rows and spectator views, where today only `GameDto.engineLevel` says a bot is
involved and nothing says which side it is. `PlayersPickerDto.bot` is untouched: the picker
still never lists the bot as a person.

The leaderboard chip (§3.3) is derived on the client from `LobbyDto.players` and the session
user's id.

## 3. Screens

Shared pieces live in `apps/miniapp/src/ui/`. Every existing `data-*` hook (`data-game`,
`data-group`, `data-accept`, `data-decline`, `data-cancel`, `data-player`, `data-tab`,
`data-action`, `data-pref`, `data-ply`, `data-nav`, `data-badge`, `data-dialog`) carries over
to the new markup.

### 3.1 Shared components

- **`Avatar`.** A coloured circle with an initial, sizes 22, 34, 38, 40 and 56. The colour is
  Telegram's avatar palette, in order red `#e17076`, orange `#faa774`, violet `#a695e7`, green
  `#7bc862`, cyan `#6ec9cb`, blue `#65aadd`, pink `#ee7aae`, indexed by the user id modulo 7.
  The initial is the first character of the display name, upper-cased. A bot player renders
  the goat mark instead. **Group variant:** a rounded square (radius ≈ 30% of the size), sizes
  48 and 56, up to two initials from the first two words of the title ("Friday Chess Club" →
  "FC", "Family" → "F"), coloured by a character-code sum of the group's public id modulo 7.
- **`MiniBoard`.** An 8×8 CSS grid, 80 px square, radius 8, drawn from
  `fen`, `lastMove` and an orientation (black at the bottom when the viewer plays black). Pieces
  reuse the cburnett images chessground already ships. `aria-hidden`: the row's text carries
  the meaning.
- **`GameCard`.** One row: `MiniBoard`, then a column with the opponent (`Avatar` 22, name,
  rating, or level for the bot, and a "Watching" tag when the viewer is not playing), a
  context line (the group title on lists spanning groups) and a terms line ("1 day per move ·
  Rated"), then a `Pill`, and a chevron. For a game the viewer is not in, the name reads
  "white vs black" and the avatar is white's. **Dimming:** when it is not the viewer's move the
  board is at 45% opacity with 70% greyscale, the avatar at 55%, and the name in `--hint`.
- **`Pill`.** Three states. *Yours:* `--move` fill, "Your move · 14:32:05", or "Your move" with
  no clock. *Urgent:* `--urgent` fill, white text, "Your move · 0:42:10 left". *Other:*
  plain `--hint` text: "@maya to move · 2d 3:10" for active games, the short result ("You won ·
  Checkmate · 1-0") for finished ones. Row clocks share one 1-second tick that runs only while
  a visible row has a deadline.
- **`Card`** (rounded 18 px grouped list on `--card`, rows separated by `--sep`),
  **`SectionLabel`** (13 px, 600, uppercase, letter-spaced, `--hint`), **`Tiles`** (a 3- or
  4-column grid of 12 px-radius choices; selected is `--acc` on `--acc-ink`), a restyled
  **`Switch`** (44×26, `--acc` when on, `--sep-strong` when off), **`ChallengeCard`**,
  **`PlayerRow`** and **`GroupRow`** (below).

### 3.2 Games (home)

- Header: the goat mark (42 px, a 2 px `--acc` ring) beside "Your games" in the display face.
- `SectionLabel` "3 games · 2 your move", then one `Card` of `GameCard`s in the server's order
  (your move first), with the group title as context.
- Empty: a centred `Card` with the existing empty copy and a full-width `--acc` button "Browse
  your groups" (`data-action="browse-groups"`), which selects the Groups tab.

### 3.3 Groups, Lobby and Leaderboard

**Groups.** "Your groups" in the display face, then one `GroupRow` card per group: group
`Avatar` 48, the title (17 px, 600), "4 active · 2 your move", a `--move` count badge when
`yourMove > 0`, and a chevron.

**Lobby** (the prototype's `mine` layout), top to bottom:

1. **Header.** Group `Avatar` 56, the title in the display face, and "4 active · **2 your
   move**" with the count in `--move-text`. Admins get a round 40 px gear button on `--card`
   (`data-action="group-settings"`) that pushes the existing GroupSettings.
2. **Leaderboard chip**, a `Card` row that pushes the Leaderboard page:
   - viewer ranked: "**#2**" (display face, `--acc-text`), "Leaderboard · 1512", and "9 W · 2 D
     · 7 L · of 3 ranked players";
   - viewer not ranked, board non-empty: "Leaderboard" and "3 ranked players";
   - board empty: no chip.
3. **New game**, a full-width `--acc` button (`data-action="new-game"`).
4. **Challenges · N** (`SectionLabel`) and one `Card` of `ChallengeCard`s: `Avatar` 40, "Tom
   challenges you" ("you" when the viewer is the opponent) or "Alex · open challenge", the terms, and pill buttons Accept (`--acc`),
   Decline and Cancel (on `--page`), shown per the existing `viewer.can*` flags.
5. **Your games / Whole group**, a segmented control that replaces the Active / Finished /
   Players tabs. It resets to *Your games* each time a lobby is opened.
   - *Your games:* "Active" (the viewer's active games, their move first) and "Finished" (the
     viewer's games among the finished pages loaded so far).
   - *Whole group:* "Active" (every active game, the viewer's move first) and "Finished" (every
     finished game loaded so far). Games the viewer is not in carry the "Watching" tag.
   - Finished keeps the existing "More" pagination (20 per page) below its card. In *Your
     games* the finished list is filtered on the client, so its empty message ("You have not
     finished a game here yet") shows only once `nextCursor` is null; until then "More" is
     offered instead.
   - Empty active lists use the existing copy in a plain `Card`.

**Leaderboard**, a new route `{ name: 'leaderboard'; groupId: string }`, pushed on the Groups
stack. "Leaderboard" in the display face over "Friday Chess Club · rated games only", then one
`Card` of `PlayerRow`s: rank (22 px column, #1 in `--move-text`, the rest `--hint`), `Avatar`
40, name and rating, the W · D · L record, and "18 games". The viewer's row is tinted
`--acc-soft` and suffixed "(you)". Rows push the existing Player page (`data-player`). The
screen loads `GET /api/groups/:id` itself, so it is always current and needs no cache shared
with the lobby.

### 3.4 Game

Behaviour is unchanged (drag and tap moves, promotion, replay, the stream, draws, the veil
while sending, close-after-move). The look:

- **Player bars**, above and below the board: `Avatar` 34 with a 2 px page-coloured gap and a
  1.5 px ring that is white for White and `#2b2b2b` for Black; name, then rating in `--hint`
  (the level for the bot); a sub-line that is "Your move" in `--move-text`, "To move" in
  `--acc-text`, or "White · Friday Chess Club" in `--hint`; and, while the game is active, a
  clock pill (min-width 84 px, tabular figures): `--move` on your move, `--acc-soft` /
  `--acc-text` when the other side is to move, `--urgent` when urgent, `--card` / `--hint`
  otherwise. Untimed games show "No clock". The bar whose turn it is and which belongs to
  the viewer is tinted `--move-soft`.
- **Board** full width, recoloured per §1.
- **Move list**, a horizontal strip: move numbers in `--hint`, SAN chips with 8 px radius; the
  chip of the position being viewed is `--acc-soft` / `--acc-text` / bold. The strip scrolls
  to its end when a move arrives. The "Latest" button and tap-to-replay stay.
- **Result**, a `--hero-bg` card: the title in the display face at 24 px ("You won"), a detail
  line in `--hero-sub` ("Checkmate · 1-0 · 1512 → 1524").
- **Draws.** "Draw offered" is an `--acc-soft` banner; an incoming offer keeps its Accept and
  Decline buttons, restyled as pills.
- **Actions**, pill buttons (999 px radius) on `--card`: Share position, Offer draw, Claim
  draw, Abort or Resign (text in `--destructive`), Flip (spectators). When finished: Rematch
  first in `--acc`, then Analyse on Lichess, PGN, and Done after a deep launch.

### 3.5 New game

- "New game" in the display face.
- **Opponent**, one `Card`: "Play the bot" (goat mark 38, "Unrated · no clock"), each member
  (`Avatar` 38, rating), and "Open challenge" (a 38 px circle with a `--sep-strong` ring and
  "+", "Anyone in the group can accept"), the last only when the group allows open
  challenges. The picked row is tinted `--acc-soft` with a 22 px `--acc` check; the others
  show an empty 22 px ring.
- **Bot level** (bot picked): 4-column `Tiles` from `PlayersPickerDto.bot.levels`, then the note
  "Games against the bot are unrated and have no clock."
- **Time per move** (a person or open challenge picked): 3-column `Tiles`: 1 hour, 8 hours,
  1 day, 3 days, 7 days, No clock.
- **Your colour**: 3-column tiles, each a 36 px king image and a label: White, Random (the two
  kings overlapped by 12 px), Black. Selected is `--acc-soft` with an inset 2 px `--acc` ring.
- **Rated**: a `Switch` row, at 50% opacity and inert while the bot is picked.
- The MainButton reads "Send challenge", or "Start game" for the bot, is disabled until an
  opponent is picked, and shows progress while sending. The in-page fallback button stays for
  clients without one.
- **The tab bar is hidden on this screen**: the MainButton owns the bottom edge, as in the
  prototype. `Router.showTabs` gains `newGame` as a tab-less route.

### 3.6 Settings

- "Settings" in the display face.
- A `Card` with one `Switch` row: "Receive turn
  notifications" (the copy changes from "Turn notifications"). Turning notifications on while the server reports `dmAllowed: false` calls
  `requestWriteAccess()` and sends the answer to `PUT /api/me/prefs` (`writeAccess`), the same
  call boot makes.
- A `Card` headed by the banner image, then three chevron rows: "Made by **@Jarvl**" / "Message
  the developer on Telegram" (`openTelegramLink('https://t.me/Jarvl')`); "Source code on
  GitHub" / "Jarvl/telegram-chess-bot" (`openLink`); "About & licences" (a popup with
  `app.settings.about`).
- "Delete my data", a centred `Card` in `--destructive`, confirmed as today.
- No Support / Stars card in this spec.

### 3.7 Screens the prototype does not draw

Rebuilt from the same parts so nothing looks left behind:

- **Player page:** `Avatar` 56 and the name in the display face, the record and games count,
  the head-to-head line, then "Recent games" as `GameCard`s.
- **GroupSettings:** its fields as `Card` rows with `SectionLabel`s, `Switch`es and `Tiles`
  where it has choices today.
- **Loading:** centred hint text only, no goat mark — it would flash on every screen change,
  since this is the one status screen shown on every navigation, not just a failure or a wall.
- **Error, Reopen, Locked:** centred, the goat mark at 72 px above the existing copy and
  buttons.

## 4. Telegram integration

New `Tg` methods, each version-gated through `FEATURE_MIN_VERSION`, each a no-op (or `false`,
so the caller falls back) below its version and in a plain browser:

| Feature | Min version | Use |
|---|---|---|
| `setHeaderColor('secondary_bg_color')`, `setBackgroundColor('secondary_bg_color')` | 6.1 | At boot and on `themeChanged`: the header melts into the page |
| `setBottomBarColor('secondary_bg_color')` | 7.10 | Same, for the bottom bar behind the MainButton |
| `MainButton.setParams({ color, text_color })` | (all) | The MainButton in `--acc` / `--acc-ink` of the current scheme |
| `SettingsButton.show()` + `settingsButtonClicked` | 7.0 | Shown at boot; selects the Settings tab |
| `showPopup` | 6.2 | `confirmDialog` resolves through a native popup (cancel + destructive) when supported; the in-page sheet otherwise. The About box uses it with a single OK |
| `enableClosingConfirmation` / `disableClosingConfirmation` | 6.2 | On while New game is mounted |
| `HapticFeedback.selectionChanged()` | 6.1 | Tab, segment, tile, opponent and switch changes. The existing impact and notification haptics stay |
| `openTelegramLink` | (all) | The author link |

`confirmDialog` keeps its signature, so GameView and Settings call sites do not change.

## 5. Testing and gates

Test-first, in the existing suites:

- **Shared:** schema tests for `GameSummary.fen`, `.lastMove`, `.engineLevel` and
  `PlayerRef.isBot`; the PGN tag test expects `[Event "Chess Goat"]`.
- **Server:** `/api/me/games`, the lobby (active and finished pages) and the player page carry
  the new fields; a game with no moves has `lastMove: null`; `isBot` is true only for the
  engine user; PGN assertions updated to Chess Goat.
- **Mini App unit (happy-dom):** `Avatar` initials, palette index and bot mark; `MiniBoard`
  pieces, last move and orientation; `GameCard` pill states (yours, urgent, other, finished)
  and dimming; theme accent swap light/dark; Lobby segmented control, the three chip cases
  and the finished-empty rule; the Leaderboard route (push, back, row opens Player); popup vs
  in-page confirm; SettingsButton selects Settings; closing confirmation on and off with New
  game; tab bar absent on New game; notifications toggle asks for write access. Existing
  screen tests move to the new markup through their `data-*` hooks.
- **e2e (Playwright):** existing specs updated; one new flow: lobby → leaderboard chip →
  player page → back.

Gates: `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test` (with
`TEST_DATABASE_URL`), `pnpm build && pnpm check:budget` (JS ≤ 120 KB, CSS ≤ 25 KB gzipped;
the font and images are not counted), `pnpm check:licences`, `pnpm e2e`. Then a visual pass in
the browser at 390 px, light and dark, against the prototype.
