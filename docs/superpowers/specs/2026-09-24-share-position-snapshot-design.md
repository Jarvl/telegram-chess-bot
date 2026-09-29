# Chess Goat: shared positions as snapshots

Status: accepted for planning, 2026-09-24. Panel layout revised 2026-09-24 to the prototype's
decluttered panel. Card redesigned 2026-09-29 to the prototype's portrait share image
(`Share Image Spec.md`, mockups 5c and 5e in `Share Image Options.dc.html`): §1, §3 and §4
describe that card, and the landscape panel is gone. Source design: the Claude Design project
`Chess Goat Prototype.dc.html` (the shared photo in the "back in the chat" view, and the
`Share position` action), with the reasoning in `Share Position Options.dc.html`: option **3a
"Snapshot label"** built on option **2a "Recent moves"**. Builds on the
[Chess Goat redesign](./2026-09-22-chess-goat-redesign-design.md) (PR #17) and replaces
[technical design §7.7](./2026-09-20-group-chess-technical-design.md#77-position-images).

## What this is

Today a shared position is a bare 1024 × 1024 brown board with the caption
`Alice shared move 1 · Alice vs Bob · White to move` and a `♟ Open game` button. People in the
group mistake the photo for a board they can play on. The new photo reads as a snapshot: a
portrait card with the board in the app's greens between the two players' bars, the material each
has taken and, once the game is over, its result, over a Chess Goat footer. The button says
`♟ Open live game`, so the playable board is clearly somewhere else.

| In scope | Out of scope |
|---|---|
| A 1024 × 1344 snapshot card replacing the 1024 × 1024 board | Editing the caption as the game moves on (option 3c) |
| Green board theme with a gold last-move tint | Per-user board themes or piece sets in the image |
| Text in the image: fonts fetched at build time, checksummed | A wall-clock time in the image |
| New caption and button copy | Any change to the Mini App's share button, toast or endpoint |
| Cache key over the whole card | The share rate limit (20 per user per minute, PR #22) |

Delivered as one PR against `main`, which has PR #22 merged.

### Deviations from the prototype

- **Check highlight kept.** The prototype does not draw it; the image keeps today's red glow on a
  king in check.
- **The bot's avatar is the goat mark**, as in the Mini App; the prototype draws ♞ on green.
- **The footer names the configured bot.** The prototype writes `@ChessGoatBot`; the card writes
  `@{BOT_USERNAME}`, so a staging bot's images name the staging bot.
- **Voided games show no result**, like aborted ones. The prototype has no voided state.
- **No flair yet.** The design puts each player's worn flair after the name; that arrives with the
  flair work.

## 1. The image

1024 × 1344 PNG, background `#153a26`. Top to bottom: the top player bar (128 px), the board
(1024 × 1024), the bottom player bar (128 px) and the brand footer (64 px). There are no
coordinates, group title, terms, move list or clock; the caption and the chat carry that context.
Telegram shows photos at up to 1280 on the long side (975 × 1280), where the smallest text (19 px)
is still about 18 px tall.

### 1.1 Board

- 128 px squares, light `#f0ead2`, dark `#7d9f6b` (the Mini App's `--bl` / `--bd`).
- Last move: both squares overlaid with `rgba(224,185,74,.6)`.
- Check: today's radial red gradient on the king of the side to move.
- Pieces: the cburnett set, as today.
- Orientation: the sharer's colour at the bottom when a player shares, White otherwise
  (unchanged); the result photo is drawn from the winner's side.
- Result badges (§3.2): each king's square gets a badge in its top-right corner, a 54 px disc in a
  4 px `#153a26` ring that touches the square's top and right edges, with a 32 px emoji and a soft
  shadow. 🏆 on `#e8c35a` for the winner, 💀 on `#d14e4e` for the loser, ⚖️ on `#f5f0dc` on both
  kings of a draw.

### 1.2 Player bars

The bar above the board belongs to the side at the top. 40 px side padding, 20 px between the
avatar, the two lines and the result tag.

- **Avatar**, a 72 px circle. A person gets the Mini App's avatar colour for their user id and
  their initial in white, 32 px bold (`avatarColour` and `personInitial`, now in
  `@group-chess/shared`). A person with a stored Telegram photo gets that photo over the circle
  instead ([profile photos spec](./2026-09-29-telegram-profile-photos-design.md)); the card uses
  whatever is stored when it renders. The bot gets the goat mark.
- **Line 1**, 14 px apart:
  - the name, 38 px bold `#f5f0dc`, cut with an ellipsis when it does not fit;
  - the rating, 28 px `#bcd3c2`: `ratingLabel(rating, provisional)` for the player's current
    rating in the group, the engine side's level (`app.level.*`), or none without a rating row;
  - on a rated game's final position (§3.2), the rating is the new one (`*_rating_after`) and is
    followed by the change, 26 px bold, `+16` in `#8fd6a8` or `−16` in `#ef8a8a`, left out when
    zero. The change is taken between the rounded ratings, so it matches the caption's
    `1512 → 1528`.
- **Line 2**: the opponent's pieces this side has taken (`material()`, now in
  `@group-chess/shared`), queen to pawn, 40 px each and overlapping by 14 px, each with a 1.5 px
  cream glow so black pieces read on the green; then `+N`, 26 px `#e8c35a`, on the side that is
  ahead. The line is left out when the side has taken nothing and is not ahead, and line 1 then
  centres against the avatar.
- **Result tag** (§3.2), 30 px bold, padding 12 × 22, radius 14: `Won` in `#2a2000` on `#e8c35a`;
  `Lost` in `#bcd3c2` and `Draw` in `#f5f0dc`, both on `rgba(245,240,220,.12)`.
- No turn indicator: the last-move tint implies whose move it is. The design's 800 weight draws
  in Bold, the heaviest bundled weight.

### 1.3 Brand footer

It says where the image came from once it is forwarded outside the group. 64 px on `#0f2c1d`,
padding 40 px left and 14 px right, 14 px gaps:

- the goat mark as a 40 px circle;
- `Chess Goat` in Young Serif 32 px, `Chess` in `#f5f0dc` and `Goat` in `#e8c35a` as in the banner
  art, the two words 8 px apart (the font's own word space);
- pushed to the right, `PLAY ON TELEGRAM` (`image.share.play_on_telegram`, upper-cased), 19 px
  bold with 0.14em letter-spacing, `#bcd3c2`; then a pill with `@{BOT_USERNAME}`, 25 px bold
  `#f5f0dc` on `rgba(245,240,220,.1)` with a 2 px `rgba(232,195,90,.45)` border (the design's
  inset ring).

### 1.4 Rendering pipeline

- **Satori** (`satori`, MPL-2.0) lays out the card from plain element objects (no React, no JSX)
  in `apps/server/src/images/snapshot.ts` and returns an SVG with text converted to paths.
- `board.ts` keeps producing the board as its own SVG (squares, highlights, pieces), embedded as
  one `<img>` data URI; its 800-unit viewBox is scaled to 1024 px, and `squarePixel` places the
  king badges over it.
- Pictures are embedded as data URIs, so the server needs no asset path at runtime.
  `scripts/vendor-snapshot-art.mjs` writes two generated modules: `emoji.ts`, the three badge
  emoji as Noto Color Emoji SVGs (Apache 2.0) from `googlefonts/noto-emoji` at a pinned tag,
  because Satori cannot draw colour-font glyphs; and `goatMark.ts`, the Mini App's
  `goat-mark.png`. Each taken piece is its own small SVG with an `feDropShadow` glow.
- `@resvg/resvg-js` rasterises Satori's SVG to PNG, as today. It needs no fonts, because Satori
  has already turned the text into paths.

## 2. Fonts

### 2.1 Which

All SIL Open Font License 1.1:

| File | Role |
|---|---|
| Noto Sans Regular, SemiBold, Bold (static TTF) | Latin, Cyrillic, Greek; weights 400 / 600 / 700 |
| Noto Emoji (monochrome, static weight-400 instance) | Emoji in names and group titles |
| Noto Sans Symbols 2 Regular | Chess glyphs (♔–♟) and other symbols chess groups put in titles |
| Noto Sans CJK SC Regular (OTF) | Chinese, Japanese and Korean names and titles |
| Young Serif Regular (static TTF) | The footer's `Chess Goat` wordmark only |

Satori is given them in that order and falls back glyph by glyph; Young Serif comes last, so it
never stands in for other text. CJK has one weight: bold CJK
text draws in Regular. Scripts none of these cover (Arabic, Hebrew, Devanagari, Thai, …) draw as
empty boxes; that is accepted.

Noto Emoji is published only as a variable font (`NotoEmoji[wght].ttf`), and Satori's font parser
throws on its `fvar` table. The static weight-400 instance Google Fonts serves from
`fonts.gstatic.com` has no `fvar` and parses; that versioned URL is the one pinned.

### 2.2 Where they come from

Font binaries are **not committed**. `scripts/fetch-fonts.mjs` holds a manifest of
`{ file, url, sha256 }` entries pointing at pinned sources: `notofonts/notofonts.github.io` at a
fixed commit (Noto Sans, Noto Sans Symbols 2), versioned `fonts.gstatic.com` URLs (Noto Emoji, Young Serif)
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

`loadFonts()` reads all seven files once. `main.ts` calls it at boot, before the job
worker starts; a missing or unreadable file exits the process with
`fonts missing in apps/server/fonts, run pnpm fonts`. The loaded fonts are passed to the share
job handler through its context, not read on each render.

## 3. Data flow

### 3.1 The job

`send_share_photo` keeps its trigger, idempotency (`messageId` already set → done), `left`-group
check, topic and `sendPhoto` call. On top of what it loads today, it reads:

- both players' `ratings` rows in that group (rating and provisional state);
- the game's `rated`, `engineLevel`, `status`, `result`, `plyCount`, `voidedAt` and rating
  snapshots (`*_rating_before`, `*_rating_after`, `*_rd_after`).

A pure `buildSnapshotModel(input)` turns that into everything the card shows: the top and bottom
bars (avatar, name, rating and change, taken pieces, lead, result), the footer's handle and the
board input. `renderSnapshotSvg(model, fonts)` lays it out; `renderSnapshotPng(svg)` rasterises
it. `send_result_photo` posts the same card for the final position.

### 3.2 Result

Only when the game is finished, `ply === plyCount`, the game is not voided and its result is
`1-0`, `0-1` or `1/2-1/2`. Then each bar gets its Won, Lost or Draw tag, each king its badge
(§1.1), and a rated game's bars show the new rating and its change (§1.2). Running games, earlier
positions, aborted games (`*`) and voided games show none of it; the result photo's caption
still says how the game ended.

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
| `image.share.play_on_telegram` (new) | `Play on Telegram`, upper-cased in the footer |

Reused: `ratingLabel`, `app.level.*` and the Mini App's result tags `app.game.tag.won`,
`app.game.tag.lost` and `app.game.tag.draw`. `renderShareCaption` drops its `sideToMove` field.

## 5. Errors

- Fonts missing at boot: the process exits with the message in §2.3.
- Fonts missing in tests or CI: the fetch in `globalSetup` fails the run with the download or
  checksum error.
- A render error inside the job throws; the existing worker retries and dead-letters it as it
  does any other job failure.
- A name or title in an uncovered script draws as blanks; it does not fail the render.

## 6. Testing

- **Unit, `buildSnapshotModel`:**
  - the bars follow the orientation for a White sharer, a Black sharer and a spectator;
  - a person's avatar colour and initial, and the bot's goat mark;
  - provisional, missing and engine ratings;
  - taken pieces biggest first, and the lead only on the side ahead;
  - Won, Lost and Draw only on a finished game's final position, and none for a running game, an
    earlier position, an aborted game or a voided one;
  - the new rating and its change, taken between rounded ratings, provisional kept, left out when
    zero, and the current rating instead for an earlier position or a voided game;
  - the footer handle from the bot's username.
- **Unit, rendering:** the PNG is 1024 × 1344; a card with CJK, emoji, XML-special and
  60-character names renders without throwing; the same model gives the same SVG, and so the
  same cache key; the goat mark is drawn in the footer and as a bot's avatar; the trophy, skull
  and scales land on the right kings' squares from either side, and not before the result.
- **Unit, fetch script:** a checksum mismatch exits non-zero, and a matching file is not
  downloaded again.
- **Integration (`share-photo.test.ts`, `result-photo.test.ts`):** updated caption and
  `♟ Open live game` button; the same finished position shared twice reuses the file id, and so
  does the same position of an active game shared again later; the same final position with a
  different rating change is a different image.
- **By eye:** `test/visual/render-samples.ts` writes sample PNGs (opening, a long game, finished,
  a checkmate from Black's side, a draw, a voided game, CJK/emoji names, long names, a bot game)
  to a scratch folder to compare against the prototype.
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
  in names draw in monochrome; only the badges' three emoji are in colour, as pictures. Emoji
  advance widths are generous, so an emoji-heavy title looks loosely spaced.

What remains:

- **Build-time network.** The Docker build and a fresh clone's first test run need to reach
  GitHub. CI is covered by its cache after the first run.
