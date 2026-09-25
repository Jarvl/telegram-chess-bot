# Chess Goat: shared positions as snapshots

Status: accepted for planning, 2026-09-24. Panel layout revised 2026-09-24 to the prototype's
decluttered panel (§1.2, §3.2). Source design: the Claude Design project
`Chess Goat Prototype.dc.html` (the shared photo in the "back in the chat" view, and the
`Share position` action), with the reasoning in `Share Position Options.dc.html`: option **3a
"Snapshot label"** built on option **2a "Recent moves"**. Builds on the
[Chess Goat redesign](./2026-09-22-chess-goat-redesign-design.md) (PR #17) and replaces
[technical design §7.7](./2026-09-20-group-chess-technical-design.md#77-position-images).

## What this is

Today a shared position is a bare 1024 × 1024 brown board with the caption
`Alice shared move 1 · Alice vs Bob · White to move` and a `♟ Open game` button. People in the
group mistake the photo for a board they can play on. The new photo reads as a snapshot: a
landscape card with the board in the app's greens, the group and its terms, the players, the
recent moves and, once the game is over, its result. The button says
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

- **No clock on the card.** The prototype drops the status line while a game is running (it
  neither says whose move it is nor how much time is left); only a finished game's final
  position carries one. Telegram's own message timestamp shows when it was shared.
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

Padding 56 px top and bottom, 64 px left and right; 40 px between the blocks below, top to bottom.
Lengths below count characters (code points), so an emoji counts once.

1. **Header**, 10 px apart:
   - Group title, bold `#153a26`, 34 px (30 px above 60 characters), line height 1.2. It wraps,
     breaking inside a word if it must.
   - Terms, 28 px `#707579`: `{timePerMove} · {Rated|Casual}` (existing labels).
2. **Players**, 26 px apart: the player at the top of the board first. Each is a 28 px dot
   (`#ffffff` with a 3 px `#c9c2ab` ring for White, `#2b2b2b` for Black), 18 px from the display
   name (600, line height 1.15), with the dot centred on the name's first line. Both names use
   one size, set by the longer: 40 px up to 16 characters, 34 px up to 22, 30 px beyond. Names
   wrap, breaking inside a word if they must. Under the name, 8 px down and indented to line up
   with it, the rating (30 px, `#707579`): the player's current rating in the group via
   `ratingLabel(rating, provisional)`; the engine side shows its level (`app.level.*`); a player
   with no rating row shows none.
3. **Divider.** 3 px, `#e2dcc6`.
4. **Moves.** Rows of `n.`, White's SAN, Black's SAN in columns 84 / 190 / 190 px, 34 px, line
   height 1.2, 14 px between rows. Move numbers `#9a9a8e`. The move that produced the shared
   position is highlighted: background `#e3f1e7`, text `#256b42`, bold, 10 px radius. Only moves
   up to the shared ply appear, and only the last 6 rows (5 when the group title is over 30
   characters, 4 when over 60, since a longer title wraps onto more lines). No row is faded. At
   ply 0 the list is empty. The list takes the remaining height and clips if it runs out.
5. **Status**, 34 px bold `#256b42`, line height 1.2: only for a finished game's final position
   (see §3.2); otherwise there is no status line.

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
  `plyCount`, and the SAN of every move up to the shared ply.

A pure `buildSnapshotModel(input)` turns that into everything the card shows (group, terms,
ordered players, move rows with highlight, status, board input).
`renderSnapshotSvg(model, fonts)` lays it out; `renderPng(svg)` rasterises it.

### 3.2 Status line

Only when the game is finished and `ply === plyCount`; every other share has none.

- Voided by an admin: `Voided by an admin`, naming no winner.
- Decisive: `{winner} won · {endReason} · 1-0` (or `0-1`).
- Draw: `Draw · {endReason} · ½-½`.
- `*` (aborted): the end reason's label (`Aborted`), or `Aborted` when there is none.

### 3.3 Cache

`board_images` stays as it is. The key becomes `sha256` of the card SVG from Satori. Identical
cards still reuse Telegram's `file_id` (two people sharing a finished game's final position, or
the same position of a running game), and any change to what the card shows, including the
theme, is a different key. Existing rows
keyed the old way are never hit again and can stay.

## 4. Copy

`packages/shared/src/i18n/en.ts`:

| Key | Text |
|---|---|
| `card.share.caption` (changed) | `{sharer} shared move {moveNumber} of {white} vs {black}` |
| `button.open_live_game` (new) | `♟ Open live game`, on share photos only; other cards keep `♟ Open game` |
| `image.share.won` (new) | `{player} won` |

Reused: `game.rated`, `game.casual`, `timePerMoveLabel`, `resultLabel`,
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
  - up to the row limit shows all; more shows only the last rows; the limit is 6, 5 or 4 by the
    group title's length;
  - the highlight falls on White's or Black's half of the last row;
  - every status line in §3.2, and none for a running game or an earlier position;
  - orientation for a White sharer, a Black sharer and a spectator;
  - ply 0 (empty list);
  - an engine game shows the level, and a player with no rating row shows none.
- **Unit, rendering:** the name and group font sizes step down at their thresholds; the PNG is 1664 × 1024; a card with a CJK name, an emoji group title and
  a 60-character name renders without throwing; the same model gives the same SVG, and so the
  same cache key.
- **Unit, fetch script:** a checksum mismatch exits non-zero, and a matching file is not
  downloaded again.
- **Integration (`share-photo.test.ts`):** updated caption and `♟ Open live game` button;
  the same finished position shared twice reuses the file id, and so does the same position of
  an active game shared again later.
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
