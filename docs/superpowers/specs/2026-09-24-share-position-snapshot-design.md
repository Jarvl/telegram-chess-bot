# Chess Goat: shared positions as snapshots

Status: accepted for planning, 2026-09-24. Source design: the Claude Design project
`Chess Goat Prototype.dc.html` (the shared photo in the "back in the chat" view, and the
`Share position` action), with the reasoning in `Share Position Options.dc.html`: option **3a
"Snapshot label"** built on option **2a "Recent moves"**. Builds on the
[Chess Goat redesign](./2026-09-22-chess-goat-redesign-design.md) (PR #17) and replaces
[technical design §7.7](./2026-09-20-group-chess-technical-design.md#77-position-images).

## What this is

Today a shared position is a bare 1024 × 1024 brown board with the caption
`Alice shared move 1 · Alice vs Bob · White to move` and a `♟ Open game` button. People in the
group mistake the photo for a board they can play on. The new photo reads as a snapshot: a
landscape card with the board in the app's greens, a dark `SNAPSHOT · MOVE 30` label, the
players, the recent moves, where the game stood and the group's terms. The button says
`♟ Open live game`, so the playable board is clearly somewhere else.

| In scope | Out of scope |
|---|---|
| A 1664 × 1024 snapshot card replacing the 1024 × 1024 board | Editing the caption as the game moves on (option 3c) |
| Green board theme with coordinates and a gold last-move tint | Per-user board themes or piece sets in the image |
| Text in the image: fonts fetched at build time, checksummed | A wall-clock time in the image |
| New caption and button copy | Any change to the Mini App's share button, toast or endpoint |
| Cache key over the whole card | The share rate limit (20 per user per minute, PR #22) |

Delivered as one PR against `main`, which has PR #22 merged.

### Deviations from the prototype

- **No wall-clock time.** The prototype's pill says `Snapshot · 19:42`, but the server does not
  know anyone's timezone. The pill says `Snapshot · Move {n}` instead; Telegram's own message
  timestamp already shows when it was shared, in each viewer's zone.
- **Faded row only when moves were cut.** The prototype fades the top row once there are more
  than 7 rows, which also fades the first row of an uncut 8-row list. Here the top row fades only
  when rows before it were left out (more than 8 rows).
- **Check highlight kept.** The prototype does not draw it; the image keeps today's red glow on a
  king in check.
- **Result line names the winner.** The prototype's `You won` is viewer-relative; a group photo
  says `{winner} won`.

## 1. The image

1664 × 1024 PNG, background `#f5f0dc`, text `#15181d`. Telegram shrinks photos to 1280 on the
long side (1280 × 788), where the smallest text (32 px) is still about 25 px tall.

### 1.1 Board (left, 1024 × 1024)

- 128 px squares, light `#f0ead2`, dark `#7d9f6b` (the Mini App's `--bl` / `--bd`).
- Last move: both squares overlaid with `rgba(224,185,74,.6)`.
- Check: today's radial red gradient on the king of the side to move.
- Pieces: the cburnett set, as today.
- Coordinates inside the edge squares, bold 24 px, coloured as the opposite square colour: the
  file letter at the bottom-right of each bottom-row square (8 px from the right, 5 px from the
  bottom), the rank digit at the top-left of each left-column square (8 px, 7 px).
- Orientation: the sharer's colour at the bottom when a player shares, White otherwise
  (unchanged).

### 1.2 Panel (right, 640 × 1024)

Padding 44 px top and bottom, 56 px left and right; 26 px between the blocks below, top to bottom.

1. **Pill.** `#153a26` background, `#f5f0dc` text, 30 px bold, uppercase, letter-spacing .06em,
   padding 12/26/12/20, fully rounded, with the prototype's 36 px camera glyph. Text:
   `Snapshot · Move {n}` where `n = max(1, ceil(ply / 2))`, the same number the caption uses.
2. **Players**, 22 px apart: the player at the top of the board first. Each row: a 34 px dot
   (`#ffffff` with an inset 3 px `#c9c2ab` ring for White, `#2b2b2b` for Black), the display
   name (46 px, 600), then the rating (38 px, `#707579`). The rating is the player's current
   rating in the group via `ratingLabel(rating, provisional)`; the engine side shows its level
   (`app.level.*`); a player with no rating row shows none. Long names end in an ellipsis.
3. **Divider.** 3 px, `#e2dcc6`.
4. **Moves.** Rows of `n.`, White's SAN, Black's SAN in columns 90 px / 1fr / 1fr, 36 px,
   tabular numbers, 10 px between rows. Move numbers `#9a9a8e`. The move that produced the
   shared position is highlighted: background `#e3f1e7`, text `#256b42`, bold, 12 px radius.
   Only moves up to the shared ply appear. With more than 8 rows, the last 8 show and the top
   one is drawn at 25 % opacity. At ply 0 the list is empty.
5. **Footer**, 10 px apart, each line ending in an ellipsis if too long:
   - Status, 40 px bold `#256b42` (see §3.2).
   - Group title, 32 px `#707579`.
   - Terms, 32 px `#707579`: `{timePerMove} · {Rated|Casual}` (existing labels).

### 1.3 Rendering pipeline

- **Satori** (`satori`, MPL-2.0) lays out the card from plain element objects (no React, no JSX)
  and returns an SVG with text converted to paths. It lives in a new
  `apps/server/src/images/snapshot.ts`.
- `board.ts` keeps producing the board as its own SVG (squares, highlights, pieces). The card
  embeds it as one `<img>` data URI; the coordinates are text elements drawn over it by Satori.
  `renderBoardSvg` changes to the green theme; its 800-unit viewBox is scaled to 1024 px.
- `@resvg/resvg-js` rasterises Satori's SVG to PNG, as today. It needs no fonts, because Satori
  has already turned the text into paths.
- Satori has no CSS grid; the move list is flex rows with fixed column widths.

## 2. Fonts

### 2.1 Which

All SIL Open Font License 1.1:

| File | Role |
|---|---|
| Noto Sans Regular, SemiBold, Bold (static TTF) | Latin, Cyrillic, Greek; weights 400 / 600 / 700 |
| Noto Emoji (monochrome, static weight-400 instance) | Emoji in names and group titles |
| Noto Sans Symbols 2 Regular | Chess glyphs (♔–♟) and other symbols chess groups put in titles |
| Noto Sans CJK SC Regular (OTF) | Chinese, Japanese and Korean names and titles |

Satori is given them in that order and falls back glyph by glyph. CJK has one weight: bold CJK
text draws in Regular. Scripts none of these cover (Arabic, Hebrew, Devanagari, Thai, …) draw as
empty boxes; that is accepted.

Noto Emoji is published only as a variable font (`NotoEmoji[wght].ttf`), and Satori's font parser
throws on its `fvar` table. The static weight-400 instance Google Fonts serves from
`fonts.gstatic.com` has no `fvar` and parses; that versioned URL is the one pinned.

### 2.2 Where they come from

Font binaries are **not committed**. `scripts/fetch-fonts.mjs` holds a manifest of
`{ file, url, sha256 }` entries pointing at pinned sources: `notofonts/notofonts.github.io` at a
fixed commit (Noto Sans, Noto Sans Symbols 2), a versioned `fonts.gstatic.com` URL (Noto Emoji)
and `notofonts/noto-cjk` at tag `Sans2.004`. The exact URLs and hashes are in the implementation
plan.

- It downloads into `apps/server/fonts/`, skips any file already present with the right hash,
  and exits non-zero on a download failure or a checksum mismatch. A changed upstream file
  fails the build; it never slips in.
- `apps/server/fonts/` holds the committed `OFL.txt` and a `README.md` naming each font's source
  and version. `.gitignore` ignores `apps/server/fonts/*.ttf` and `*.otf`; `.dockerignore`
  ignores them too, so a developer's local copies never enter the build context.
- `ATTRIBUTION.md` in `apps/server/src/images/` gains a section for the fonts.
- Root script: `pnpm fonts`.

The three places that need them:

- **Tests.** `apps/server/vitest.config.ts` gets a `globalSetup` that runs the fetch for every
  run, unit tests included (today's `globalSetup` is only for the database). A fresh clone with
  network access passes `pnpm test` with no extra step.
- **CI.** `ci.yml` caches `apps/server/fonts` with `actions/cache`, keyed on
  `hashFiles('scripts/fetch-fonts.mjs')`, before `pnpm test`.
- **Docker.** A new `fonts` stage from `base` copies `scripts/fetch-fonts.mjs` and runs it; the
  runtime stage copies `apps/server/fonts/` from that stage. The existing `pnpm install` step
  is untouched, because it runs before `scripts/` is in the image, which is why this is not a
  `postinstall` hook.

### 2.3 Loading

`loadFonts()` reads all six files once. `main.ts` calls it at boot, before the job
worker starts; a missing or unreadable file exits the process with
`fonts missing in apps/server/fonts, run pnpm fonts`. The loaded fonts are passed to the share
job handler through its context, not read on each render.

## 3. Data flow

### 3.1 The job

`send_share_photo` keeps its trigger, idempotency (`messageId` already set → done), `left`-group
check, topic and `sendPhoto` call. On top of what it loads today, it reads:

- the group's title;
- both players' `ratings` rows in that group (rating and provisional state);
- the game's `timePerMove`, `rated`, `engineLevel`, `status`, `result`, `endReason`,
  `deadlineAt`, `plyCount`, and the SAN of every move up to the shared ply.

A pure `buildSnapshotModel(input)` turns that into everything the card shows (pill text,
ordered players, move rows with highlight and fade, status, group, terms, board input).
`renderSnapshotSvg(model, fonts)` lays it out; `renderPng(svg)` rasterises it.

### 3.2 Status line

In this order, first match wins:

1. The game is finished and `ply === plyCount`: the result.
   - Decisive: `{winner} won · {endReason} · 1-0` (or `0-1`).
   - Draw: `Draw · {endReason} · ½-½`.
   - `*` (aborted or voided): the end reason's label (`Aborted`, `Voided by an admin`), or
     `Aborted` when there is none.
2. Otherwise `{White|Black} to move`, where the side is taken from the shared position, then:
   - `· No clock` when `timePerMove` is null;
   - `· {left} left` when the game is active and `ply === plyCount`, with
     `left = deadlineAt − share.createdAt`, clamped at zero: `{d}d {h}h` from 24 hours up,
     `{h}h {m}m` below;
   - nothing otherwise (an earlier position, or a finished game's earlier position).

`share.createdAt` is the moment the user tapped share, so a job that runs late still shows the
time as it was.

### 3.3 Cache

`board_images` stays as it is. The key becomes `sha256` of the card SVG from Satori. Identical
cards still reuse Telegram's `file_id` (two people sharing a finished game's final position, or
a no-clock game's position), and any change to what the card shows, including the theme, is a
different key. A card with a live clock nearly always misses, which is correct. Existing rows
keyed the old way are never hit again and can stay.

## 4. Copy

`packages/shared/src/i18n/en.ts`:

| Key | Text |
|---|---|
| `card.share.caption` (changed) | `{sharer} shared move {moveNumber} of {white} vs {black}` |
| `button.open_live_game` (new) | `♟ Open live game`, on share photos only; other cards keep `♟ Open game` |
| `image.share.snapshot` (new) | `Snapshot · Move {moveNumber}` (uppercased by the layout) |
| `image.share.to_move` (new) | `{side} to move` |
| `image.share.time_left` (new) | `{time} left` |
| `image.share.won` (new) | `{player} won` |

Reused: `colour.*`, `game.rated`, `game.casual`, `timePerMoveLabel` (its `No clock` is also the
status line's), `resultLabel`,
`endReasonLabel`, `ratingLabel`, `app.level.*`, `app.game.result.draw`,
`app.game.result.aborted`. `renderShareCaption` drops its `sideToMove` field.

## 5. Errors

- Fonts missing at boot: the process exits with the message in §2.3.
- Fonts missing in tests or CI: the fetch in `globalSetup` fails the run with the download or
  checksum error.
- A render error inside the job throws; the existing worker retries and dead-letters it as it
  does any other job failure.
- A name or title in an uncovered script draws as blanks; it does not fail the render.

## 6. Testing

- **Unit, `buildSnapshotModel`:**
  - 8 rows or fewer shows all, none faded; 9 or more shows the last 8 with the first faded;
  - the highlight falls on White's or Black's half of the last row;
  - every status line in §3.2, including the day and hour formats, zero clamping and an earlier
    ply of an active timed game;
  - orientation for a White sharer, a Black sharer and a spectator;
  - ply 0 (empty list, `Move 1`);
  - an engine game shows the level, and a player with no rating row shows none.
- **Unit, rendering:** the PNG is 1664 × 1024; a card with a CJK name, an emoji group title and
  a 60-character name renders without throwing; the same model gives the same SVG, and so the
  same cache key.
- **Unit, fetch script:** a checksum mismatch exits non-zero, and a matching file is not
  downloaded again.
- **Integration (`share-photo.test.ts`):** updated caption and `♟ Open live game` button;
  the same finished position shared twice reuses the file id; an active timed game shared
  twice uploads twice.
- **By eye:** a script writes sample PNGs (opening, a long game, finished, CJK/emoji names,
  Black's orientation) to a scratch folder to compare against the prototype.
- **Docker:** the existing `e2e.yml` image build exercises the `fonts` stage and the boot check.

## 7. Documents to update

- Technical design §7.7: this rendering, the fonts, and the new cache key.
- PRD: the "Shared position" row of the chat-messages table (the snapshot card, the new
  caption, **♟ Open live game**), the example under "Shared position:", and the "Shared
  position image" row ("no keyboard except Open live game").

## 8. Risks

A throwaway spike (Satori 0.33.5, resvg-js 2.6.2, the six pinned fonts) settled the two open
questions before planning:

- **Satori with a 16 MB CJK font.** First render with all fonts about 110 ms, later renders about
  2 ms; the CJK font adds about 34 MB of heap. Acceptable; no subsetting.
- **Emoji through font fallback.** Emoji, CJK, Greek, Cyrillic, chess symbols and ellipsis
  truncation all draw with the font list alone; no `loadAdditionalAsset` hook is needed. Emoji
  advance widths are generous, so an emoji-heavy title looks loosely spaced.

What remains:

- **Build-time network.** The Docker build and a fresh clone's first test run need to reach
  GitHub. CI is covered by its cache after the first run.
