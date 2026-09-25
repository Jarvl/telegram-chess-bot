# Share Position Snapshot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bare 1024 × 1024 shared-position photo with a 1664 × 1024 "snapshot" card
(green board, players, recent moves, status, group and terms), with the new caption and a
`♟ Open live game` button.

**Architecture:** A pure `buildSnapshotModel()` turns game data into what the card shows. Satori
lays that model out as an SVG, with text already converted to paths, using six Noto fonts that
`scripts/fetch-fonts.mjs` downloads by pinned URL and sha256. resvg rasterises the SVG. The
`send_share_photo` job keys the Telegram `file_id` cache on a hash of the card SVG.

**Tech Stack:** TypeScript (ESM, run by tsx), Satori 0.33, @resvg/resvg-js 2.6, drizzle +
PostgreSQL, grammY, vitest 5, pnpm 10 workspaces, Docker (node:22-bookworm-slim).

**Spec:** [docs/superpowers/specs/2026-09-24-share-position-snapshot-design.md](../specs/2026-09-24-share-position-snapshot-design.md)

## Global Constraints

- Card: 1664 × 1024 PNG; board 1024 × 1024 on the left; background `#f5f0dc`, text `#15181d`.
- Board squares light `#f0ead2`, dark `#7d9f6b`; last move `rgba(224, 185, 74, 0.6)`; a1 is dark.
- Font binaries are never committed. `apps/server/fonts/*.ttf`, `*.otf` and `*.part` are ignored by
  git and by Docker; `OFL.txt` and `README.md` in that folder are committed.
- Fonts in Satori's fallback order: Noto Sans 400 / 600 / 700, Noto Emoji, Noto Sans Symbols 2,
  Noto Sans CJK SC 400.
- Boot message when fonts are missing, exactly: `fonts missing in apps/server/fonts, run pnpm fonts`.
- Copy (en.ts), exactly:
  - `card.share.caption`: `{sharer} shared move {moveNumber} of {white} vs {black}`
  - `button.open_live_game`: `♟ Open live game`
  - `image.share.snapshot`: `Snapshot · Move {moveNumber}`
  - `image.share.to_move`: `{side} to move`
  - `image.share.time_left`: `{time} left`
  - `image.share.won`: `{player} won`
- Move number of a share: `max(1, ceil(ply / 2))`, used by both the pill and the caption.
- At most 8 move rows; the top row is faded (opacity 0.25) only when earlier rows were cut.
- Time left: `deadlineAt − share.createdAt`, clamped at 0; `{d}d {h}h` from 24 h up, else `{h}h {m}m`.
- The share rate limit (20 per user per minute, PR #22) and the Mini App are not touched.
- New dependency licences must pass `pnpm check:licences` (Satori is MPL-2.0, on the allow-list).
- Integration tests on this machine: use your own database, not the shared one. Once:
  `docker exec $(docker ps -qf name=db) psql -U postgres -c "create database group_chess_test_share"`,
  then `export TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/group_chess_test_share`.
  If the daemon is down, start Docker Desktop (`open -a Docker`), never OrbStack.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **XML-special characters in names and titles** (`<b>&"'`): the card must render, not produce a
   broken SVG. Pinned in Task 5.
2. **A truncated or corrupt font file left by an interrupted download**: the next fetch must
   replace it, not trust it. Pinned in Task 1.
3. **A deadline that has already passed when the share is made** (the scanner has not timed the
   game out yet): the status says `0h 0m left`, never a negative time. Pinned in Task 4.
4. **ZWJ emoji, flags and a 60-character unbroken name**: the card must render, and the name ends in
   an ellipsis rather than overflowing. Pinned in Task 5.
5. **A spectator sharing a bot game**: White at the bottom, and the engine's level shown on the
   engine's own row. Pinned in Task 4.

---

## File Structure

| Path | Status | Responsibility |
|---|---|---|
| `scripts/fetch-fonts.mjs` | create | Pinned font manifest; idempotent, checksummed download |
| `scripts/fetch-fonts.d.mts` | create | Types for importing the script from TypeScript tests |
| `apps/server/fonts/OFL.txt`, `README.md` | create | Licence and provenance (binaries are downloaded here) |
| `apps/server/test/helpers/fonts.ts` | create | vitest `globalSetup` that runs the fetch |
| `apps/server/src/images/fonts.ts` | create | `loadFonts()` for Satori, with the boot error |
| `apps/server/src/images/board.ts` | modify | Green theme; `isLightSquare`; drop `renderBoardPng` (Task 6) |
| `apps/server/src/images/snapshotModel.ts` | create | Pure model: pill, players, rows, status, terms |
| `apps/server/src/images/snapshot.ts` | create | Satori layout and resvg rasterisation of the card |
| `apps/server/src/images/cache.ts` | modify | `snapshotImageKey(svg)` replaces `boardImageKey` |
| `apps/server/src/jobs/handlers/sharePhoto.ts` | modify | Builds the model, renders the card, new copy |
| `apps/server/src/telegram/cards.ts` | modify | `renderShareCaption` without `sideToMove` |
| `apps/server/src/main.ts` | modify | Loads fonts at boot for the `jobs` role |
| `packages/shared/src/i18n/en.ts` | modify | New and changed strings |
| `apps/server/test/helpers/snapshotFixtures.ts` | create | `snapshotInput()` shared by tests and the sample script |
| `apps/server/test/visual/render-samples.ts` | create | Writes sample PNGs for checking by eye |
| `Dockerfile`, `.dockerignore`, `.gitignore`, `package.json`, `.github/workflows/{ci,e2e}.yml` | modify | Fonts in the build, CI and repo |
| `docs/…` | modify | Technical design §7.7, PRD, running and testing docs |

---

### Task 1: Fetch fonts by pinned checksum

**Files:**
- Create: `scripts/fetch-fonts.mjs`, `scripts/fetch-fonts.d.mts`, `apps/server/fonts/OFL.txt`,
  `apps/server/fonts/README.md`, `apps/server/test/helpers/fonts.ts`,
  `apps/server/test/unit/fetch-fonts.test.ts`
- Modify: `package.json` (root scripts), `apps/server/vitest.config.ts`, `.gitignore`,
  `.dockerignore`, `.github/workflows/ci.yml`, `.github/workflows/e2e.yml`,
  `apps/server/src/images/ATTRIBUTION.md`

**Interfaces:**
- Produces: `fetchFonts(options?: { dir?: string; manifest?: readonly FontEntry[]; fetchImpl?: typeof fetch }): Promise<string[]>`
  (the names it downloaded), `FONT_MANIFEST: readonly FontEntry[]`, `FONTS_DIR: string`
  (absolute path to `apps/server/fonts/`), `type FontEntry = { file: string; url: string; sha256: string }`.
  `pnpm fonts` runs it. Every server test run has the fonts in `apps/server/fonts/`.

- [ ] **Step 0: Install dependencies (the worktree has none yet)**

Run: `pnpm install`
Expected: completes with no errors.

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/unit/fetch-fonts.test.ts`:

```ts
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FONT_MANIFEST, fetchFonts, type FontEntry } from '../../../../scripts/fetch-fonts.mjs';

const BYTES = Buffer.from('pretend font bytes');
const ENTRY: FontEntry = {
  file: 'Test-Regular.ttf',
  url: 'https://example.test/Test-Regular.ttf',
  sha256: createHash('sha256').update(BYTES).digest('hex'),
};

const serving = (body: Buffer, status = 200) =>
  vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fonts-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('fetchFonts', () => {
  it('downloads a missing font and verifies it', async () => {
    const fetchImpl = serving(BYTES);
    expect(await fetchFonts({ dir, manifest: [ENTRY], fetchImpl })).toEqual(['Test-Regular.ttf']);
    expect(await readFile(join(dir, ENTRY.file))).toEqual(BYTES);
  });

  it('skips a font already present with the right checksum', async () => {
    await writeFile(join(dir, ENTRY.file), BYTES);
    const fetchImpl = serving(BYTES);
    expect(await fetchFonts({ dir, manifest: [ENTRY], fetchImpl })).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('replaces a truncated file left by an interrupted download', async () => {
    await writeFile(join(dir, ENTRY.file), BYTES.subarray(0, 4));
    expect(await fetchFonts({ dir, manifest: [ENTRY], fetchImpl: serving(BYTES) })).toEqual([
      'Test-Regular.ttf',
    ]);
    expect(await readFile(join(dir, ENTRY.file))).toEqual(BYTES);
  });

  it('fails on a checksum mismatch and leaves nothing behind', async () => {
    await expect(
      fetchFonts({ dir, manifest: [ENTRY], fetchImpl: serving(Buffer.from('changed upstream')) }),
    ).rejects.toThrow(/Test-Regular\.ttf: sha256 [0-9a-f]{64}, expected/);
    expect(await readdir(dir)).toEqual([]);
  });

  it('fails on an HTTP error', async () => {
    await expect(
      fetchFonts({ dir, manifest: [ENTRY], fetchImpl: serving(Buffer.alloc(0), 404) }),
    ).rejects.toThrow('Test-Regular.ttf: HTTP 404 from https://example.test/Test-Regular.ttf');
  });
});

describe('FONT_MANIFEST', () => {
  it('pins six fonts by https URL and sha256', () => {
    expect(FONT_MANIFEST.map((entry) => entry.file)).toEqual([
      'NotoSans-Regular.ttf',
      'NotoSans-SemiBold.ttf',
      'NotoSans-Bold.ttf',
      'NotoEmoji-Regular.ttf',
      'NotoSansSymbols2-Regular.ttf',
      'NotoSansCJKsc-Regular.otf',
    ]);
    for (const entry of FONT_MANIFEST) {
      expect(entry.url).toMatch(/^https:\/\//);
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @group-chess/server exec vitest run test/unit/fetch-fonts.test.ts`
Expected: FAIL, because `scripts/fetch-fonts.mjs` cannot be resolved.

- [ ] **Step 3: Write the script and its types**

Create `scripts/fetch-fonts.mjs`:

```js
#!/usr/bin/env node
// Share-position snapshot spec §2.2: the snapshot card's fonts are downloaded, never committed.
// Every file is pinned by URL and sha256, so a changed upstream file fails here instead of shipping.
// Idempotent: a file already present with the right hash is not downloaded again, and a file with
// the wrong bytes (an interrupted download, say) is replaced. Writes go through `<file>.part` and a
// rename, so a crash never leaves a half-written font under its real name.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const NOTO =
  'https://raw.githubusercontent.com/notofonts/notofonts.github.io/e0ad9f160a2942bcdd249bb1958e8336742edef3/fonts';

/** Satori's fallback order (spec §2.1); `apps/server/src/images/fonts.ts` loads them in this order. */
export const FONT_MANIFEST = [
  {
    file: 'NotoSans-Regular.ttf',
    url: `${NOTO}/NotoSans/hinted/ttf/NotoSans-Regular.ttf`,
    sha256: '478c558ea716033cd60c03438f628dfa75694dcf6b5f6d505a2f05fd2b4f3823',
  },
  {
    file: 'NotoSans-SemiBold.ttf',
    url: `${NOTO}/NotoSans/hinted/ttf/NotoSans-SemiBold.ttf`,
    sha256: 'a4e91fd530ac2b4ef5367240144ff37d7d65d66cf76f2e9a2187b93c676f92d0',
  },
  {
    file: 'NotoSans-Bold.ttf',
    url: `${NOTO}/NotoSans/hinted/ttf/NotoSans-Bold.ttf`,
    sha256: '1df075a380fc7cb898acf64c1f7b3b4dd780de3caa860178bf929de35817a913',
  },
  {
    // The static weight-400 instance Google Fonts serves. The upstream file is a variable font
    // whose `fvar` table Satori's parser throws on (spec §2.1).
    file: 'NotoEmoji-Regular.ttf',
    url: 'https://fonts.gstatic.com/s/notoemoji/v65/bMrnmSyK7YY-MEu6aWjPDs-ar6uWaGWuob-r0jwv.ttf',
    sha256: '988621dc5c9a75eb6144f28faae30317a8e3421b68b28740747b3d739e2326b8',
  },
  {
    file: 'NotoSansSymbols2-Regular.ttf',
    url: `${NOTO}/NotoSansSymbols2/hinted/ttf/NotoSansSymbols2-Regular.ttf`,
    sha256: 'c4a0a80f0041ce4be81e2478faad22776d23edb98ae3f0d19bd37044820ecf9d',
  },
  {
    file: 'NotoSansCJKsc-Regular.otf',
    url: 'https://raw.githubusercontent.com/notofonts/noto-cjk/Sans2.004/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf',
    sha256: '2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b',
  },
];

export const FONTS_DIR = fileURLToPath(new URL('../apps/server/fonts/', import.meta.url));

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

async function readIfPresent(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/** Downloads every entry missing from `dir` or whose bytes do not match; returns what it fetched. */
export async function fetchFonts({ dir = FONTS_DIR, manifest = FONT_MANIFEST, fetchImpl = fetch } = {}) {
  await mkdir(dir, { recursive: true });
  const downloaded = [];
  for (const entry of manifest) {
    const path = join(dir, entry.file);
    const existing = await readIfPresent(path);
    if (existing && sha256(existing) === entry.sha256) continue;
    const response = await fetchImpl(entry.url);
    if (!response.ok) throw new Error(`${entry.file}: HTTP ${response.status} from ${entry.url}`);
    const data = Buffer.from(await response.arrayBuffer());
    const actual = sha256(data);
    if (actual !== entry.sha256) {
      await rm(path, { force: true });
      throw new Error(`${entry.file}: sha256 ${actual}, expected ${entry.sha256}`);
    }
    await writeFile(`${path}.part`, data);
    await rename(`${path}.part`, path);
    downloaded.push(entry.file);
  }
  return downloaded;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  fetchFonts().then(
    (files) => console.log(files.length ? `fetched ${files.join(', ')}` : 'fonts up to date'),
    (error) => {
      console.error(error.message);
      process.exit(1);
    },
  );
}
```

Create `scripts/fetch-fonts.d.mts`:

```ts
export type FontEntry = { file: string; url: string; sha256: string };
export const FONT_MANIFEST: readonly FontEntry[];
export const FONTS_DIR: string;
export function fetchFonts(options?: {
  dir?: string;
  manifest?: readonly FontEntry[];
  fetchImpl?: typeof fetch;
}): Promise<string[]>;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @group-chess/server exec vitest run test/unit/fetch-fonts.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Wire it into the repo, tests and CI**

Root `package.json` `scripts`, after `"check:licences"`:

```json
    "fonts": "node scripts/fetch-fonts.mjs"
```

Append to `.gitignore`:

```
# The snapshot card's fonts are downloaded by `pnpm fonts` (scripts/fetch-fonts.mjs).
apps/server/fonts/*.ttf
apps/server/fonts/*.otf
apps/server/fonts/*.part
```

Append to `.dockerignore` (the Docker `fonts` stage in Task 7 fetches its own copies):

```
apps/server/fonts/*.ttf
apps/server/fonts/*.otf
apps/server/fonts/*.part
```

Create `apps/server/test/helpers/fonts.ts`:

```ts
import { fetchFonts } from '../../../../scripts/fetch-fonts.mjs';

/** Every server test run, unit tests included, gets the snapshot card's fonts (spec §2.2). */
export default async function setup(): Promise<void> {
  await fetchFonts();
}
```

In `apps/server/vitest.config.ts`, replace the `globalSetup` line with:

```ts
    globalSetup: ['test/helpers/fonts.ts', ...(hasDatabase ? ['test/helpers/globalSetup.ts'] : [])],
```

In `.github/workflows/ci.yml`, insert before `- run: pnpm test`:

```yaml
      - uses: actions/cache@v4
        with:
          path: apps/server/fonts
          key: fonts-${{ hashFiles('scripts/fetch-fonts.mjs') }}
      - run: pnpm fonts
```

In `.github/workflows/e2e.yml`, in the `e2e` job, insert the same two steps before `- run: pnpm e2e`
(the harness boots the server with the `jobs` role, which loads the fonts from Task 6 on).

- [ ] **Step 6: Commit the licence and provenance files**

Fetch the OFL text:

```bash
curl -fsSL -o apps/server/fonts/OFL.txt https://raw.githubusercontent.com/google/fonts/23e54b51ddffbc7713c583748e3bd86f62b1fa4a/ofl/notosans/OFL.txt
```

Create `apps/server/fonts/README.md`:

```markdown
# Snapshot card fonts

The shared-position image draws its text with these fonts. The binaries are not in git:
`pnpm fonts` (`scripts/fetch-fonts.mjs`) downloads them here from the pinned URLs and checks each
one's sha256. Tests fetch them automatically; the Docker image fetches them in its `fonts` stage.

| File | Source | Copyright |
|---|---|---|
| `NotoSans-{Regular,SemiBold,Bold}.ttf` | notofonts/notofonts.github.io @ e0ad9f1 | 2022 The Noto Project Authors |
| `NotoEmoji-Regular.ttf` | fonts.gstatic.com, Noto Emoji v65 static instance | 2013 Google LLC |
| `NotoSansSymbols2-Regular.ttf` | notofonts/notofonts.github.io @ e0ad9f1 | 2022 The Noto Project Authors |
| `NotoSansCJKsc-Regular.otf` | notofonts/noto-cjk, tag Sans2.004 | 2014-2021 Adobe |

All are licensed under the SIL Open Font License 1.1 (`OFL.txt`). They are used unmodified.
```

Append to `apps/server/src/images/ATTRIBUTION.md`:

```markdown

# Font attribution

The text on shared-position images is drawn with Noto Sans, Noto Emoji, Noto Sans Symbols 2 and
Noto Sans CJK SC, under the SIL Open Font License 1.1. `apps/server/fonts/README.md` lists each
file's source and copyright; `apps/server/fonts/OFL.txt` is the licence.
```

- [ ] **Step 7: Verify the real fetch and the ignore rules**

Run: `pnpm fonts && pnpm fonts && git status --short apps/server/fonts`
Expected: the first run prints `fetched NotoSans-Regular.ttf, …` (six names), the second prints
`fonts up to date`, and `git status` lists only `OFL.txt` and `README.md`.

- [ ] **Step 8: Typecheck, lint, format and commit**

Run: `pnpm typecheck && pnpm lint && pnpm format:check`
Expected: all pass. If Prettier flags new files, run `pnpm format` and re-run.

```bash
git add scripts/fetch-fonts.mjs scripts/fetch-fonts.d.mts apps/server/fonts/OFL.txt apps/server/fonts/README.md apps/server/test/helpers/fonts.ts apps/server/test/unit/fetch-fonts.test.ts apps/server/vitest.config.ts package.json .gitignore .dockerignore .github/workflows/ci.yml .github/workflows/e2e.yml apps/server/src/images/ATTRIBUTION.md
git commit -m "Fetch the snapshot card's fonts by pinned checksum

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Load the fonts for Satori

**Files:**
- Create: `apps/server/src/images/fonts.ts`, `apps/server/test/unit/fonts.test.ts`
- Modify: `apps/server/package.json` (adds `satori`)

**Interfaces:**
- Consumes: `FONT_MANIFEST` from Task 1 (the test compares file lists).
- Produces: `loadFonts(dir?: string): Promise<SnapshotFonts>`, `type SnapshotFonts = Font[]` (Satori's
  `Font`), `FONT_FILES: readonly string[]`, `FONTS_DIR: string`.

- [ ] **Step 1: Add Satori**

Run: `pnpm --filter @group-chess/server add satori@^0.33.5`
Expected: `apps/server/package.json` lists `"satori": "^0.33.5"` under `dependencies`.

- [ ] **Step 2: Write the failing test**

Create `apps/server/test/unit/fonts.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FONT_MANIFEST } from '../../../../scripts/fetch-fonts.mjs';
import { FONT_FILES, loadFonts } from '../../src/images/fonts';

describe('loadFonts', () => {
  it('loads every fetched font, in the fallback order', async () => {
    const fonts = await loadFonts();
    expect(fonts.map((font) => [font.name, font.weight])).toEqual([
      ['Noto Sans', 400],
      ['Noto Sans', 600],
      ['Noto Sans', 700],
      ['Noto Emoji', 400],
      ['Noto Sans Symbols 2', 400],
      ['Noto Sans CJK SC', 400],
    ]);
    for (const font of fonts) expect((font.data as Buffer).length).toBeGreaterThan(100_000);
  });

  it('loads exactly the files the fetch script downloads', () => {
    expect(FONT_FILES).toEqual(FONT_MANIFEST.map((entry) => entry.file));
  });

  it('says how to fix a missing font', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'no-fonts-'));
    try {
      await expect(loadFonts(empty)).rejects.toThrow(
        'fonts missing in apps/server/fonts, run pnpm fonts',
      );
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @group-chess/server exec vitest run test/unit/fonts.test.ts`
Expected: FAIL, because `../../src/images/fonts` does not exist.

- [ ] **Step 4: Implement**

Create `apps/server/src/images/fonts.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Font } from 'satori';

export type SnapshotFonts = Font[];

/** Where `pnpm fonts` puts them (`scripts/fetch-fonts.mjs`). */
export const FONTS_DIR = fileURLToPath(new URL('../../fonts/', import.meta.url));

/** Spec §2.1, in Satori's fallback order: the first font with a glyph draws it. */
const FONTS = [
  { file: 'NotoSans-Regular.ttf', name: 'Noto Sans', weight: 400 },
  { file: 'NotoSans-SemiBold.ttf', name: 'Noto Sans', weight: 600 },
  { file: 'NotoSans-Bold.ttf', name: 'Noto Sans', weight: 700 },
  { file: 'NotoEmoji-Regular.ttf', name: 'Noto Emoji', weight: 400 },
  { file: 'NotoSansSymbols2-Regular.ttf', name: 'Noto Sans Symbols 2', weight: 400 },
  { file: 'NotoSansCJKsc-Regular.otf', name: 'Noto Sans CJK SC', weight: 400 },
] as const;

export const FONT_FILES: readonly string[] = FONTS.map((font) => font.file);

/** Spec §2.3: read once at boot; a missing file stops the process with the fix in the message. */
export async function loadFonts(dir: string = FONTS_DIR): Promise<SnapshotFonts> {
  return Promise.all(
    FONTS.map(async ({ file, name, weight }) => {
      try {
        return { name, weight, style: 'normal' as const, data: await readFile(join(dir, file)) };
      } catch (error) {
        throw new Error(
          `fonts missing in apps/server/fonts, run pnpm fonts (${file}: ${(error as Error).message})`,
        );
      }
    }),
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @group-chess/server exec vitest run test/unit/fonts.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Licences, typecheck, lint, commit**

Run: `pnpm check:licences && pnpm typecheck && pnpm lint && pnpm format:check`
Expected: all pass (Satori is MPL-2.0; its dependencies are MIT).

```bash
git add apps/server/package.json pnpm-lock.yaml apps/server/src/images/fonts.ts apps/server/test/unit/fonts.test.ts
git commit -m "Load the snapshot fonts for Satori, failing clearly when missing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Green board theme

**Files:**
- Modify: `apps/server/src/images/board.ts`, `apps/server/test/unit/board.test.ts`

**Interfaces:**
- Produces: `BOARD_LIGHT = '#f0ead2'`, `BOARD_DARK = '#7d9f6b'`,
  `isLightSquare(file: number, rank: number): boolean` (0-based; a1 = (0, 0) is dark).
  `renderBoardSvg(input: BoardRenderInput): string` keeps its signature, still an 800-unit viewBox
  at 1024 px. `IMAGE_SIZE = 1024` is unchanged.

- [ ] **Step 1: Update the tests first**

In `apps/server/test/unit/board.test.ts`:

- Change the import to
  `import { isLightSquare, parsePlacement, renderBoardPng, renderBoardSvg } from '../../src/images/board';`
- In `draws 64 squares with a dark a1…`, change the expected a1 rect to
  `'<rect x="0" y="700" width="100" height="100" fill="#7d9f6b"/>'`.
- In `boardImageKey`, change the last assertion's theme argument from `'blue'` to `'brown'` (the
  old theme is now the "different" one).
- Add, after the `parsePlacement` describe:

```ts
describe('isLightSquare', () => {
  it('has a dark a1 and a light h1 and a8', () => {
    expect(isLightSquare(0, 0)).toBe(false);
    expect(isLightSquare(7, 0)).toBe(true);
    expect(isLightSquare(0, 7)).toBe(true);
  });
});
```

- In `highlights the last move squares and the checked king`, add:

```ts
    expect(svg).toContain('fill="rgba(224, 185, 74, 0.6)"');
    expect(svg).toContain('fill="#f0ead2"');
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @group-chess/server exec vitest run test/unit/board.test.ts`
Expected: FAIL (`isLightSquare` is not exported; old colours in the SVG).

- [ ] **Step 3: Implement**

In `apps/server/src/images/board.ts`, replace the constants block and the square loop:

```ts
export const BOARD_THEME = 'green';
export const IMAGE_SIZE = 1024;
const SQUARE = 100;
/** The Mini App's board (`--bl` / `--bd`) and the prototype's gold last-move tint. */
export const BOARD_LIGHT = '#f0ead2';
export const BOARD_DARK = '#7d9f6b';
const LAST_MOVE = 'rgba(224, 185, 74, 0.6)';
```

```ts
/** 0-based file (a = 0) and rank (first rank = 0); a1 is dark. */
export function isLightSquare(file: number, rank: number): boolean {
  return (file + rank) % 2 === 1;
}
```

and in `renderBoardSvg`:

```ts
      parts.push(rect(null, x, y, isLightSquare(file, rank) ? BOARD_LIGHT : BOARD_DARK));
```

Delete the old `LIGHT` and `DARK` constants. Change the doc comment on `renderBoardSvg` to
`/** Snapshot spec §1.1: green squares, last-move and check highlights, cburnett glyphs; no text. */`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @group-chess/server exec vitest run test/unit/board.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/images/board.ts apps/server/test/unit/board.test.ts
git commit -m "Draw shared boards in the app's green theme

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The snapshot model and its copy

**Files:**
- Create: `apps/server/src/images/snapshotModel.ts`, `apps/server/test/helpers/snapshotFixtures.ts`,
  `apps/server/test/unit/snapshotModel.test.ts`
- Modify: `packages/shared/src/i18n/en.ts`

**Interfaces:**
- Consumes: `BoardRenderInput` from `board.ts`; shared `t`, `ratingLabel`, `isProvisional`,
  `timePerMoveLabel`, `ratedLabel`, `resultLabel`, `endReasonLabel`, `sideToMove`.
- Produces (exact):

```ts
export const SNAPSHOT_MAX_ROWS = 8;
export type SnapshotSide = { name: string; rating: { rating: number; rd: number } | null; engineLevel: EngineLevel | null };
export type SnapshotInput = {
  ply: number; sans: readonly string[]; board: BoardRenderInput;
  white: SnapshotSide; black: SnapshotSide; groupTitle: string;
  timePerMove: TimePerMove; rated: boolean; status: GameStatus;
  result: GameResult | null; endReason: EndReason | null; plyCount: number;
  deadlineAt: Date | null; sharedAt: Date;
};
export type SnapshotPlayer = { colour: Colour; name: string; rating: string | null };
export type SnapshotCell = { san: string; current: boolean };
export type SnapshotRow = { number: number; white: SnapshotCell; black: SnapshotCell | null; faded: boolean };
export type SnapshotModel = {
  board: BoardRenderInput; pill: string; players: [SnapshotPlayer, SnapshotPlayer];
  rows: SnapshotRow[]; status: string; group: string; terms: string;
};
export function shareMoveNumber(ply: number): number;
export function formatSnapshotTimeLeft(ms: number): string;
export function buildSnapshotModel(input: SnapshotInput): SnapshotModel;
```

  Test helper: `snapshotInput(overrides?: Partial<SnapshotInput>): SnapshotInput`, `SHARED_AT: Date`,
  `AFTER_E4: string` from `test/helpers/snapshotFixtures.ts`.

- [ ] **Step 1: Add the strings**

In `packages/shared/src/i18n/en.ts`, directly after the `'card.share.caption'` entry, add:

```ts
  'image.share.snapshot': 'Snapshot · Move {moveNumber}',
  'image.share.to_move': '{side} to move',
  'image.share.time_left': '{time} left',
  'image.share.won': '{player} won',
```

- [ ] **Step 2: Write the fixture helper**

Create `apps/server/test/helpers/snapshotFixtures.ts`:

```ts
import { INITIAL_FEN } from '@group-chess/shared';
import type { SnapshotInput } from '../../src/images/snapshotModel';

export const SHARED_AT = new Date('2026-09-24T12:00:00Z');
export const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';

/** An active, rated, one-day game at its start, shared by White; override what a test needs. */
export function snapshotInput(overrides: Partial<SnapshotInput> = {}): SnapshotInput {
  return {
    ply: 0,
    sans: [],
    board: { fen: INITIAL_FEN, lastMove: null, check: false, orientation: 'white' },
    white: { name: '@sam_k', rating: { rating: 1512, rd: 50 }, engineLevel: null },
    black: { name: '@mayachess', rating: { rating: 1587, rd: 50 }, engineLevel: null },
    groupTitle: 'Friday Chess Club',
    timePerMove: 86400,
    rated: true,
    status: 'active',
    result: null,
    endReason: null,
    plyCount: 0,
    deadlineAt: new Date(SHARED_AT.getTime() + 86_400_000),
    sharedAt: SHARED_AT,
    ...overrides,
  };
}
```

- [ ] **Step 3: Write the failing tests**

Create `apps/server/test/unit/snapshotModel.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  buildSnapshotModel,
  formatSnapshotTimeLeft,
  shareMoveNumber,
} from '../../src/images/snapshotModel';
import { AFTER_E4, SHARED_AT, snapshotInput } from '../helpers/snapshotFixtures';

const sans = (count: number): string[] => Array.from({ length: count }, (_, i) => `m${i + 1}`);
const at = (ms: number): Date => new Date(SHARED_AT.getTime() + ms);
const HOUR = 3_600_000;
const MINUTE = 60_000;

describe('shareMoveNumber', () => {
  it('counts the initial position as move 1 and rounds half-moves up', () => {
    expect([0, 1, 2, 3, 59, 60].map(shareMoveNumber)).toEqual([1, 1, 1, 2, 30, 30]);
  });
});

describe('formatSnapshotTimeLeft', () => {
  it('uses days and hours from a day up, hours and minutes below, and never goes negative', () => {
    expect(formatSnapshotTimeLeft(14 * HOUR + 32 * MINUTE + 59_000)).toBe('14h 32m');
    expect(formatSnapshotTimeLeft(26 * HOUR + 5 * MINUTE)).toBe('1d 2h');
    expect(formatSnapshotTimeLeft(24 * HOUR)).toBe('1d 0h');
    expect(formatSnapshotTimeLeft(59_999)).toBe('0h 0m');
    expect(formatSnapshotTimeLeft(-5 * MINUTE)).toBe('0h 0m');
  });
});

describe('buildSnapshotModel', () => {
  it('labels the pill with the move number', () => {
    expect(buildSnapshotModel(snapshotInput()).pill).toBe('Snapshot · Move 1');
    expect(buildSnapshotModel(snapshotInput({ ply: 59, plyCount: 59, sans: sans(59) })).pill).toBe(
      'Snapshot · Move 30',
    );
  });

  it('lists the player at the top of the board first', () => {
    const fromWhite = buildSnapshotModel(snapshotInput());
    expect(fromWhite.players).toEqual([
      { colour: 'black', name: '@mayachess', rating: '1587' },
      { colour: 'white', name: '@sam_k', rating: '1512' },
    ]);
    const fromBlack = buildSnapshotModel(
      snapshotInput({ board: { ...snapshotInput().board, orientation: 'black' } }),
    );
    expect(fromBlack.players.map((player) => player.colour)).toEqual(['white', 'black']);
  });

  it('marks provisional ratings and leaves out a missing one', () => {
    const model = buildSnapshotModel(
      snapshotInput({
        white: { name: 'New', rating: { rating: 1500, rd: 300 }, engineLevel: null },
        black: { name: 'Unrated', rating: null, engineLevel: null },
      }),
    );
    expect(model.players.map((player) => player.rating)).toEqual([null, '1500?']);
  });

  it("shows a bot's level on its own row when a spectator shares a bot game", () => {
    const model = buildSnapshotModel(
      snapshotInput({
        timePerMove: null,
        rated: false,
        deadlineAt: null,
        black: { name: 'Chess Goat', rating: { rating: 1500, rd: 350 }, engineLevel: 'strong' },
      }),
    );
    expect(model.players[0]).toEqual({ colour: 'black', name: 'Chess Goat', rating: 'Strong' });
    expect(model.players[1]).toEqual({ colour: 'white', name: '@sam_k', rating: '1512' });
    expect(model.terms).toBe('No clock · Casual');
  });

  it('shows every row up to 8, with the shared move highlighted', () => {
    const even = buildSnapshotModel(snapshotInput({ ply: 16, plyCount: 16, sans: sans(16) }));
    expect(even.rows).toHaveLength(8);
    expect(even.rows.some((row) => row.faded)).toBe(false);
    expect(even.rows[7]).toEqual({
      number: 8,
      white: { san: 'm15', current: false },
      black: { san: 'm16', current: true },
      faded: false,
    });
    const odd = buildSnapshotModel(snapshotInput({ ply: 15, plyCount: 15, sans: sans(15) }));
    expect(odd.rows[7]).toEqual({
      number: 8,
      white: { san: 'm15', current: true },
      black: null,
      faded: false,
    });
  });

  it('keeps the last 8 rows and fades the top one once earlier moves are cut', () => {
    const model = buildSnapshotModel(snapshotInput({ ply: 17, plyCount: 17, sans: sans(17) }));
    expect(model.rows.map((row) => row.number)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(model.rows.map((row) => row.faded)).toEqual([
      true, false, false, false, false, false, false, false,
    ]);
    expect(model.rows[7]?.white).toEqual({ san: 'm17', current: true });
  });

  it('has no rows at the initial position', () => {
    expect(buildSnapshotModel(snapshotInput()).rows).toEqual([]);
  });

  describe('status', () => {
    const status = (overrides: Parameters<typeof snapshotInput>[0]) =>
      buildSnapshotModel(snapshotInput(overrides)).status;

    it('gives the time left at the moment of sharing for the latest position', () => {
      expect(status({ deadlineAt: at(14 * HOUR + 32 * MINUTE) })).toBe(
        'White to move · 14h 32m left',
      );
      expect(status({ deadlineAt: at(26 * HOUR) })).toBe('White to move · 1d 2h left');
    });

    it('never shows a negative time when the deadline has already passed', () => {
      expect(status({ deadlineAt: at(-3 * MINUTE) })).toBe('White to move · 0h 0m left');
    });

    it('leaves the clock out of an earlier position', () => {
      expect(
        status({
          ply: 1,
          plyCount: 2,
          sans: ['e4'],
          board: { fen: AFTER_E4, lastMove: 'e2e4', check: false, orientation: 'white' },
        }),
      ).toBe('Black to move');
    });

    it('says there is no clock in an untimed game', () => {
      expect(status({ timePerMove: null, deadlineAt: null })).toBe('White to move · No clock');
    });

    it('names the winner, the reason and the score of a finished game', () => {
      const finished = { status: 'finished' as const, deadlineAt: null };
      expect(status({ ...finished, result: '1-0', endReason: 'checkmate' })).toBe(
        '@sam_k won · Checkmate · 1-0',
      );
      expect(status({ ...finished, result: '0-1', endReason: 'timeout' })).toBe(
        '@mayachess won · Timeout · 0-1',
      );
      expect(status({ ...finished, result: '1/2-1/2', endReason: 'draw_agreement' })).toBe(
        'Draw · Draw agreed · ½-½',
      );
    });

    it('says how an unfinished game ended', () => {
      const finished = { status: 'finished' as const, deadlineAt: null, result: '*' as const };
      expect(status({ ...finished, endReason: 'abort' })).toBe('Aborted');
      expect(status({ ...finished, endReason: 'voided' })).toBe('Voided by an admin');
      expect(status({ ...finished, endReason: null })).toBe('Aborted');
    });

    it('shows whose move it was for an earlier position of a finished game', () => {
      expect(
        status({
          status: 'finished',
          result: '1-0',
          endReason: 'resignation',
          deadlineAt: null,
          ply: 1,
          plyCount: 40,
          sans: ['e4'],
          board: { fen: AFTER_E4, lastMove: 'e2e4', check: false, orientation: 'white' },
        }),
      ).toBe('Black to move');
    });
  });

  it('passes the group through and joins the terms', () => {
    const model = buildSnapshotModel(snapshotInput());
    expect(model.group).toBe('Friday Chess Club');
    expect(model.terms).toBe('1 day per move · Rated');
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `pnpm --filter @group-chess/server exec vitest run test/unit/snapshotModel.test.ts`
Expected: FAIL, because `../../src/images/snapshotModel` does not exist.

- [ ] **Step 5: Implement**

Create `apps/server/src/images/snapshotModel.ts`:

```ts
import {
  endReasonLabel,
  isProvisional,
  ratedLabel,
  ratingLabel,
  resultLabel,
  sideToMove,
  t,
  timePerMoveLabel,
  type Colour,
  type EndReason,
  type EngineLevel,
  type GameResult,
  type GameStatus,
  type TimePerMove,
} from '@group-chess/shared';
import type { BoardRenderInput } from './board';

/** Snapshot spec §1.2: rows the panel shows before it cuts the oldest. */
export const SNAPSHOT_MAX_ROWS = 8;

export type SnapshotSide = {
  name: string;
  rating: { rating: number; rd: number } | null;
  /** Set for the engine's side of a bot game; shown instead of a rating. */
  engineLevel: EngineLevel | null;
};

export type SnapshotInput = {
  ply: number;
  /** SAN of plies 1..ply, in order. */
  sans: readonly string[];
  board: BoardRenderInput;
  white: SnapshotSide;
  black: SnapshotSide;
  groupTitle: string;
  timePerMove: TimePerMove;
  rated: boolean;
  status: GameStatus;
  result: GameResult | null;
  endReason: EndReason | null;
  plyCount: number;
  deadlineAt: Date | null;
  /** When the user tapped Share: the clock is shown as it was then (spec §3.2). */
  sharedAt: Date;
};

export type SnapshotPlayer = { colour: Colour; name: string; rating: string | null };
export type SnapshotCell = { san: string; current: boolean };
export type SnapshotRow = {
  number: number;
  white: SnapshotCell;
  black: SnapshotCell | null;
  faded: boolean;
};

/** Everything the card shows, already worded (spec §1.2). */
export type SnapshotModel = {
  board: BoardRenderInput;
  pill: string;
  /** The player at the top of the board first. */
  players: [SnapshotPlayer, SnapshotPlayer];
  rows: SnapshotRow[];
  status: string;
  group: string;
  terms: string;
};

/** The move a share names in its pill and caption; the initial position counts as move 1. */
export function shareMoveNumber(ply: number): number {
  return Math.max(1, Math.ceil(ply / 2));
}

/** `1d 2h` from a day up, `14h 32m` below; never negative. */
export function formatSnapshotTimeLeft(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  return hours >= 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h` : `${hours}h ${minutes % 60}m`;
}

function player(colour: Colour, side: SnapshotSide): SnapshotPlayer {
  const rating = side.engineLevel
    ? t(`app.level.${side.engineLevel}`)
    : side.rating
      ? ratingLabel(side.rating.rating, isProvisional(side.rating.rd))
      : null;
  return { colour, name: side.name, rating };
}

function moveRows(sans: readonly string[]): SnapshotRow[] {
  const last = sans.length - 1;
  const rows: SnapshotRow[] = [];
  for (let index = 0; index < sans.length; index += 2) {
    const black = sans[index + 1];
    rows.push({
      number: index / 2 + 1,
      white: { san: sans[index]!, current: index === last },
      black: black === undefined ? null : { san: black, current: index + 1 === last },
      faded: false,
    });
  }
  if (rows.length <= SNAPSHOT_MAX_ROWS) return rows;
  return rows
    .slice(-SNAPSHOT_MAX_ROWS)
    .map((row, index) => (index === 0 ? { ...row, faded: true } : row));
}

const joined = (parts: (string | null)[]): string => parts.filter(Boolean).join(' · ');

function resultLine(input: SnapshotInput): string {
  const reason = input.endReason ? endReasonLabel(input.endReason) : null;
  if (input.result === '1-0' || input.result === '0-1') {
    const winner = input.result === '1-0' ? input.white : input.black;
    return joined([t('image.share.won', { player: winner.name }), reason, resultLabel(input.result)]);
  }
  if (input.result === '1/2-1/2')
    return joined([t('app.game.result.draw'), reason, resultLabel(input.result)]);
  return reason ?? t('app.game.result.aborted');
}

/** Spec §3.2, first match wins. */
function statusLine(input: SnapshotInput): string {
  const latest = input.ply === input.plyCount;
  if (input.status === 'finished' && latest) return resultLine(input);
  const toMove = t('image.share.to_move', { side: t(`colour.${sideToMove(input.board.fen)}`) });
  if (input.timePerMove === null) return joined([toMove, timePerMoveLabel(null)]);
  if (input.status === 'active' && latest && input.deadlineAt) {
    const left = input.deadlineAt.getTime() - input.sharedAt.getTime();
    return joined([toMove, t('image.share.time_left', { time: formatSnapshotTimeLeft(left) })]);
  }
  return toMove;
}

export function buildSnapshotModel(input: SnapshotInput): SnapshotModel {
  const white = player('white', input.white);
  const black = player('black', input.black);
  return {
    board: input.board,
    pill: t('image.share.snapshot', { moveNumber: shareMoveNumber(input.ply) }),
    players: input.board.orientation === 'white' ? [black, white] : [white, black],
    rows: moveRows(input.sans),
    status: statusLine(input),
    group: input.groupTitle,
    terms: joined([timePerMoveLabel(input.timePerMove), ratedLabel(input.rated)]),
  };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @group-chess/server exec vitest run test/unit/snapshotModel.test.ts`
Expected: PASS. Then run `pnpm --filter @group-chess/shared exec vitest run` to confirm the i18n
additions broke nothing: PASS.

- [ ] **Step 7: Format, typecheck, lint, commit**

Run: `pnpm format && pnpm typecheck && pnpm lint`
Expected: all pass. (Prettier reflows the long `faded` array in the test; that is expected.)

```bash
git add packages/shared/src/i18n/en.ts apps/server/src/images/snapshotModel.ts apps/server/test/helpers/snapshotFixtures.ts apps/server/test/unit/snapshotModel.test.ts
git commit -m "Model what a shared snapshot shows: players, recent moves, status

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Render the snapshot card

**Files:**
- Create: `apps/server/src/images/snapshot.ts`, `apps/server/test/unit/snapshot.test.ts`,
  `apps/server/test/visual/render-samples.ts`

**Interfaces:**
- Consumes: `SnapshotModel` (Task 4), `SnapshotFonts` and `loadFonts` (Task 2), `renderBoardSvg`,
  `isLightSquare`, `BOARD_LIGHT`, `BOARD_DARK` and `IMAGE_SIZE` (Task 3).
- Produces: `CARD_WIDTH = 1664`, `CARD_HEIGHT = 1024`,
  `renderSnapshotSvg(model: SnapshotModel, fonts: SnapshotFonts): Promise<string>`,
  `renderSnapshotPng(svg: string): Buffer`.

- [ ] **Step 1: Write the failing tests**

Create `apps/server/test/unit/snapshot.test.ts`:

```ts
import { beforeAll, describe, expect, it } from 'vitest';
import { loadFonts, type SnapshotFonts } from '../../src/images/fonts';
import { renderSnapshotPng, renderSnapshotSvg } from '../../src/images/snapshot';
import { buildSnapshotModel, type SnapshotInput } from '../../src/images/snapshotModel';
import { snapshotInput } from '../helpers/snapshotFixtures';

let fonts: SnapshotFonts;
beforeAll(async () => {
  fonts = await loadFonts();
});

const render = (overrides: Partial<SnapshotInput> = {}) =>
  renderSnapshotSvg(buildSnapshotModel(snapshotInput(overrides)), fonts);

describe('renderSnapshotPng', () => {
  it('rasterises the card to a 1664 × 1024 PNG', async () => {
    const png = renderSnapshotPng(await render());
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.readUInt32BE(16)).toBe(1664);
    expect(png.readUInt32BE(20)).toBe(1024);
  });
});

describe('renderSnapshotSvg', () => {
  it('is deterministic, and changes with what the card shows', async () => {
    expect(await render()).toBe(await render());
    expect(await render()).not.toBe(await render({ groupTitle: 'Another club' }));
    expect(await render()).not.toBe(
      await render({ board: { ...snapshotInput().board, orientation: 'black' } }),
    );
  });

  it('draws text as paths, so the SVG carries no font dependency', async () => {
    const svg = await render();
    expect(svg).toMatch(/^<svg /);
    expect(svg).not.toContain('<text');
  });

  it.each([
    ['CJK and Hangul names', { name: '李小龍 さくら 김민수', rating: null, engineLevel: null }],
    ['a 60-character unbroken name', { name: 'x'.repeat(60), rating: null, engineLevel: null }],
    ['XML-special characters', { name: `<b>&"'</b>`, rating: null, engineLevel: null }],
  ])('renders %s without throwing', async (_label, white) => {
    const svg = await render({ white });
    expect(() => renderSnapshotPng(svg)).not.toThrow();
  });

  it('renders emoji, ZWJ sequences, flags and chess symbols in a group title', async () => {
    const svg = await render({ groupTitle: '♞ Goats 🐐🔥 👨‍👩‍👧 🇺🇦 & <friends>' });
    expect(() => renderSnapshotPng(svg)).not.toThrow();
  });

  it('renders a long game with faded rows and a finished result', async () => {
    const sans = Array.from({ length: 61 }, (_, i) => (i % 2 ? 'Nxe5+' : 'Qxd8#'));
    const svg = await render({
      ply: 61,
      plyCount: 61,
      sans,
      status: 'finished',
      result: '1-0',
      endReason: 'checkmate',
      deadlineAt: null,
    });
    expect(() => renderSnapshotPng(svg)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @group-chess/server exec vitest run test/unit/snapshot.test.ts`
Expected: FAIL, because `../../src/images/snapshot` does not exist.

- [ ] **Step 3: Implement**

Create `apps/server/src/images/snapshot.ts`:

```ts
import { Resvg } from '@resvg/resvg-js';
import satori from 'satori';
import { BOARD_DARK, BOARD_LIGHT, IMAGE_SIZE, isLightSquare, renderBoardSvg } from './board';
import type { SnapshotFonts } from './fonts';
import type { SnapshotCell, SnapshotModel, SnapshotPlayer, SnapshotRow } from './snapshotModel';

/** Snapshot spec §1: the board on the left, the panel on the right. */
export const CARD_WIDTH = 1664;
export const CARD_HEIGHT = 1024;

const SQUARE = IMAGE_SIZE / 8;
const FILES = 'abcdefgh';
const PAGE = '#f5f0dc';
const INK = '#15181d';
const MUTED = '#707579';
const GREEN = '#256b42';
/** The prototype's camera glyph, filled in the pill's text colour. */
const CAMERA =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#f5f0dc" fill-rule="evenodd" d="M9 4.5h6l1.4 2H20a1.5 1.5 0 0 1 1.5 1.5v10A1.5 1.5 0 0 1 20 19.5H4A1.5 1.5 0 0 1 2.5 18V8A1.5 1.5 0 0 1 4 6.5h3.6L9 4.5Zm3 4a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9Zm0 2a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Z"/></svg>';

type Style = Record<string, string | number>;
type Child = El | string;
/** The element shape Satori reads; plain objects, so the server needs no React. */
type El = { type: string; props: Record<string, unknown> };

function el(
  type: string,
  style: Style,
  children: Child[] = [],
  attributes: Record<string, unknown> = {},
): El {
  return {
    type,
    props: { ...attributes, style, ...(children.length ? { children } : {}) },
  };
}

const svgDataUri = (svg: string): string =>
  `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

/** One line that ends in an ellipsis instead of wrapping. */
const ONE_LINE: Style = {
  overflow: 'hidden',
  whiteSpace: 'nowrap',
  textOverflow: 'ellipsis',
  minWidth: 0,
};

function coordinate(text: string, onLightSquare: boolean, position: Style): El {
  const color = onLightSquare ? BOARD_DARK : BOARD_LIGHT;
  return el('span', { position: 'absolute', fontSize: 24, fontWeight: 700, lineHeight: 1, color, ...position }, [text]);
}

/** §1.1: the board image with files along the bottom row and ranks down the left column. */
function board(model: SnapshotModel): El {
  const white = model.board.orientation === 'white';
  const labels: El[] = [];
  for (let index = 0; index < 8; index += 1) {
    const file = white ? index : 7 - index;
    const bottomRank = white ? 0 : 7;
    labels.push(
      coordinate(FILES[file]!, isLightSquare(file, bottomRank), {
        right: (7 - index) * SQUARE + 8,
        bottom: 5,
      }),
    );
    const rank = white ? 7 - index : index;
    const leftFile = white ? 0 : 7;
    labels.push(
      coordinate(String(rank + 1), isLightSquare(leftFile, rank), {
        left: 8,
        top: index * SQUARE + 7,
      }),
    );
  }
  return el(
    'div',
    { display: 'flex', position: 'relative', width: IMAGE_SIZE, height: IMAGE_SIZE, flexShrink: 0 },
    [
      el('img', { position: 'absolute', left: 0, top: 0 }, [], {
        src: svgDataUri(renderBoardSvg(model.board)),
        width: IMAGE_SIZE,
        height: IMAGE_SIZE,
      }),
      ...labels,
    ],
  );
}

function pill(text: string): El {
  return el(
    'div',
    {
      display: 'flex',
      alignItems: 'center',
      alignSelf: 'flex-start',
      gap: 16,
      padding: '12px 26px 12px 20px',
      borderRadius: 999,
      background: '#153a26',
      color: PAGE,
      fontSize: 30,
      fontWeight: 700,
      lineHeight: 1,
      letterSpacing: '0.06em',
      textTransform: 'uppercase',
      whiteSpace: 'nowrap',
    },
    [el('img', {}, [], { src: svgDataUri(CAMERA), width: 36, height: 36 }), el('span', {}, [text])],
  );
}

function playerRow(player: SnapshotPlayer): El {
  const dot: Style =
    player.colour === 'white'
      ? { background: '#ffffff', border: '3px solid #c9c2ab' }
      : { background: '#2b2b2b' };
  return el('div', { display: 'flex', alignItems: 'center', gap: 20 }, [
    el('div', { width: 34, height: 34, borderRadius: 17, flexShrink: 0, ...dot }),
    el('span', { fontSize: 46, fontWeight: 600, lineHeight: 1, flexShrink: 1, ...ONE_LINE }, [
      player.name,
    ]),
    ...(player.rating
      ? [el('span', { fontSize: 38, color: MUTED, lineHeight: 1, flexShrink: 0 }, [player.rating])]
      : []),
  ]);
}

function cell(value: SnapshotCell | null): El {
  const current: Style = value?.current
    ? { background: '#e3f1e7', color: GREEN, fontWeight: 700 }
    : {};
  return el(
    'div',
    { display: 'flex', flex: 1 },
    value
      ? [el('span', { padding: '2px 14px', marginLeft: -14, borderRadius: 12, ...current }, [value.san])]
      : [],
  );
}

function moveRow(row: SnapshotRow): El {
  return el('div', { display: 'flex', opacity: row.faded ? 0.25 : 1 }, [
    el('span', { width: 90, flexShrink: 0, color: '#9a9a8e' }, [`${row.number}.`]),
    cell(row.white),
    cell(row.black),
  ]);
}

/** §1.2, top to bottom: pill, players, divider, moves, footer. */
function panel(model: SnapshotModel): El {
  return el(
    'div',
    { display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, padding: '44px 56px', gap: 26 },
    [
      pill(model.pill),
      el('div', { display: 'flex', flexDirection: 'column', gap: 22 }, model.players.map(playerRow)),
      el('div', { height: 3, background: '#e2dcc6', flexShrink: 0 }),
      el(
        'div',
        {
          display: 'flex',
          flexDirection: 'column',
          flex: 1,
          minHeight: 0,
          overflow: 'hidden',
          gap: 10,
          fontSize: 36,
          lineHeight: 1.15,
        },
        model.rows.map(moveRow),
      ),
      el('div', { display: 'flex', flexDirection: 'column', gap: 10, flexShrink: 0 }, [
        el('span', { fontSize: 40, fontWeight: 700, color: GREEN, ...ONE_LINE }, [model.status]),
        el('span', { fontSize: 32, color: MUTED, ...ONE_LINE }, [model.group]),
        el('span', { fontSize: 32, color: MUTED, ...ONE_LINE }, [model.terms]),
      ]),
    ],
  );
}

/** Satori lays the card out and turns its text into paths, so resvg needs no fonts (§1.3). */
export async function renderSnapshotSvg(
  model: SnapshotModel,
  fonts: SnapshotFonts,
): Promise<string> {
  const card = el(
    'div',
    {
      display: 'flex',
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
      background: PAGE,
      color: INK,
      fontFamily: 'Noto Sans',
    },
    [board(model), panel(model)],
  );
  return satori(card as unknown as Parameters<typeof satori>[0], {
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    fonts,
  });
}

export function renderSnapshotPng(svg: string): Buffer {
  return new Resvg(svg, { fitTo: { mode: 'width', value: CARD_WIDTH } }).render().asPng();
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @group-chess/server exec vitest run test/unit/snapshot.test.ts`
Expected: PASS. If Satori throws about an element's `display`, the element with more than one child
is missing `display: 'flex'`; add it there. Do not wrap text in extra elements.

- [ ] **Step 5: Write the sample script**

Create `apps/server/test/visual/render-samples.ts`:

```ts
// Snapshot spec §6 "By eye": writes sample cards to compare with the Claude Design prototype.
// Usage: pnpm --filter @group-chess/server exec tsx test/visual/render-samples.ts <out-dir>
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Chess } from 'chess.js';
import type { BoardRenderInput } from '../../src/images/board';
import { loadFonts } from '../../src/images/fonts';
import { renderSnapshotPng, renderSnapshotSvg } from '../../src/images/snapshot';
import { buildSnapshotModel, type SnapshotInput } from '../../src/images/snapshotModel';
import { SHARED_AT, snapshotInput } from '../helpers/snapshotFixtures';

/** Kasparov–Topalov, Wijk aan Zee 1999, through 30…Qc4 (the design's long-game example). */
const KASPAROV_TOPALOV =
  'e4 d6 d4 Nf6 Nc3 g6 Be3 Bg7 Qd2 c6 f3 b5 Nge2 Nbd7 Bh6 Bxh6 Qxh6 Bb7 a3 e5 O-O-O Qe7 Kb1 a6 Nc1 O-O-O Nb3 exd4 Rxd4 c5 Rd1 Nb6 g3 Kb8 Na5 Ba8 Bh3 d5 Qf4+ Ka7 Rhe1 d4 Nd5 Nbxd5 exd5 Qd6 Rxd4 cxd4 Re7+ Kb6 Qxd4+ Kxa5 b4+ Ka4 Qc3 Qxd5 Ra7 Bb7 Rxb7 Qc4'.split(' ');

/** The position after playing `sans` from the start, as the share job would build it. */
function replay(sans: string[], orientation: 'white' | 'black' = 'white'): BoardRenderInput {
  const chess = new Chess();
  for (const san of sans) chess.move(san);
  const last = chess.history({ verbose: true }).at(-1);
  return {
    fen: chess.fen(),
    lastMove: last ? `${last.from}${last.to}` : null,
    check: chess.inCheck(),
    orientation,
  };
}

const samples: Record<string, Partial<SnapshotInput>> = {
  opening: {
    ply: 1,
    plyCount: 1,
    sans: ['e4'],
    board: replay(['e4']),
    deadlineAt: new Date(SHARED_AT.getTime() + (14 * 60 + 32) * 60_000),
  },
  'long-game': {
    ply: 60,
    plyCount: 60,
    sans: KASPAROV_TOPALOV,
    board: replay(KASPAROV_TOPALOV),
  },
  finished: {
    ply: 60,
    plyCount: 60,
    sans: KASPAROV_TOPALOV,
    board: replay(KASPAROV_TOPALOV),
    status: 'finished',
    result: '1-0',
    endReason: 'resignation',
    deadlineAt: null,
  },
  'cjk-emoji': {
    white: { name: '李小龍', rating: { rating: 1500, rd: 300 }, engineLevel: null },
    black: { name: 'さくら 🐐', rating: null, engineLevel: null },
    groupTitle: '♞ 김민수의 체스 클럽 🔥🔥🔥 and a very long title that must end in an ellipsis',
  },
  'black-bot': {
    board: replay(['e4'], 'black'),
    ply: 1,
    plyCount: 1,
    sans: ['e4'],
    timePerMove: null,
    rated: false,
    deadlineAt: null,
    white: { name: 'Chess Goat', rating: null, engineLevel: 'club' },
  },
};

const out = process.argv[2];
if (!out) throw new Error('usage: render-samples.ts <out-dir>');
await mkdir(out, { recursive: true });
const fonts = await loadFonts();
for (const [name, overrides] of Object.entries(samples)) {
  const svg = await renderSnapshotSvg(buildSnapshotModel(snapshotInput(overrides)), fonts);
  await writeFile(join(out, `${name}.png`), renderSnapshotPng(svg));
  console.log(join(out, `${name}.png`));
}
```

- [ ] **Step 6: Render the samples and check them by eye**

Run: `pnpm --filter @group-chess/server exec tsx test/visual/render-samples.ts "$TMPDIR/snapshot-samples"`
Expected: five PNG paths printed. Open each (the Read tool shows images) and check against spec §1:

- green board with the gold last-move squares; file letters bottom-right of the bottom row, rank
  digits top-left of the left column, each in the opposite square colour; `black-bot` has h→a
  along the bottom and 1 at the top;
- dark pill `📷 SNAPSHOT · MOVE N` top-left of the panel;
- two player rows (the top of the board first), white dot ringed, ratings grey, `Club` for the bot;
- `long-game` shows moves 23–30 with row 23 faded and `Qc4` highlighted green;
- green status line, grey group and terms; the `cjk-emoji` title ends in `…`.

Fix any layout difference in `snapshot.ts` and re-run until the samples match. Record anything
that cannot be matched in the task report.

- [ ] **Step 7: Typecheck, lint, format, commit**

Run: `pnpm format && pnpm typecheck && pnpm lint`
Expected: all pass.

```bash
git add apps/server/src/images/snapshot.ts apps/server/test/unit/snapshot.test.ts apps/server/test/visual/render-samples.ts
git commit -m "Render the snapshot card with Satori and resvg

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Send the snapshot from the share job

**Files:**
- Modify: `apps/server/src/jobs/handlers/sharePhoto.ts`, `apps/server/src/images/cache.ts`,
  `apps/server/src/images/board.ts`, `apps/server/src/telegram/cards.ts`,
  `apps/server/src/main.ts`, `packages/shared/src/i18n/en.ts`,
  `apps/server/test/integration/share-photo.test.ts`, `apps/server/test/unit/cards.test.ts`,
  `apps/server/test/unit/board.test.ts`, `apps/server/test/unit/snapshot.test.ts`

**Interfaces:**
- Consumes: `buildSnapshotModel`, `shareMoveNumber` (Task 4); `renderSnapshotSvg`,
  `renderSnapshotPng` (Task 5); `loadFonts`, `SnapshotFonts` (Task 2); `getPlayerRating(tx, groupId, userId)`
  from `domain/ratings.ts` (returns `{ rating, rd } | null`).
- Produces: `sharePhotoJobHandlers(ctx: TelegramHandlerContext, fonts: SnapshotFonts): JobHandlers`,
  `snapshotImageKey(svg: string): string`,
  `renderShareCaption(view: { sharer: string; moveNumber: number; white: string; black: string }): string`.
  Removes `boardImageKey`, `BOARD_THEME` and `renderBoardPng`.

- [ ] **Step 1: Update the copy tests first**

In `apps/server/test/unit/cards.test.ts`, in `renders the share caption`, remove the `sideToMove`
field from the `renderShareCaption` argument and change the expectation to
`'Carol shared move 23 of Alice vs Bob'`.

In `apps/server/test/unit/snapshot.test.ts`, add `import { snapshotImageKey } from '../../src/images/cache';`
and:

```ts
describe('snapshotImageKey', () => {
  it('is the sha256 of the card, so identical cards share a key', async () => {
    const svg = await render();
    expect(snapshotImageKey(svg)).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshotImageKey(svg)).toBe(snapshotImageKey(await render()));
    expect(snapshotImageKey(svg)).not.toBe(snapshotImageKey(await render({ rated: false })));
  });
});
```

In `apps/server/test/unit/board.test.ts`, delete the `renderBoardPng` and `boardImageKey` describe
blocks and remove `renderBoardPng` and the `boardImageKey` import.

- [ ] **Step 2: Update the integration tests**

In `apps/server/test/integration/share-photo.test.ts`:

Imports: add `import { eq } from 'drizzle-orm';` (keep `sql`), add `games` to the schema import, and
add `import { loadFonts } from '../../src/images/fonts';`.

In `beforeAll`, load the fonts and pass them:

```ts
  const fonts = await loadFonts();
  worker = new JobWorker({
    db,
    log: deps.log,
    handlers: sharePhotoJobHandlers({ deps, api, config }, fonts),
    workerId: 's',
  });
```

Let `share()` take the moment of sharing:

```ts
async function share(gameId: number, userId: number, ply: number, createdAt?: Date) {
  const [row] = await db
    .insert(shares)
    .values({ gameId, userId, ply, ...(createdAt ? { createdAt } : {}) })
    .returning();
  await enqueue(db, { kind: 'send_share_photo', payload: { shareId: row!.id } });
  return row!;
}
```

In the first test change the caption and button expectations to:

```ts
    expect(call?.body.caption).toBe('Alice shared move 1 of Alice vs Bob');
```

```ts
    expect(markup.inline_keyboard[0]?.[0]).toEqual({
      text: '♟ Open live game',
      url: `https://t.me/TestChessBot/chess?startapp=g_${game.publicId}`,
    });
```

Replace `reuses the cached file id for the same position` with these two tests:

```ts
  it('reuses the cached file id for an identical card', async () => {
    const { alice, carol, game } = await table();
    await db
      .update(games)
      .set({ status: 'finished', result: '1-0', endReason: 'resignation', deadlineAt: null })
      .where(eq(games.id, game.id));
    await share(game.id, alice.id, 2);
    await worker.runOnce();
    await share(game.id, carol.id, 2);
    await worker.runOnce();
    const calls = fake.callsTo('sendPhoto');
    expect(calls).toHaveLength(2);
    expect(calls[1]?.multipart).toBe(false);
    expect(calls[1]?.body.photo).toBe('AgACAgIAAxkFake');
    expect(calls[1]?.body.caption).toBe('Carol shared move 1 of Alice vs Bob');
    expect(await db.select().from(boardImages)).toHaveLength(1);
    expect((await db.select().from(shares)).map((row) => row.messageId)).toEqual([101, 102]);
  });

  it('uploads a new card when the time left has changed', async () => {
    const { carol, game } = await table();
    await share(game.id, carol.id, 2, new Date(Date.now() - 2 * 3_600_000));
    await worker.runOnce();
    await share(game.id, carol.id, 2);
    await worker.runOnce();
    expect(fake.callsTo('sendPhoto').map((call) => call.multipart)).toEqual([true, true]);
    expect(await db.select().from(boardImages)).toHaveLength(2);
  });
```

In `shares the initial position and an earlier ply`, expect:

```ts
    expect(captions).toEqual([
      'Carol shared move 1 of Alice vs Bob',
      'Carol shared move 1 of Alice vs Bob',
    ]);
```

- [ ] **Step 3: Run the tests to verify they fail**

Run (with your own `TEST_DATABASE_URL`, see Global Constraints):
`pnpm --filter @group-chess/server exec vitest run test/unit/cards.test.ts test/unit/snapshot.test.ts test/integration/share-photo.test.ts`
Expected: FAIL (old caption and button, `snapshotImageKey` missing, `sharePhotoJobHandlers` ignoring fonts).

- [ ] **Step 4: Change the copy and the caption**

In `packages/shared/src/i18n/en.ts`:

```ts
  'card.share.caption': '{sharer} shared move {moveNumber} of {white} vs {black}',
```

and after `'button.open_game'`:

```ts
  'button.open_live_game': '♟ Open live game',
```

In `apps/server/src/telegram/cards.ts`, replace `renderShareCaption`:

```ts
export function renderShareCaption(view: {
  sharer: string;
  moveNumber: number;
  white: string;
  black: string;
}): string {
  return t('card.share.caption', view);
}
```

If `Colour` is no longer used in `cards.ts`, remove it from the import.

- [ ] **Step 5: Key the cache on the card**

Replace `apps/server/src/images/cache.ts`'s key function and imports:

```ts
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { boardImages } from '../db/schema';

/**
 * Snapshot spec §3.3: identical cards share a Telegram file id, and anything the card shows (the
 * theme included) changes the key. Rows keyed the old per-position way are simply never hit again.
 */
export function snapshotImageKey(svg: string): string {
  return createHash('sha256').update(svg).digest('hex');
}
```

(`getCachedFileId` and `storeFileId` stay as they are.)

In `apps/server/src/images/board.ts`, delete `BOARD_THEME`, `renderBoardPng` and the `Resvg` import.

- [ ] **Step 6: Build the snapshot in the job**

Replace the body of `apps/server/src/jobs/handlers/sharePhoto.ts` from the imports down to
`sharePhotoJobHandlers` (keep `positionAtPly` as it is):

```ts
import { INITIAL_FEN, t, type TimePerMove } from '@group-chess/shared';
import { Chess } from 'chess.js';
import { eq } from 'drizzle-orm';
import { InputFile } from 'grammy';
import { z } from 'zod';
import { shares, type GameRow, type MoveRow, type UserRow } from '../../db/schema';
import { listMoves, requireGameById } from '../../domain/games';
import { requireGroup } from '../../domain/groups';
import { getPlayerRating } from '../../domain/ratings';
import { displayName, requireUser } from '../../domain/users';
import { getCachedFileId, snapshotImageKey, storeFileId } from '../../images/cache';
import type { SnapshotFonts } from '../../images/fonts';
import { renderSnapshotPng, renderSnapshotSvg } from '../../images/snapshot';
import {
  buildSnapshotModel,
  shareMoveNumber,
  type SnapshotSide,
} from '../../images/snapshotModel';
import { renderShareCaption } from '../../telegram/cards';
import { miniAppLink } from '../../telegram/links';
import type { JobHandler, JobHandlers } from '../types';
import { call, settle, type TelegramHandlerContext } from './telegram';
```

```ts
async function side(
  ctx: TelegramHandlerContext,
  game: GameRow,
  user: UserRow,
): Promise<SnapshotSide> {
  return {
    name: displayName(user),
    rating: await getPlayerRating(ctx.deps.db, game.groupId, user.id),
    engineLevel: user.isEngine ? game.engineLevel : null,
  };
}

/** Snapshot spec §3.1: build the card, reuse or upload it, and post it to the game's topic. */
const sendSharePhoto =
  (ctx: TelegramHandlerContext, fonts: SnapshotFonts): JobHandler =>
  async ({ job }) => {
    const { shareId } = payloadSchema.parse(job.payload);
    const [share] = await ctx.deps.db.select().from(shares).where(eq(shares.id, shareId));
    if (!share || share.messageId !== null) return { outcome: 'done' };
    const game = await requireGameById(ctx.deps.db, share.gameId);
    const group = await requireGroup(ctx.deps.db, game.groupId);
    if (group.botStatus === 'left') return { outcome: 'done' };
    const [sharer, white, black, moves] = await Promise.all([
      requireUser(ctx.deps.db, share.userId),
      requireUser(ctx.deps.db, game.whiteId),
      requireUser(ctx.deps.db, game.blackId),
      listMoves(ctx.deps.db, game.id),
    ]);
    const position = positionAtPly(moves, share.ply);
    const model = buildSnapshotModel({
      ply: share.ply,
      sans: moves.filter((move) => move.ply <= share.ply).map((move) => move.san),
      board: {
        ...position,
        check: new Chess(position.fen).inCheck(),
        orientation: share.userId === game.blackId ? 'black' : 'white',
      },
      white: await side(ctx, game, white),
      black: await side(ctx, game, black),
      groupTitle: group.title,
      timePerMove: game.timePerMove as TimePerMove,
      rated: game.rated,
      status: game.status,
      result: game.result,
      endReason: game.endReason,
      plyCount: game.plyCount,
      deadlineAt: game.deadlineAt,
      sharedAt: share.createdAt,
    });
    const svg = await renderSnapshotSvg(model, fonts);
    const key = snapshotImageKey(svg);
    const cached = await getCachedFileId(ctx.deps.db, key);
    const caption = renderShareCaption({
      sharer: displayName(sharer),
      moveNumber: shareMoveNumber(share.ply),
      white: displayName(white),
      black: displayName(black),
    });
    const photo = cached ?? new InputFile(renderSnapshotPng(svg), 'snapshot.png');
    const result = await call(ctx, group.telegramChatId, () =>
      ctx.api.sendPhoto(group.telegramChatId, photo, {
        caption,
        message_thread_id: game.cardThreadId ?? undefined,
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: t('button.open_live_game'),
                url: miniAppLink(ctx.config, { kind: 'game', gameId: game.publicId }),
              },
            ],
          ],
        },
      }),
    );
    if (!result.ok) return settle(result);
    const largest = result.value.photo.at(-1);
    if (!cached && largest) await storeFileId(ctx.deps.db, key, largest.file_id);
    await ctx.deps.db
      .update(shares)
      .set({ messageId: result.value.message_id })
      .where(eq(shares.id, share.id));
    return { outcome: 'done' };
  };

export function sharePhotoJobHandlers(
  ctx: TelegramHandlerContext,
  fonts: SnapshotFonts,
): JobHandlers {
  return { send_share_photo: sendSharePhoto(ctx, fonts) };
}
```

Keep `payloadSchema` and `positionAtPly` (with `INITIAL_FEN` and `MoveRow`) unchanged. Remove
imports that are now unused (`sideToMove`, `Colour`, `BoardRenderInput`, `renderBoardPng`,
`renderBoardSvg`, `boardImageKey`).

- [ ] **Step 7: Load the fonts at boot**

In `apps/server/src/main.ts`, add `import { loadFonts } from './images/fonts';`, and in the
`if (has('jobs'))` block, before `worker = new JobWorker(`:

```ts
    // Snapshot spec §2.3: a missing font stops the boot here, not the first share.
    const fonts = await loadFonts();
```

and change the handler line to `...sharePhotoJobHandlers({ deps, api, config }, fonts),`.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm --filter @group-chess/server exec vitest run test/unit/cards.test.ts test/unit/snapshot.test.ts test/unit/board.test.ts test/integration/share-photo.test.ts`
Expected: PASS.

- [ ] **Step 9: Run the whole suite**

Run: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`
Expected: all pass. `grep -rn "boardImageKey\|renderBoardPng\|BOARD_THEME" apps packages` prints nothing.

- [ ] **Step 10: Commit**

```bash
git add -A apps/server packages/shared
git commit -m "Share positions as snapshot cards with Open live game

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Fonts in the Docker image, and the documents

**Files:**
- Modify: `Dockerfile`, `docs/superpowers/specs/2026-09-20-group-chess-technical-design.md` (§7.7),
  `docs/PRD.md`, `docs/running.md`, `docs/testing.md`

**Interfaces:**
- Consumes: `scripts/fetch-fonts.mjs` (Task 1), `loadFonts` (Task 2) at boot (Task 6).
- Produces: a runtime image with `/app/apps/server/fonts/` populated.

- [ ] **Step 1: Add the fonts stage**

In `Dockerfile`, after the `build` stage and before `FROM base AS runtime`, add:

```dockerfile
# Snapshot spec §2.2: the card's fonts are downloaded by pinned URL and sha256, never committed.
FROM base AS fonts
COPY scripts/fetch-fonts.mjs ./scripts/
RUN node scripts/fetch-fonts.mjs
```

In the runtime stage, directly after `COPY apps/server ./apps/server`, add:

```dockerfile
COPY --from=fonts /app/apps/server/fonts/ ./apps/server/fonts/
```

(It comes before the `pnpm install … && chown -R node:node /app` step, so the files are owned by
`node` like the rest.)

- [ ] **Step 2: Build the image and prove the fonts load inside it**

Docker Desktop must be running (`docker context use desktop-linux`; never OrbStack).

Run:

```bash
docker build -t group-chess:snapshot .
docker run --rm --entrypoint node group-chess:snapshot --import tsx --input-type=module -e "const { loadFonts } = await import('./src/images/fonts.ts'); console.log((await loadFonts()).length)"
```

Expected: the build succeeds, including the `fonts` stage, and the run prints `6`. The CI `docker`
job in `e2e.yml` then covers booting with `ROLES=api,jobs,clock`.

- [ ] **Step 3: Update the technical design §7.7**

Replace the body of `### 7.7 Position images` in
`docs/superpowers/specs/2026-09-20-group-chess-technical-design.md` with:

```markdown
Superseded in detail by the [share-position snapshot design](./2026-09-24-share-position-snapshot-design.md).
A shared position is a 1664 × 1024 card: the board (`renderBoardSvg`, green squares, last-move and
check highlights, cburnett glyphs under CC BY-SA 3.0) on the left, and a panel with a
`Snapshot · Move n` label, the players and ratings, the last eight move rows, the status at the
moment of sharing, the group and its terms. Satori lays the card out with bundled Noto fonts (SIL
OFL 1.1, fetched at build time by `scripts/fetch-fonts.mjs` with pinned checksums) and converts the
text to paths; `@resvg/resvg-js` rasterises it.

Cache: `board_images(key, telegram_file_id)` with `key = sha256(card SVG)`. On a hit the share job
calls `sendPhoto` with the `file_id` and no upload; on a miss it uploads and stores the returned
`file_id`. The image has White at the bottom when a spectator shares and the sharer's own colour at
the bottom when a player shares.
```

- [ ] **Step 4: Update the PRD**

In `docs/PRD.md`:

- Line 169 (`| Shared position | …`), third column becomes:
  `Snapshot card of that position (board, players, recent moves, where the game stood), caption "Alice shared move 23 of Alice vs Bob", **♟ Open live game** button. Group members reply in the chat as usual`
- The example under `Shared position:` becomes:

```
[ snapshot card ]
Carol shared move 23 of Alice vs Bob
[ ♟ Open live game ]
```

- Line 308 (`| Shared position image | …`), last column becomes `Static image, no keyboard except Open live game.`

- [ ] **Step 5: Update the running and testing docs**

In `docs/running.md` section `## 1. Database and dependencies`, directly after the `pnpm install`
line in its code block, add a line `pnpm fonts`, and below the block add:
`` `pnpm fonts` downloads the shared-position card's fonts (about 20 MB) into `apps/server/fonts/`. The server will not start its job worker without them. ``

In `docs/testing.md`, after the paragraph beginning `` `pnpm test` is ``, add:
`` The server's test setup downloads the snapshot card's fonts on first run (`scripts/fetch-fonts.mjs`, checksummed), so the first `pnpm test` on a fresh clone needs network access. ``

- [ ] **Step 6: Final verification**

Run: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build && pnpm check:licences`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add Dockerfile docs/superpowers/specs/2026-09-20-group-chess-technical-design.md docs/PRD.md docs/running.md docs/testing.md
git commit -m "Ship the snapshot fonts in the image and document the new shared position

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
