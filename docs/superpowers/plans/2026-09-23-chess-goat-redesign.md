# Chess Goat Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Mini App the Chess Goat identity and the Claude Design prototype's look on every screen, add the summary fields its game thumbnails need, and add a group Leaderboard page.

**Architecture:** Restyle in place. The router, state stores, API client and chessground board stay; `tg/theme.ts` adds a fixed accent set over Telegram's neutrals; a handful of shared Preact components (`Avatar`, `MiniBoard`, `GameCard`, `Tiles`, …) replace the plain rows; the server adds four additive fields to existing DTOs. One PR.

**Tech Stack:** Preact 10 + @preact/signals, chessground 9, Vite 8, Vitest 5 (happy-dom), Playwright; Hono + Drizzle on PostgreSQL 18; zod 4 in `packages/shared`.

**Spec:** `docs/superpowers/specs/2026-09-22-chess-goat-redesign-design.md` (read it before starting; section numbers below refer to it). The visual source is the Claude Design project "Mini app design improvement", file `Chess Goat Prototype.dc.html`; a copy is at `<scratchpad>/design/prototype.html` if this session made one, otherwise read it with `DesignSync get_file` (project `3b3dbe3e-c8f0-4b85-bb6b-d60f82accac2`).

## Global Constraints

- One PR from branch `claude/chess-goat-prototype-33a338`. Never commit to `main`.
- Node ≥ 22.12, pnpm 10. Run `pnpm install` once before Task 1 (the worktree has no `node_modules`).
- Integration tests on this machine: `export TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/group_chess_test` (the `docker compose up db` instance; start Docker **Desktop** with `open -a Docker`, never OrbStack). The passwordless URL in the README fails here.
- Copy lives only in `packages/shared/src/i18n/en.ts`; screens call `t(...)`. No literal user-facing English in `.tsx` files except the brand constants in `apps/miniapp/src/brand.ts`.
- Every existing `data-*` hook keeps its name and meaning: `data-game`, `data-group`, `data-accept`, `data-decline`, `data-cancel`, `data-player`, `data-action`, `data-pref`, `data-ply`, `data-nav`, `data-badge`, `data-dialog`, `data-opponent`, `data-testid="opponent-bot"`, `data-testid="bot-level-*"`, `data-time`, `data-colour`, `data-rated`, `data-setting`, `data-topic`, `data-block`, `data-unblock`, `data-void`, `data-promote`, `data-colour` on `.player-bar`.
- Screen headings keep the `.title` class (the e2e suite reads it).
- Accent values are exactly the spec §1 table. Avatar palette, in order: `#e17076`, `#faa774`, `#a695e7`, `#7bc862`, `#6ec9cb`, `#65aadd`, `#ee7aae`.
- Telegram features are version-gated through `FEATURE_MIN_VERSION`: `headerColor` 6.1, `popup` 6.2, `closingConfirmation` 6.2, `settingsButton` 7.0, `bottomBarColor` 7.10. Below its version a feature is a no-op or returns the "unsupported" value so the caller falls back.
- No new npm dependencies. The font is a vendored file.
- Budgets: built JS ≤ 120 KB gzipped, CSS ≤ 25 KB gzipped (`pnpm build && pnpm check:budget`).
- Before each commit: `pnpm exec prettier --write` on the files you touched, then `pnpm lint` and `pnpm typecheck` must pass. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Run a single Mini App test file with `pnpm --filter @group-chess/miniapp exec vitest run test/<file>`; shared with `pnpm --filter @group-chess/shared exec vitest run test/<path>`; server with `pnpm --filter @group-chess/server exec vitest run test/<path>`.

## Review Focus

1. **Names that start with an emoji or are only "@"** (Telegram first names can be anything): the avatar shows the whole emoji, never half a surrogate pair, and "?" for an empty name. Test: Task 5, `personInitial('🦄 Unicorn')` and `personInitial('@')`.
2. **User ids beyond 2^53** (ids travel as decimal strings up to 19 digits): the avatar colour is stable and in the palette. Test: Task 5, `avatarColour('9223372036854775807')`.
3. **A deadline that has already passed** while the list is open (the clock scanner has not ended the game yet): the pill reads "Your move · 0:00 left", urgent, never a negative time. Test: Task 6, `pillFor` with a past deadline.
4. **Telegram switching light↔dark mid-session**: the accents, the header colours and the MainButton colour follow without a reload. Test: Task 2, `themeChanged` with a flipped `colorScheme`.
5. **A very long group title or display name at 390 px**: every screen ellipsises or wraps; nothing scrolls sideways. Test: Task 13, the screens spec seeds a 70-character group title and asserts `scrollWidth <= clientWidth` on Games, Groups, Lobby and Leaderboard.

---

### Task 1: Data contract: thumbnail fields and the bot flag

**Files:**
- Modify: `packages/shared/src/protocol/dto.ts` (`PlayerRefSchema`, `GameSummarySchema`)
- Modify: `packages/shared/test/protocol/dto.test.ts`
- Modify: `apps/server/src/domain/players.ts`
- Modify: `apps/server/src/domain/summaries.ts`
- Modify: `apps/server/test/integration/api-auth.test.ts`, `apps/server/test/integration/api-games.test.ts`
- Create: `apps/miniapp/test/support/summaryFixtures.ts`
- Modify: `apps/miniapp/test/support/gameFixtures.ts`, `apps/miniapp/test/games.test.tsx`, `apps/miniapp/test/lobby.test.tsx`, `apps/miniapp/test/newGame.test.tsx`, `apps/miniapp/test/groupSettings.test.tsx`, `apps/miniapp/test/stream.test.ts`, `apps/miniapp/test/board.test.ts`, `apps/miniapp/test/yourMove.test.ts`

**Interfaces:**
- Produces: `PlayerRef.isBot: boolean`; `GameSummary.fen: string`, `GameSummary.lastMove: Uci | null`, `GameSummary.engineLevel: EngineLevel | null` (and therefore on `MeGameSummary`, `LeaderboardEntry`, `ChallengeDto.challenger/opponent`, `GamePlayer`).
- Produces (tests): `playerRef(id, name, overrides?)` and `gameSummary(overrides?)` in `apps/miniapp/test/support/summaryFixtures.ts`.

- [ ] **Step 1: Install and confirm the baseline**

```bash
pnpm install
export TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/group_chess_test
pnpm test
```
Expected: all tests pass (≈517 in 59 files). If the database is down: `open -a Docker`, wait for `docker info`, `docker compose up -d db`.

- [ ] **Step 2: Write the failing schema tests**

In `packages/shared/test/protocol/dto.test.ts`, add `isBot: false,` after `provisional: false,` in `activeGame.white` and after `provisional: true,` in `activeGame.black`, and `isBot: false,` after `provisional: true,` in the `LeaderboardEntrySchema` test entry. Add `GameSummarySchema` and `PlayerRefSchema` to the import from `'../../src/protocol/dto'`, then append:

```ts
const summary = {
  id: 'aZ09bY18cX',
  white: { id: '1', name: 'Alice', username: 'alice', rating: 1520, provisional: false, isBot: false },
  black: { id: '2', name: 'Stockfish', username: null, rating: 1500, provisional: true, isBot: true },
  status: 'active',
  timePerMove: null,
  rated: false,
  plyCount: 1,
  sideToMove: 'black',
  yourTurn: false,
  deadlineAt: null,
  lastMoveAt: '2026-09-20T10:00:00.000Z',
  startedAt: '2026-09-20T09:00:00.000Z',
  finishedAt: null,
  result: null,
  endReason: null,
  voided: false,
  fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
  lastMove: 'e2e4',
  engineLevel: 'club',
};

describe('GameSummarySchema', () => {
  it('carries the position, the last move and the bot level for the list thumbnails', () => {
    expect(GameSummarySchema.parse(summary)).toEqual(summary);
  });

  it('allows a game with no moves yet', () => {
    expect(GameSummarySchema.safeParse({ ...summary, lastMove: null }).success).toBe(true);
  });

  it('rejects a malformed last move', () => {
    expect(GameSummarySchema.safeParse({ ...summary, lastMove: 'e2e9' }).success).toBe(false);
  });
});

describe('PlayerRefSchema', () => {
  it('requires the bot flag', () => {
    const withoutFlag: Record<string, unknown> = { ...summary.white };
    delete withoutFlag.isBot;
    expect(PlayerRefSchema.safeParse(withoutFlag).success).toBe(false);
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm --filter @group-chess/shared exec vitest run test/protocol/dto.test.ts`
Expected: FAIL: `GameSummarySchema.parse(summary)` strips `fen`/`lastMove`/`engineLevel` so `toEqual` fails, and the `PlayerRefSchema` case passes parsing when it should not.

- [ ] **Step 4: Add the fields to the schemas**

In `packages/shared/src/protocol/dto.ts`, extend `PlayerRefSchema` (after `provisional`):

```ts
  provisional: z.boolean(),
  /** The bot opponent: drawn as the Chess Goat mark, with its level instead of a rating. */
  isBot: z.boolean(),
```

and extend `GameSummarySchema` (after `voided`):

```ts
  voided: z.boolean(),
  /** The current position, drawn as the row's thumbnail. */
  fen: z.string().min(1),
  /** The last move played, tinted on the thumbnail; null before the first move. */
  lastMove: UciSchema.nullable(),
  /** The bot level when this is a game against the bot, otherwise null (mirrors `GameDto`). */
  engineLevel: EngineLevelSchema.nullable(),
```

- [ ] **Step 5: Run the shared tests**

Run: `pnpm --filter @group-chess/shared exec vitest run`
Expected: PASS.

- [ ] **Step 6: Write the failing server tests**

In `apps/server/test/integration/api-auth.test.ts`, add `insertMove` to the fixtures import and, inside `describe('GET /api/me/games', …)`, add:

```ts
  it('carries each game’s position, last move and bot flag for the list thumbnails', async () => {
    const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    const viewer = await insertUser(db);
    const [engine] = await db.select().from(users).where(eq(users.isEngine, true));
    const club = await insertGroup(db, { title: 'Club' });
    await touchMember(db, club.id, viewer.id);
    const opened = await insertGame(db, club.id, viewer.id, engine!.id, {
      fen: AFTER_E4,
      plyCount: 1,
      engineLevel: 'club',
      timePerMove: null,
    });
    await insertMove(db, opened.id, 1, 'e2e4', 'e4', AFTER_E4);
    const fresh = await insertGame(db, club.id, engine!.id, viewer.id, {
      engineLevel: 'casual',
      timePerMove: null,
    });

    const token = await api.sessionFor(viewer);
    const res = await api.request('GET', '/api/me/games', { token });
    const body = MeGamesDtoSchema.parse(await res.json());
    const byId = new Map(body.items.map((game) => [game.id, game]));
    expect(byId.get(opened.publicId)).toMatchObject({
      fen: AFTER_E4,
      lastMove: 'e2e4',
      engineLevel: 'club',
      white: { isBot: false },
      black: { isBot: true },
    });
    expect(byId.get(fresh.publicId)).toMatchObject({
      lastMove: null,
      engineLevel: 'casual',
      white: { isBot: true },
      black: { isBot: false },
    });
  });
```

In `apps/server/test/integration/api-games.test.ts`, inside `describe('challenges and lobby', …)`, add:

```ts
  it('sends the thumbnail fields on the lobby and the player page too', async () => {
    const { group, alice, bob, tokens } = await world();
    const running = await insertGame(db, group.id, alice.id, bob.id, {
      fen: AFTER_E4,
      plyCount: 1,
    });
    await insertMove(db, running.id, 1, 'e2e4', 'e4', AFTER_E4);
    const done = await insertGame(db, group.id, bob.id, alice.id, {
      status: 'finished',
      result: '1-0',
      endReason: 'resignation',
      finishedAt: new Date(),
    });
    const lobby = LobbyDtoSchema.parse(
      await (
        await api.request('GET', `/api/groups/${group.publicId}`, { token: tokens.alice })
      ).json(),
    );
    expect(lobby.active[0]).toMatchObject({
      id: running.publicId,
      fen: AFTER_E4,
      lastMove: 'e2e4',
      engineLevel: null,
      white: { isBot: false },
    });
    expect(lobby.finished.items[0]).toMatchObject({ id: done.publicId, lastMove: null });
    const page = PlayerPageDtoSchema.parse(
      await (
        await api.request('GET', `/api/groups/${group.publicId}/players/${bob.id}`, {
          token: tokens.alice,
        })
      ).json(),
    );
    expect(page.player.isBot).toBe(false);
    expect(page.recentGames.map((game) => game.lastMove)).toContain('e2e4');
  });
```

- [ ] **Step 7: Run them to see them fail**

Run: `pnpm --filter @group-chess/server exec vitest run test/integration/api-auth.test.ts test/integration/api-games.test.ts`
Expected: FAIL in zod parsing (`isBot`, `fen`, `lastMove`, `engineLevel` missing), and `pnpm typecheck` reports `toPlayerRef`/`toGameSummary` missing properties.

- [ ] **Step 8: Fill the fields on the server**

`apps/server/src/domain/players.ts`:

```ts
/** The player shape the API sends everywhere; ratings default to 1500 provisional (spec §7.9). */
export function toPlayerRef(
  user: Pick<UserRow, 'id' | 'firstName' | 'username' | 'deletedAt' | 'isEngine'>,
  rating: Pick<RatingRow, 'rating' | 'rd'> | null,
): PlayerRef {
  return {
    id: String(user.id),
    name: displayName(user),
    username: user.deletedAt ? null : user.username,
    rating: Math.round(rating?.rating ?? GLICKO2.initialRating),
    provisional: isProvisional(rating?.rd ?? GLICKO2.initialRd),
    isBot: user.isEngine,
  };
}
```

`apps/server/src/domain/summaries.ts`: add `moves` to the schema import and `sql` to the `drizzle-orm` import, then:

```ts
export type GameSummaryRow = {
  game: GameRow;
  white: UserRow;
  black: UserRow;
  whiteRating: RatingRow | null;
  blackRating: RatingRow | null;
  /** UCI of the move at `ply_count`, or null before the first move. */
  lastMove: string | null;
};

/** Games with both players, their current ratings and the last move in one query. */
export async function gameSummaryRows(
  tx: DbOrTx,
  where: SQL | undefined,
  orderBy: SQL[],
  limit: number,
): Promise<GameSummaryRow[]> {
  return tx
    .select({
      game: games,
      white: whiteUser,
      black: blackUser,
      whiteRating,
      blackRating,
      // A primary-key lookup on moves (game_id, ply) per row, for the list thumbnails.
      lastMove: sql<string | null>`(select ${moves.uci} from ${moves} where ${moves.gameId} = ${games.id} and ${moves.ply} = ${games.plyCount})`,
    })
    .from(games)
    // …the joins, where, orderBy and limit stay exactly as they are
```

and in `toGameSummary`, after `voided: game.voidedAt !== null,`:

```ts
    fen: game.fen,
    lastMove: row.lastMove,
    engineLevel: game.engineLevel ?? null,
```

- [ ] **Step 9: Run the server tests**

Run: `pnpm --filter @group-chess/server exec vitest run`
Expected: PASS. If `lastMove` comes back `null` for the running game, print the query with `.toSQL()` and check the subquery's column references are qualified (`"moves"."game_id" = "games"."id"`).

- [ ] **Step 10: Give the Mini App tests the new fields**

Create `apps/miniapp/test/support/summaryFixtures.ts`:

```ts
import { INITIAL_FEN, type GameSummary, type PlayerRef } from '@group-chess/shared';

export function playerRef(id: string, name: string, overrides: Partial<PlayerRef> = {}): PlayerRef {
  return { id, name, username: null, rating: 1500, provisional: true, isBot: false, ...overrides };
}

/** An active game between Alice (id 1, white, the session user) and Bob (id 2), Alice to move. */
export function gameSummary(overrides: Partial<GameSummary> = {}): GameSummary {
  return {
    id: 'GameAaaaaa',
    white: playerRef('1', 'Alice'),
    black: playerRef('2', 'Bob'),
    status: 'active',
    timePerMove: 86400,
    rated: true,
    plyCount: 0,
    sideToMove: 'white',
    yourTurn: true,
    deadlineAt: null,
    lastMoveAt: null,
    startedAt: '2026-09-20T10:00:00.000Z',
    finishedAt: null,
    result: null,
    endReason: null,
    voided: false,
    fen: INITIAL_FEN,
    lastMove: null,
    engineLevel: null,
    ...overrides,
  };
}
```

Then:
- `test/games.test.tsx`: delete the local `ref` helper and replace `summary` with
  ```ts
  const summary = (id: string, group: string, yourTurn: boolean) => ({
    ...gameSummary({ id, plyCount: 3, sideToMove: 'black', yourTurn }),
    group: { id: group, title: group === 'GrOuPiDxYz' ? 'Chess Club' : 'Pub Team' },
  });
  ```
  importing `gameSummary` from `./support/summaryFixtures`.
- `test/lobby.test.tsx`: replace `ref` with `const ref = (id: string, name: string) => playerRef(id, name);` and `summary` with
  ```ts
  const summary = (id: string, yourTurn: boolean, status: 'active' | 'finished' = 'active') =>
    gameSummary({
      id,
      plyCount: 3,
      sideToMove: 'black',
      yourTurn,
      status,
      finishedAt: status === 'finished' ? '2026-09-20T12:00:00.000Z' : null,
      result: status === 'finished' ? '1-0' : null,
      endReason: status === 'finished' ? 'resignation' : null,
    });
  ```
- Add `isBot: false` after `provisional: …` in every PlayerRef literal of: `test/support/gameFixtures.ts:42`, `test/newGame.test.tsx:8,15,29`, `test/groupSettings.test.tsx:16,33`, `test/stream.test.ts:15,24`, `test/board.test.ts:81`, `test/yourMove.test.ts:13,14`.

- [ ] **Step 11: Run everything**

Run: `pnpm typecheck && pnpm test`
Expected: PASS (all packages).

- [ ] **Step 12: Commit**

```bash
git add packages/shared apps/server apps/miniapp/test
git commit -m "feat: send the thumbnail position, last move and bot flag with game summaries"
```

---

### Task 2: Accent tokens and Telegram chrome colours

**Files:**
- Modify: `apps/miniapp/src/tg/theme.ts`
- Modify: `apps/miniapp/src/tg/types.ts`, `apps/miniapp/src/tg/webapp.ts`
- Modify: `apps/miniapp/src/boot.ts`
- Modify: `apps/miniapp/test/support/fakeWebApp.ts`, `apps/miniapp/e2e/support.ts`
- Modify: `apps/miniapp/test/tg.test.ts`, `apps/miniapp/test/boot.test.ts`

**Interfaces:**
- Produces: `ACCENTS: Record<'light' | 'dark', Record<string, string>>` and `applyChrome(tg: Tg): void` in `tg/theme.ts`; `themeVariables()` now also returns `--page`, `--card` and every accent token.
- Produces: `Tg.setChromeColor(key: 'bg_color' | 'secondary_bg_color'): void`, `Tg.setMainButtonColors(color: string, textColor: string): void`; features `headerColor`, `bottomBarColor`.
- Produces (fake): `FakeButton.color`, `FakeButton.textColor`, `FakeWebAppRecord.chrome: { header?: string; background?: string; bottomBar?: string }`.

- [ ] **Step 1: Write the failing tests**

Append to the `themeVariables` describe in `test/tg.test.ts`:

```ts
  it('lays the Chess Goat accents over Telegram’s neutrals, per scheme', () => {
    const light = themeVariables({ bg_color: '#fafafa', secondary_bg_color: '#eeeeee' }, 'light');
    expect(light['--card']).toBe('#fafafa');
    expect(light['--page']).toBe('#eeeeee');
    expect(light['--acc']).toBe('#2e7d4f');
    expect(light['--move']).toBe('#e0b94a');
    expect(light['--bl']).toBe('#f0ead2');
    const dark = themeVariables({}, 'dark');
    expect(dark['--page']).toBe('#131b23');
    expect(dark['--card']).toBe('#18222d');
    expect(dark['--acc']).toBe('#4cbb7a');
    expect(dark['--acc-ink']).toBe('#06200f');
  });
```

Append to `describe('createTg', …)`:

```ts
  it('colours the header and background from 6.1 and the bottom bar from 7.10', () => {
    tgFor({ version: '6.0' }).setChromeColor('secondary_bg_color');
    expect(window.__tg!.chrome).toEqual({});
    tgFor({ version: '7.9' }).setChromeColor('secondary_bg_color');
    expect(window.__tg!.chrome).toEqual({
      header: 'secondary_bg_color',
      background: 'secondary_bg_color',
    });
    tgFor({ version: '7.10' }).setChromeColor('secondary_bg_color');
    expect(window.__tg!.chrome.bottomBar).toBe('secondary_bg_color');
  });

  it('paints the main button', () => {
    tgFor({ version: '8.0' }).setMainButtonColors('#2e7d4f', '#ffffff');
    expect(window.__tg!.mainButton).toMatchObject({ color: '#2e7d4f', textColor: '#ffffff' });
  });
```

In `test/boot.test.ts`, add `import { ACCENTS } from '../src/tg/theme';` and, in the first boot test after its existing expectations:

```ts
    expect(record.chrome).toEqual({
      header: 'secondary_bg_color',
      background: 'secondary_bg_color',
      bottomBar: 'secondary_bg_color',
    });
    expect(record.mainButton.color).toBe(ACCENTS.light['--acc']);
```

and a new test (Review Focus 4):

```ts
  it('follows Telegram from light to dark without a reload', async () => {
    const { tg, client, router, prefetched, record } = setup('8.0', undefined, () => ({
      status: 200,
      body: launchBody({ kind: 'home', games: { items: [] } }),
    }));
    await boot({ tg, client, router, prefetched });
    expect(document.documentElement.style.getPropertyValue('--acc')).toBe('#2e7d4f');
    (window.Telegram!.WebApp as { colorScheme: string }).colorScheme = 'dark';
    record.emit('themeChanged');
    expect(document.documentElement.style.getPropertyValue('--acc')).toBe('#4cbb7a');
    expect(record.mainButton.color).toBe('#4cbb7a');
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @group-chess/miniapp exec vitest run test/tg.test.ts test/boot.test.ts`
Expected: FAIL (`--card` undefined, `setChromeColor is not a function`, `record.chrome` undefined).

- [ ] **Step 3: Extend the fake WebApp**

In `test/support/fakeWebApp.ts`:
- `FakeButton` gains `color?: string; textColor?: string;`.
- `FakeWebAppRecord` gains `chrome: { header?: string; background?: string; bottomBar?: string };`; initialise `chrome: {}` in `record`.
- In `button(...)` add:
  ```ts
    setParams: (params: { color?: string; text_color?: string }) => {
      if (params.color) state.color = params.color;
      if (params.text_color) state.textColor = params.text_color;
      record.calls.push(`${name}.setParams`);
    },
  ```
- After the HapticFeedback block add:
  ```ts
  if (atLeast(options.version, '6.1')) {
    webApp.setHeaderColor = (color: string) => {
      record.chrome.header = color;
      record.calls.push(`setHeaderColor:${color}`);
    };
    webApp.setBackgroundColor = (color: string) => {
      record.chrome.background = color;
      record.calls.push(`setBackgroundColor:${color}`);
    };
  }
  if (atLeast(options.version, '7.10')) {
    webApp.setBottomBarColor = (color: string) => {
      record.chrome.bottomBar = color;
      record.calls.push(`setBottomBarColor:${color}`);
    };
  }
  ```
- In `e2e/support.ts` `tgState`, also return `chrome: record.chrome`.

- [ ] **Step 4: Add the wrapper methods**

`src/tg/types.ts`: in `TelegramButton` add `setParams?(params: { color?: string; text_color?: string }): void;`; in `TelegramWebApp` add

```ts
  setHeaderColor?(color: string): void;
  setBackgroundColor?(color: string): void;
  setBottomBarColor?(color: string): void;
```

`src/tg/webapp.ts`:

```ts
export type Feature =
  | 'haptics'
  | 'writeAccess'
  | 'verticalSwipes'
  | 'secondaryButton'
  | 'downloadFile'
  | 'headerColor'
  | 'bottomBarColor';

export const FEATURE_MIN_VERSION: Record<Feature, string> = {
  haptics: '6.1',
  writeAccess: '6.9',
  verticalSwipes: '7.7',
  secondaryButton: '7.10',
  downloadFile: '8.0',
  headerColor: '6.1',
  bottomBarColor: '7.10',
};
```

Add to the `Tg` interface:

```ts
  /** Header and background (6.1) and bottom bar (7.10) take this theme colour; a no-op below. */
  setChromeColor(key: 'bg_color' | 'secondary_bg_color'): void;
  /** Colours Telegram's MainButton; the client keeps the colours across show and hide. */
  setMainButtonColors(color: string, textColor: string): void;
```

In `nullTg()`: `setChromeColor: () => undefined, setMainButtonColors: () => undefined,`. In `createTg` return object:

```ts
    setChromeColor(key) {
      if (supports('headerColor')) {
        raw.setHeaderColor?.(key);
        raw.setBackgroundColor?.(key);
      }
      if (supports('bottomBarColor')) raw.setBottomBarColor?.(key);
    },
    setMainButtonColors: (color, textColor) =>
      raw.MainButton.setParams?.({ color, text_color: textColor }),
```

- [ ] **Step 5: Add the accent set and `applyChrome`**

`src/tg/theme.ts`, below `FALLBACK_THEME`:

```ts
/** The Chess Goat accents (redesign spec §1), fixed per scheme on top of Telegram's neutrals. */
export const ACCENTS = {
  light: {
    '--acc': '#2e7d4f',
    '--acc-ink': '#ffffff',
    '--acc-text': '#256b42',
    '--acc-soft': '#e3f1e7',
    '--move': '#e0b94a',
    '--move-ink': '#2a2000',
    '--move-soft': '#fbf3dc',
    '--move-text': '#8a6a00',
    '--urgent': '#d14e4e',
    '--hero-bg': 'linear-gradient(135deg, #236140, #153a26)',
    '--hero-ink': '#f5f0dc',
    '--hero-sub': '#bcd3c2',
    '--bl': '#f0ead2',
    '--bd': '#7d9f6b',
    '--lm': 'rgba(224, 185, 74, 0.6)',
    '--sel': 'rgba(46, 125, 79, 0.55)',
    '--dot': 'rgba(21, 58, 38, 0.4)',
  },
  dark: {
    '--acc': '#4cbb7a',
    '--acc-ink': '#06200f',
    '--acc-text': '#6fd197',
    '--acc-soft': 'rgba(76, 187, 122, 0.16)',
    '--move': '#e8c35a',
    '--move-ink': '#2a2000',
    '--move-soft': 'rgba(232, 195, 90, 0.12)',
    '--move-text': '#ecc964',
    '--urgent': '#ef5b5b',
    '--hero-bg': 'linear-gradient(135deg, #1f4a33, #11281b)',
    '--hero-ink': '#f5f0dc',
    '--hero-sub': '#a9c7b3',
    '--bl': '#e6dfc3',
    '--bd': '#6e9160',
    '--lm': 'rgba(232, 195, 90, 0.6)',
    '--sel': 'rgba(76, 187, 122, 0.6)',
    '--dot': 'rgba(12, 40, 24, 0.45)',
  },
} as const satisfies Record<'light' | 'dark', Record<string, string>>;
```

Replace `themeVariables` with:

```ts
export function themeVariables(
  params: ThemeParams,
  scheme: 'light' | 'dark',
): Record<string, string> {
  const fallback = FALLBACK_THEME[scheme];
  const bg = params.bg_color ?? fallback.bg;
  const secondaryBg = params.secondary_bg_color ?? fallback.secondaryBg;
  return {
    '--bg': bg,
    '--text': params.text_color ?? fallback.text,
    '--hint': params.hint_color ?? fallback.hint,
    '--link': params.link_color ?? fallback.link,
    '--button': params.button_color ?? fallback.button,
    '--button-text': params.button_text_color ?? fallback.buttonText,
    '--secondary-bg': secondaryBg,
    '--destructive': params.destructive_text_color ?? fallback.destructive,
    // The design's two surfaces: the page sits on the secondary colour, cards on the main one.
    '--page': secondaryBg,
    '--card': bg,
    ...ACCENTS[scheme],
  };
}

/** Telegram's own chrome (header, background, bottom bar, MainButton) matched to the page. */
export function applyChrome(tg: Tg): void {
  tg.setChromeColor('secondary_bg_color');
  const accent = ACCENTS[tg.colorScheme];
  tg.setMainButtonColors(accent['--acc'], accent['--acc-ink']);
}
```

- [ ] **Step 6: Call it at boot and on theme changes**

In `src/boot.ts`, import `applyChrome` alongside `applyTheme` and replace the first lines of `boot`:

```ts
  applyTheme(tg);
  applyChrome(tg);
  tg.ready();
  tg.expand();
  tg.disableVerticalSwipes();
  tg.onThemeChanged(() => {
    applyTheme(tg);
    applyChrome(tg);
  });
  tg.onViewportChanged(() => applyTheme(tg));
```

- [ ] **Step 7: Run the tests**

Run: `pnpm --filter @group-chess/miniapp exec vitest run`
Expected: PASS (including the pre-existing "gates every capability by the client version", since both new features sit between 6.0 and 8.0).

- [ ] **Step 8: Commit**

```bash
git add apps/miniapp
git commit -m "feat(miniapp): Chess Goat accent tokens over Telegram's neutrals, and matching chrome"
```

---

### Task 3: Brand, typography and the base look

**Files:**
- Create: `apps/miniapp/src/assets/goat-mark.png`, `apps/miniapp/src/assets/goat-banner.jpg`
- Create: `apps/miniapp/src/assets/fonts/dm-serif-display-latin-400.woff2`, `apps/miniapp/src/assets/fonts/OFL.txt`
- Create: `apps/miniapp/src/brand.ts`
- Modify: `apps/miniapp/src/styles.css`, `apps/miniapp/index.html`
- Modify: `packages/shared/src/i18n/en.ts`, `packages/shared/src/chess/pgn.ts`
- Modify: `packages/shared/test/chess/pgn.test.ts`, `apps/server/test/integration/api-games.test.ts:223`, `apps/server/test/integration/lichess.test.ts:121`
- Create: `apps/miniapp/test/brand.test.ts`

**Interfaces:**
- Produces: `BRAND = { name, author, repository, markUrl, bannerUrl }`, `AUTHOR_URL`, `REPO_URL` from `src/brand.ts`.
- Produces (CSS): tokens `--page`, `--card`, `--sep`, `--sep-strong`, `--display`; classes `.title` (display face), `.subtitle`, `.section` (the SectionLabel style), `.card`/`.list` (rounded card), `.grow > .primary`, `.grow > .secondary`, `.chevron`, `.btn` (primary green), `.btn.secondary`, `.btn.danger`, `.badge` (gold), `.switch`, `.segmented` (full width), `.tabbar` (pill + gold badge), chessground colours.

- [ ] **Step 1: Get the two images**

`DesignSync get_file` truncates at 256 KiB (checked: `assets/goat-mark.png` arrives cut at 196,608 bytes and will not decode), so it cannot deliver these. Ask your human partner to export `assets/goat-mark.png` and `assets/goat-banner.png` from the Claude Design project into `<scratchpad>/design/`, and wait for them. Then:

```bash
D=<scratchpad>/design
file $D/goat-mark.png $D/goat-banner.png   # both must say "PNG image data"
sips -z 144 144 $D/goat-mark.png --out apps/miniapp/src/assets/goat-mark.png
sips --resampleWidth 720 -s format jpeg -s formatOptions 78 $D/goat-banner.png --out apps/miniapp/src/assets/goat-banner.jpg
ls -l apps/miniapp/src/assets
```
Expected: each file ≤ 60 KB (spec §1). If the mark is larger, re-run with `-s format png` after `sips -z 120 120`; if the banner is, lower `formatOptions` to 70.

- [ ] **Step 2: Vendor the font**

```bash
mkdir -p apps/miniapp/src/assets/fonts
curl -sA 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15' \
  'https://fonts.googleapis.com/css2?family=DM+Serif+Display&display=swap' > <scratchpad>/dmserif.css
# The block commented /* latin */ holds the url(...) of the Latin subset; download exactly that one.
curl -so apps/miniapp/src/assets/fonts/dm-serif-display-latin-400.woff2 '<the latin woff2 url>'
curl -so apps/miniapp/src/assets/fonts/OFL.txt https://raw.githubusercontent.com/google/fonts/main/ofl/dmserifdisplay/OFL.txt
file apps/miniapp/src/assets/fonts/dm-serif-display-latin-400.woff2   # "Web Open Font Format (Version 2)"
head -3 apps/miniapp/src/assets/fonts/OFL.txt                        # starts with the DM Serif copyright line
```
Copy the `unicode-range` of that `/* latin */` block; Step 6 uses it.

- [ ] **Step 3: Write the failing tests**

Create `apps/miniapp/test/brand.test.ts`:

```ts
import { en } from '@group-chess/shared';
import { describe, expect, it } from 'vitest';
import { AUTHOR_URL, BRAND, REPO_URL } from '../src/brand';

describe('brand', () => {
  it('names the app Chess Goat and points at its author and source', () => {
    expect(BRAND.name).toBe('Chess Goat');
    expect(AUTHOR_URL).toBe('https://t.me/Jarvl');
    expect(REPO_URL).toBe('https://github.com/Jarvl/telegram-chess-bot');
    expect(BRAND.markUrl).toMatch(/goat-mark/);
    expect(BRAND.bannerUrl).toMatch(/goat-banner/);
  });

  it('says Chess Goat in the licence note', () => {
    expect(en['app.settings.about']).toContain('Chess Goat is free software');
    expect(en['app.settings.about']).not.toContain('Group Chess');
  });
});
```

In `packages/shared/test/chess/pgn.test.ts` change the test name to `'writes the seven-tag roster followed by the Chess Goat tags'` and `'[Event "Group Chess"]'` to `'[Event "Chess Goat"]'`. Make the same `[Event "Chess Goat"]` change at `apps/server/test/integration/api-games.test.ts:223` and `apps/server/test/integration/lichess.test.ts:121`.

- [ ] **Step 4: Run them to see them fail**

Run: `pnpm --filter @group-chess/miniapp exec vitest run test/brand.test.ts && pnpm --filter @group-chess/shared exec vitest run test/chess/pgn.test.ts`
Expected: FAIL (`../src/brand` missing; PGN still says Group Chess).

- [ ] **Step 5: Add the brand module and the name changes**

`apps/miniapp/src/brand.ts`:

```ts
import bannerUrl from './assets/goat-banner.jpg';
import markUrl from './assets/goat-mark.png';

/** Who and what the app is; the one place these names are spelled out (redesign spec §1). */
export const BRAND = {
  name: 'Chess Goat',
  author: 'Jarvl',
  repository: 'Jarvl/telegram-chess-bot',
  markUrl,
  bannerUrl,
} as const;

export const AUTHOR_URL = `https://t.me/${BRAND.author}`;
export const REPO_URL = `https://github.com/${BRAND.repository}`;
```

`packages/shared/src/chess/pgn.ts:71`: `['Event', headers.event ?? 'Chess Goat'],`.
`packages/shared/src/i18n/en.ts`: `'app.settings.about'` → `'Pieces by Colin M.L. Burnett (CC BY-SA 3.0). Board by chessground. Chess Goat is free software under the GPL-3.0-or-later.'`.
`apps/miniapp/index.html`: `<title>Chess Goat</title>`.

- [ ] **Step 6: Restyle the foundation in `styles.css`**

Replace the three `@import` lines and the `:root`/`html, body` blocks at the top with:

```css
@import 'chessground/assets/chessground.base.css';
@import 'chessground/assets/chessground.cburnett.css';

/* DM Serif Display, Latin subset, OFL-1.1 (assets/fonts/OFL.txt): display text only. */
@font-face {
  font-family: 'DM Serif Display';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url('./assets/fonts/dm-serif-display-latin-400.woff2') format('woff2');
  unicode-range: /* paste the latin block's unicode-range from Step 2 */;
}

:root {
  --bg: #ffffff;
  --text: #000000;
  --hint: #707579;
  --link: #2481cc;
  --button: #2481cc;
  --button-text: #ffffff;
  --secondary-bg: #f1f1f4;
  --destructive: #d14e4e;
  --page: var(--secondary-bg);
  --card: var(--bg);
  --sep: color-mix(in srgb, var(--hint) 18%, transparent);
  --sep-strong: color-mix(in srgb, var(--hint) 45%, transparent);
  --display: 'DM Serif Display', Georgia, serif;
  /* The light accent set until applyTheme runs (tg/theme.ts ACCENTS). */
  --acc: #2e7d4f;
  --acc-ink: #ffffff;
  --acc-text: #256b42;
  --acc-soft: #e3f1e7;
  --move: #e0b94a;
  --move-ink: #2a2000;
  --move-soft: #fbf3dc;
  --move-text: #8a6a00;
  --urgent: #d14e4e;
  --hero-bg: linear-gradient(135deg, #236140, #153a26);
  --hero-ink: #f5f0dc;
  --hero-sub: #bcd3c2;
  --bl: #f0ead2;
  --bd: #7d9f6b;
  --lm: rgba(224, 185, 74, 0.6);
  --sel: rgba(46, 125, 79, 0.55);
  --dot: rgba(21, 58, 38, 0.4);
  --stable-height: 100vh;
  --radius: 12px;
  --tabbar-h: calc(56px + env(safe-area-inset-bottom, 0px));
  /** Vertical space the board must leave for chrome below it; the tab bar adds itself here. */
  --board-reserve: 0px;
  color-scheme: light dark;
}

* {
  box-sizing: border-box;
}

html,
body {
  margin: 0;
  padding: 0;
  background: var(--page);
  color: var(--text);
  font:
    16px/1.4 -apple-system,
    system-ui,
    'Segoe UI',
    Roboto,
    sans-serif;
  -webkit-font-smoothing: antialiased;
  -webkit-text-size-adjust: 100%;
  overscroll-behavior: none;
}
```

Then replace these existing rules with the versions below (keep every other rule as it is for now):

```css
.screen {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 10px 16px 20px;
  max-width: 640px;
  margin: 0 auto;
}

.title {
  font: 30px/1.1 var(--display);
  margin: 0;
  overflow-wrap: anywhere;
}

.subtitle {
  color: var(--hint);
  font-size: 14px;
  margin: 0;
}

.hint {
  color: var(--hint);
  font-size: 14px;
  margin: 0;
}

/* The design's section label. */
.section {
  margin: 6px 0 0;
  font-size: 13px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--hint);
}

.card,
.list {
  background: var(--card);
  border-radius: 18px;
  overflow: hidden;
}

.card.empty {
  padding: 28px 16px;
  text-align: center;
  color: var(--hint);
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.row {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 12px 14px;
  border: 0;
  border-bottom: 1px solid var(--sep);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
}

.grow {
  flex: 1;
  min-width: 0;
}

.grow > .primary {
  display: block;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.grow > .secondary {
  display: block;
  font-size: 13px;
  color: var(--hint);
}

.chevron {
  color: var(--hint);
  font-size: 22px;
  line-height: 1;
  opacity: 0.7;
  flex: none;
}

.badge {
  font-size: 12px;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--move);
  color: var(--move-ink);
  white-space: nowrap;
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 12px 14px;
  border: 0;
  border-radius: 14px;
  background: var(--acc);
  color: var(--acc-ink);
  font: inherit;
  font-weight: 700;
}

.btn.secondary {
  background: var(--card);
  color: var(--text);
  font-weight: 600;
}

.btn.danger {
  background: var(--card);
  color: var(--destructive);
  font-weight: 600;
}

.btn.block {
  display: flex;
  width: 100%;
  margin: 0;
}

.switch {
  position: relative;
  width: 44px;
  height: 26px;
  border-radius: 13px;
  border: 0;
  background: var(--sep-strong);
  flex: none;
}

.switch[aria-checked='true'] {
  background: var(--acc);
}

.segmented {
  display: flex;
  padding: 3px;
  border-radius: 999px;
  background: var(--card);
}

.segmented button {
  flex: 1;
  border: 0;
  background: transparent;
  color: var(--text);
  padding: 8px 0;
  border-radius: 999px;
  font: inherit;
  font-size: 15px;
}

.segmented button[aria-pressed='true'] {
  background: var(--acc);
  color: var(--acc-ink);
  font-weight: 700;
}

.toast {
  position: fixed;
  left: 50%;
  bottom: 24px;
  transform: translateX(-50%);
  background: color-mix(in srgb, var(--text) 88%, transparent);
  color: var(--card);
  padding: 10px 16px;
  border-radius: 999px;
  font-size: 14px;
  z-index: 20;
  max-width: calc(100vw - 32px);
}

/* Above the tab bar when there is one. */
.with-tabbar ~ .toast {
  bottom: calc(var(--tabbar-h) + 16px);
}
```

Delete the old `.row:last-child`, `.row .grow`, `.row .primary`, `.row .secondary`, `.tabs`, `.tab`, `.tab[aria-selected='true']` rules (the lobby tabs go in Task 8) and add `.card > .row:last-child, .list > .row:last-child { border-bottom: 0; }`.

Tab bar: change `.tabbar` to `background: var(--card); border-top: 1px solid var(--sep);`, `.tabbar .nav-item.active` to `color: var(--acc-text);` and add:

```css
.tabbar .nav-icon-wrap {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 60px;
  height: 32px;
  border-radius: 16px;
  transition: background 0.15s;
}

.tabbar .nav-item.active .nav-icon-wrap {
  background: var(--acc-soft);
}

.tabbar .nav-item.active .nav-label {
  font-weight: 600;
}
```

and in `.tabbar .nav-badge` replace `bottom: 58%; left: 58%;` with `top: 0; left: 36px;`, the background with `var(--move)`, the colour with `var(--move-ink)`, and add `box-shadow: 0 0 0 2px var(--card);` (keep `min-width`, `height` and the `text-box-*` lines: the e2e suite checks a single-digit badge is round).

Board colours, appended at the end of the file:

```css
/* The Chess Goat board: cream and green squares, gold last move, green selection. */
cg-board {
  background-color: var(--bd);
  /* One 2×2 tile per quarter: a8 (top-left, either orientation) is light. */
  background-image: conic-gradient(
    var(--bd) 0 25%,
    var(--bl) 0 50%,
    var(--bd) 0 75%,
    var(--bl) 0
  );
  background-size: 25% 25%;
}

cg-board square.last-move {
  background-color: var(--lm);
}

cg-board square.selected {
  background-color: var(--sel);
}

cg-board square.move-dest {
  background: radial-gradient(var(--dot) 22%, transparent 23%);
}

cg-board square.oc.move-dest {
  background: radial-gradient(transparent 0%, transparent 79%, var(--dot) 80%);
}
```

Coordinates: open `node_modules/chessground/assets/chessground.brown.css`. It holds one board-image rule and two coordinate-colour rules. Copy only the two coordinate rules to the end of `styles.css`, replacing the dark colour (`rgba(72, 72, 72, 0.8)`) with `var(--bd)` and the light one (`rgba(255, 255, 255, 0.8)`) with `var(--bl)`, and add `font-weight: 700;` to both.

- [ ] **Step 7: Run tests and the build**

Run: `pnpm test && pnpm build && pnpm check:budget`
Expected: tests PASS; budget prints `css: … OK` and `js: … OK`; `apps/miniapp/dist/assets` contains the `.woff2`, `.png` and `.jpg`.

- [ ] **Step 8: Commit**

```bash
git add apps/miniapp packages/shared apps/server/test
git commit -m "feat(miniapp): Chess Goat brand, display face, board colours and base surfaces"
```

---

### Task 4: Native popups, the Settings button, closing confirmation and selection haptics

**Files:**
- Modify: `apps/miniapp/src/tg/types.ts`, `apps/miniapp/src/tg/webapp.ts`
- Modify: `apps/miniapp/src/ui/dialog.tsx`
- Modify: `apps/miniapp/src/ui/TabBar.tsx`, `apps/miniapp/src/ui/controls.tsx`
- Modify: `apps/miniapp/src/boot.ts`
- Modify: `packages/shared/src/i18n/en.ts` (add `'app.common.ok': 'OK'`)
- Modify: `apps/miniapp/test/support/fakeWebApp.ts`, `apps/miniapp/test/support/render.tsx`, `apps/miniapp/e2e/support.ts`
- Create: `apps/miniapp/test/dialog.test.tsx`
- Modify: `apps/miniapp/test/tg.test.ts`, `apps/miniapp/test/boot.test.ts`, `apps/miniapp/test/settings.test.tsx`, `apps/miniapp/test/groupSettings.test.tsx`, `apps/miniapp/test/games.test.tsx`

**Interfaces:**
- Consumes: `Tg` from Task 2.
- Produces: `PopupButton`, `PopupParams` types; `Tg.showPopup(params: PopupParams): Promise<string | null> | null`, `Tg.setClosingConfirmation(enabled: boolean): void`, `Tg.onSettingsButton(callback: () => void): () => void`, `Tg.hapticSelection(): void`, `Tg.openTelegramLink(url: string): void`; features `popup`, `closingConfirmation`, `settingsButton`.
- Produces: `confirmDialog(message, { confirmLabel?, danger? }): Promise<boolean>` (unchanged signature), `infoDialog(message: string, title?: string): Promise<void>`.
- Produces: `Switch` and `Segmented` fire `tg.hapticSelection()` before `onChange`; `DataAttributes` is exported from `controls.tsx`.
- Produces (fake): `record.popups: PopupParams[]`, `record.answerPopup(id: string)`, `record.closingConfirmation: boolean`, `record.settingsButton: { visible: boolean } | null`, `record.clickSettings()`; `renderApp(…, { writeAccess })`.

- [ ] **Step 1: Extend the fake WebApp and the render helper**

In `test/support/fakeWebApp.ts`:
- `FakeWebAppRecord` gains
  ```ts
  popups: { title?: string; message: string; buttons: { id?: string; type?: string; text?: string }[] }[];
  answerPopup(id: string): void;
  closingConfirmation: boolean;
  settingsButton: { visible: boolean } | null;
  clickSettings(): void;
  ```
- In `record`: `popups: [], closingConfirmation: false, settingsButton: atLeast(options.version, '7.0') ? { visible: false } : null,` plus
  ```ts
    answerPopup: (id) => {
      const answer = pendingPopup;
      pendingPopup = null;
      answer?.(id);
    },
    clickSettings: () => {
      for (const cb of [...handlers.settings]) cb();
    },
  ```
  declare `let pendingPopup: ((id: string) => void) | null = null;` before `record`, and add `settings: [] as (() => void)[],` to `handlers`.
- After the 6.1 chrome block:
  ```ts
  if (atLeast(options.version, '6.2')) {
    webApp.showPopup = (
      params: FakeWebAppRecord['popups'][number],
      cb?: (id: string) => void,
    ) => {
      record.popups.push(params);
      record.calls.push(`showPopup:${params.message}`);
      pendingPopup = cb ?? null;
    };
    webApp.enableClosingConfirmation = () => {
      record.closingConfirmation = true;
      record.calls.push('enableClosingConfirmation');
    };
    webApp.disableClosingConfirmation = () => {
      record.closingConfirmation = false;
      record.calls.push('disableClosingConfirmation');
    };
  }
  if (record.settingsButton) {
    const state = record.settingsButton;
    webApp.SettingsButton = {
      show: () => {
        state.visible = true;
        record.calls.push('SettingsButton.show');
      },
      hide: () => {
        state.visible = false;
        record.calls.push('SettingsButton.hide');
      },
      onClick: (cb: () => void) => handlers.settings.push(cb),
      offClick: (cb: () => void) => {
        const at = handlers.settings.indexOf(cb);
        if (at >= 0) handlers.settings.splice(at, 1);
      },
    };
  }
  ```
- In `e2e/support.ts`, add `'answerPopup' | 'clickSettings'` to the `Omit<…>` of `tgState` and return `popups: record.popups, closingConfirmation: record.closingConfirmation, settingsButton: record.settingsButton` as well.
- In `test/support/render.tsx`, accept `writeAccess?: boolean` in `options` and pass it: `installFakeWebApp({ version: options.version ?? '8.0', initData: 'user=x&hash=y', writeAccess: options.writeAccess });`.

- [ ] **Step 2: Write the failing tests**

Create `test/dialog.test.tsx`:

```ts
import { describe, expect, it } from 'vitest';
import { confirmDialog, infoDialog } from '../src/ui/dialog';
import { renderApp } from './support/render';

const mount = (version: string) =>
  renderApp(
    () => null,
    () => ({ status: 200, body: {} }),
    { version },
  );

describe('confirmDialog', () => {
  it('asks through Telegram’s native popup from 6.2', async () => {
    const r = mount('6.2');
    await r.flush();
    const answer = confirmDialog('Resign this game?', { confirmLabel: 'Resign', danger: true });
    expect(window.__tg!.popups.at(-1)).toEqual({
      message: 'Resign this game?',
      buttons: [
        { id: 'cancel', type: 'cancel' },
        { id: 'confirm', type: 'destructive', text: 'Resign' },
      ],
    });
    expect(document.querySelector('.dialog')).toBeNull();
    window.__tg!.answerPopup('confirm');
    expect(await answer).toBe(true);
  });

  it('treats a dismissed popup as no', async () => {
    const r = mount('8.0');
    await r.flush();
    const answer = confirmDialog('Abort this game?');
    window.__tg!.answerPopup('');
    expect(await answer).toBe(false);
  });

  it('falls back to the in-page sheet below 6.2', async () => {
    const r = mount('6.1');
    await r.flush();
    const answer = confirmDialog('Delete your data?', { confirmLabel: 'Delete', danger: true });
    await r.flush();
    expect(document.querySelector('.dialog p')?.textContent).toBe('Delete your data?');
    await r.click('[data-dialog="confirm"]');
    expect(await answer).toBe(true);
  });
});

describe('infoDialog', () => {
  it('shows a titled message with a single OK', async () => {
    const r = mount('8.0');
    await r.flush();
    const done = infoDialog('Pieces by …', 'About Chess Goat');
    expect(window.__tg!.popups.at(-1)).toEqual({
      title: 'About Chess Goat',
      message: 'Pieces by …',
      buttons: [{ id: 'confirm', type: 'ok' }],
    });
    window.__tg!.answerPopup('confirm');
    await done;
  });

  it('shows the same in the page below 6.2, without a cancel button', async () => {
    const r = mount('6.1');
    await r.flush();
    void infoDialog('Pieces by …', 'About Chess Goat');
    await r.flush();
    expect(document.querySelector('.dialog strong')?.textContent).toBe('About Chess Goat');
    expect(document.querySelector('[data-dialog="cancel"]')).toBeNull();
    expect(document.querySelector('[data-dialog="confirm"]')?.textContent).toBe('OK');
  });
});
```

Append to `describe('createTg', …)` in `test/tg.test.ts`:

```ts
  it('confirms closing only from 6.2', () => {
    tgFor({ version: '6.1' }).setClosingConfirmation(true);
    expect(window.__tg!.calls).not.toContain('enableClosingConfirmation');
    const tg = tgFor({ version: '6.2' });
    tg.setClosingConfirmation(true);
    expect(window.__tg!.closingConfirmation).toBe(true);
    tg.setClosingConfirmation(false);
    expect(window.__tg!.closingConfirmation).toBe(false);
  });

  it('offers no popup below 6.2', () => {
    expect(tgFor({ version: '6.1' }).showPopup({ message: 'x', buttons: [] })).toBeNull();
  });

  it('shows the settings button from 7.0 and routes its taps until unsubscribed', () => {
    let taps = 0;
    tgFor({ version: '6.9' }).onSettingsButton(() => (taps += 1));
    expect(window.__tg!.settingsButton).toBeNull();
    const off = tgFor({ version: '7.0' }).onSettingsButton(() => (taps += 1));
    expect(window.__tg!.settingsButton?.visible).toBe(true);
    window.__tg!.clickSettings();
    off();
    window.__tg!.clickSettings();
    expect(taps).toBe(1);
    expect(window.__tg!.settingsButton?.visible).toBe(false);
  });

  it('forwards selection haptics from 6.1 and opens Telegram links', () => {
    const tg = tgFor({ version: '6.1' });
    tg.hapticSelection();
    tg.openTelegramLink('https://t.me/Jarvl');
    expect(window.__tg!.haptics).toEqual(['selection']);
    expect(window.__tg!.links).toEqual(['https://t.me/Jarvl']);
  });
```

In `test/boot.test.ts`, add to the first boot test:

```ts
    // Telegram's own ⋯ menu gets a Settings entry that opens the Settings tab.
    expect(record.settingsButton?.visible).toBe(true);
    record.clickSettings();
    expect(router.tab.value).toBe('settings');
```

In `test/games.test.tsx`, in the TabBar test after `await r.click('[data-nav="settings"]');`: `expect(window.__tg!.haptics).toContain('selection');`.

Update the two tests that clicked the in-page confirm at 8.0:
- `test/settings.test.tsx`, "deletes my data…": replace the four dialog lines with
  ```ts
    await r.click('[data-action="delete"]');
    window.__tg!.answerPopup('cancel');
    await r.flush();
    expect(r.calls).toHaveLength(0);
    await r.click('[data-action="delete"]');
    window.__tg!.answerPopup('confirm');
    await r.flush();
  ```
- `test/groupSettings.test.tsx`, "unblocks and blocks players": replace the `.dialog p` expectation and the `[data-dialog="confirm"]` click with
  ```ts
    expect(window.__tg!.popups.at(-1)?.message).toBe('Block Bob?');
    window.__tg!.answerPopup('confirm');
    await r.flush();
  ```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm --filter @group-chess/miniapp exec vitest run test/dialog.test.tsx test/tg.test.ts test/boot.test.ts test/settings.test.tsx test/groupSettings.test.tsx test/games.test.tsx`
Expected: FAIL (`showPopup is not a function`, no popups recorded, settings button hidden).

- [ ] **Step 4: Add the wrapper methods**

`src/tg/types.ts`, in `TelegramWebApp`:

```ts
  showPopup?(
    params: {
      title?: string;
      message: string;
      buttons?: { id?: string; type?: string; text?: string }[];
    },
    callback?: (buttonId: string) => void,
  ): void;
  enableClosingConfirmation?(): void;
  disableClosingConfirmation?(): void;
  SettingsButton?: {
    show(): void;
    hide(): void;
    onClick(callback: () => void): void;
    offClick(callback: () => void): void;
  };
```

`src/tg/webapp.ts`: add `'popup' | 'closingConfirmation' | 'settingsButton'` to `Feature` with `popup: '6.2', closingConfirmation: '6.2', settingsButton: '7.0'`, and export:

```ts
export type PopupButton = {
  id: string;
  type: 'default' | 'ok' | 'close' | 'cancel' | 'destructive';
  text?: string;
};

export type PopupParams = { title?: string; message: string; buttons: PopupButton[] };
```

Add to `Tg`:

```ts
  /**
   * Telegram's native alert (6.2+): resolves the pressed button's id, or null when dismissed.
   * Returns null instead of a promise when the client has none, so the caller renders its own.
   */
  showPopup(params: PopupParams): Promise<string | null> | null;
  /** Asks before a swipe or Close discards the page (6.2+); a no-op below. */
  setClosingConfirmation(enabled: boolean): void;
  /** Shows Telegram's Settings menu item (7.0+) and routes its taps here; returns the undo. */
  onSettingsButton(callback: () => void): () => void;
  hapticSelection(): void;
  /** A t.me link, opened inside Telegram. */
  openTelegramLink(url: string): void;
```

`nullTg()`:

```ts
    showPopup: () => null,
    setClosingConfirmation: () => undefined,
    onSettingsButton: () => () => undefined,
    hapticSelection: () => undefined,
    openTelegramLink: (url) => {
      window.open(url, '_blank', 'noopener');
    },
```

`createTg` return object:

```ts
    showPopup(params) {
      if (!supports('popup') || !raw.showPopup) return null;
      return new Promise((resolve) =>
        raw.showPopup!(params, (buttonId) => resolve(buttonId ? buttonId : null)),
      );
    },
    setClosingConfirmation(enabled) {
      if (!supports('closingConfirmation')) return;
      if (enabled) raw.enableClosingConfirmation?.();
      else raw.disableClosingConfirmation?.();
    },
    onSettingsButton(callback) {
      const button = supports('settingsButton') ? raw.SettingsButton : undefined;
      if (!button) return () => undefined;
      button.onClick(callback);
      button.show();
      return () => {
        button.offClick(callback);
        button.hide();
      };
    },
    hapticSelection() {
      if (supports('haptics')) raw.HapticFeedback?.selectionChanged();
    },
    openTelegramLink: (url) => raw.openTelegramLink(url),
```

- [ ] **Step 5: Route dialogs through the popup**

Replace `src/ui/dialog.tsx` with:

```tsx
import { t } from '@group-chess/shared';
import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import type { Tg } from '../tg/webapp';
import { useApp } from './context';

type Request = {
  title?: string;
  message: string;
  confirmLabel: string;
  danger: boolean;
  /** False for a message with a single OK. */
  cancellable: boolean;
};

type Pending = Request & { resolve: (answer: boolean) => void };

const pending = signal<Pending | null>(null);
/** The client of the mounted <Dialogs />: questions go to its native popup when it has one. */
let host: Tg | null = null;

function ask(request: Request): Promise<boolean> {
  const native = host?.showPopup({
    ...(request.title ? { title: request.title } : {}),
    message: request.message,
    buttons: request.cancellable
      ? [
          { id: 'cancel', type: 'cancel' },
          {
            id: 'confirm',
            type: request.danger ? 'destructive' : 'default',
            text: request.confirmLabel,
          },
        ]
      : [{ id: 'confirm', type: 'ok' }],
  });
  if (native) return native.then((id) => id === 'confirm');
  pending.value?.resolve(false);
  return new Promise((resolve) => {
    pending.value = { ...request, resolve };
  });
}

/** Cancel and one confirm action: Telegram's popup from 6.2, a bottom sheet below. */
export function confirmDialog(
  message: string,
  options: { confirmLabel?: string; danger?: boolean } = {},
): Promise<boolean> {
  return ask({
    message,
    confirmLabel: options.confirmLabel ?? t('app.game.confirm'),
    danger: options.danger ?? false,
    cancellable: true,
  });
}

/** A message with a single OK, such as the About box. */
export async function infoDialog(message: string, title?: string): Promise<void> {
  await ask({ title, message, confirmLabel: t('app.common.ok'), danger: false, cancellable: false });
}

export function Dialogs() {
  const { tg } = useApp();
  useEffect(() => {
    host = tg;
    return () => {
      if (host === tg) host = null;
    };
  }, [tg]);
  const current = pending.value;
  if (!current) return null;
  const answer = (value: boolean) => {
    pending.value = null;
    current.resolve(value);
  };
  return (
    <div class="dialog-backdrop" onClick={() => answer(false)}>
      <div class="dialog" role="dialog" onClick={(event) => event.stopPropagation()}>
        {current.title ? <strong>{current.title}</strong> : null}
        <p>{current.message}</p>
        <div class="actions">
          {current.cancellable ? (
            <button class="btn secondary" data-dialog="cancel" onClick={() => answer(false)}>
              {t('app.game.cancel')}
            </button>
          ) : null}
          <button
            class={`btn ${current.danger ? 'danger' : ''}`}
            data-dialog="confirm"
            onClick={() => answer(true)}
          >
            {current.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
```

Add `'app.common.ok': 'OK',` to `en.ts` after `'app.common.more'`. Style `.dialog strong { display: block; font-size: 17px; margin-bottom: 4px; }` and change `.dialog` to `background: var(--card); border-radius: 18px 18px 0 0;` in `styles.css`.

- [ ] **Step 6: Selection haptics and the Settings button**

`src/ui/TabBar.tsx`: take `tg` from `useApp()` and use `onClick={() => { tg.hapticSelection(); router.select(tab); }}`.

`src/ui/controls.tsx`: `export type DataAttributes = …`; import `useApp` from `./context`; in `Switch` use `const { tg } = useApp();` and `onClick={() => { tg.hapticSelection(); onChange(!checked); }}`; in `Segmented` the same around `props.onChange(value)`.

`src/boot.ts`, right after `router.land(landing.tab, landing.route);`:

```ts
  // Telegram's ⋯ menu gains Settings once there is a session to have settings for.
  tg.onSettingsButton(() => router.select('settings'));
```

- [ ] **Step 7: Run the tests**

Run: `pnpm --filter @group-chess/miniapp exec vitest run`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/miniapp packages/shared/src/i18n/en.ts
git commit -m "feat(miniapp): native popups, a Settings menu entry, closing confirmation and selection haptics"
```

---

### Task 5: Avatar and MiniBoard

**Files:**
- Create: `apps/miniapp/src/ui/avatar.ts`, `apps/miniapp/src/ui/Avatar.tsx`, `apps/miniapp/src/ui/MiniBoard.tsx`
- Modify: `apps/miniapp/src/styles.css`
- Create: `apps/miniapp/test/avatar.test.tsx`, `apps/miniapp/test/miniBoard.test.tsx`

**Interfaces:**
- Consumes: `PlayerRef.isBot` (Task 1), `BRAND.markUrl` (Task 3).
- Produces: `AVATAR_PALETTE: readonly string[]`, `avatarColour(userId: string): string`, `groupColour(publicId: string): string`, `personInitial(name: string): string`, `groupInitials(title: string): string` in `ui/avatar.ts`.
- Produces: `<Avatar player={Pick<PlayerRef, 'id' | 'name' | 'isBot'>} size={22 | 34 | 38 | 40 | 56} />`, `<BotMark size={…} />`, `<GroupAvatar group={GroupRef} size={48 | 56} />` in `ui/Avatar.tsx`.
- Produces: `<MiniBoard fen={string} lastMove={string | null} orientation={Colour} />` in `ui/MiniBoard.tsx`; each square is `span.sq.l|.d[.lm][data-square]`, pieces are `piece.<role>.<colour>`.

- [ ] **Step 1: Write the failing tests**

`test/avatar.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import { Avatar, GroupAvatar } from '../src/ui/Avatar';
import {
  AVATAR_PALETTE,
  avatarColour,
  groupColour,
  groupInitials,
  personInitial,
} from '../src/ui/avatar';
import { renderApp } from './support/render';

describe('avatar helpers', () => {
  it('picks Telegram’s palette by user id modulo 7', () => {
    expect(avatarColour('7')).toBe('#e17076');
    expect(avatarColour('1')).toBe('#faa774');
    expect(avatarColour('13')).toBe('#ee7aae');
  });

  it('stays in the palette for ids beyond 2^53', () => {
    const colour = avatarColour('9223372036854775807');
    expect(AVATAR_PALETTE).toContain(colour);
    expect(avatarColour('9223372036854775807')).toBe(colour);
  });

  it('colours a group by its public id, the same every time', () => {
    expect(AVATAR_PALETTE).toContain(groupColour('GrOuPiDxYz'));
    expect(groupColour('GrOuPiDxYz')).toBe(groupColour('GrOuPiDxYz'));
  });

  it('takes a person’s first character, skipping the @ of a username', () => {
    expect(personInitial('@mayachess')).toBe('M');
    expect(personInitial('tom')).toBe('T');
    expect(personInitial('🦄 Unicorn')).toBe('🦄');
    expect(personInitial('@')).toBe('?');
    expect(personInitial('')).toBe('?');
  });

  it('takes up to two initials from a group title', () => {
    expect(groupInitials('Friday Chess Club')).toBe('FC');
    expect(groupInitials('Family')).toBe('F');
    expect(groupInitials('office blitz')).toBe('OB');
    expect(groupInitials('   ')).toBe('?');
  });
});

describe('Avatar', () => {
  it('draws a coloured initial for a person and the goat mark for the bot', async () => {
    const r = renderApp(
      () => (
        <>
          <Avatar player={{ id: '7', name: '@maya', isBot: false }} size={40} />
          <Avatar player={{ id: '9', name: 'Stockfish', isBot: true }} size={34} />
          <GroupAvatar group={{ id: 'GrOuPiDxYz', title: 'Friday Chess Club' }} size={56} />
        </>
      ),
      () => ({ status: 200, body: {} }),
    );
    await r.flush();
    const [person, bot, group] = [...r.root.querySelectorAll('.avatar')] as HTMLElement[];
    expect(person!.textContent).toBe('M');
    // happy-dom may keep the hex or serialise it as rgb(); either is the palette's red.
    expect(person!.getAttribute('style')).toMatch(/#e17076|rgb\(225, 112, 118\)/);
    expect(bot!.tagName).toBe('IMG');
    expect(bot!.getAttribute('src')).toMatch(/goat-mark/);
    expect(group!.className).toContain('group');
    expect(group!.textContent).toBe('FC');
  });
});
```

`test/miniBoard.test.tsx`:

```tsx
import { INITIAL_FEN } from '@group-chess/shared';
import { describe, expect, it } from 'vitest';
import { MiniBoard } from '../src/ui/MiniBoard';
import { AFTER_E4 } from './support/gameFixtures';
import { renderApp } from './support/render';

const mount = (fen: string, lastMove: string | null, orientation: 'white' | 'black') =>
  renderApp(
    () => <MiniBoard fen={fen} lastMove={lastMove} orientation={orientation} />,
    () => ({ status: 200, body: {} }),
  );

describe('MiniBoard', () => {
  it('draws 64 squares from a8 with the pieces of the position', async () => {
    const r = mount(AFTER_E4, 'e2e4', 'white');
    await r.flush();
    const squares = [...r.root.querySelectorAll('[data-square]')];
    expect(squares).toHaveLength(64);
    expect(squares[0]!.getAttribute('data-square')).toBe('a8');
    expect(squares[0]!.className).toContain('l');
    expect(r.root.querySelector('[data-square="a1"]')!.className).toContain('d');
    expect(r.root.querySelector('[data-square="e4"] piece')!.getAttribute('class')).toBe(
      'pawn white',
    );
    expect(r.root.querySelector('[data-square="e2"] piece')).toBeNull();
    expect(r.root.querySelectorAll('piece')).toHaveLength(32);
  });

  it('tints the last move’s two squares', async () => {
    const r = mount(AFTER_E4, 'e2e4', 'white');
    await r.flush();
    expect([...r.root.querySelectorAll('.lm')].map((el) => el.getAttribute('data-square'))).toEqual(
      ['e4', 'e2'],
    );
  });

  it('tints nothing before the first move', async () => {
    const r = mount(INITIAL_FEN, null, 'white');
    await r.flush();
    expect(r.root.querySelectorAll('.lm')).toHaveLength(0);
  });

  it('turns the board for black', async () => {
    const r = mount(INITIAL_FEN, null, 'black');
    await r.flush();
    expect(r.root.querySelector('[data-square]')!.getAttribute('data-square')).toBe('h1');
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @group-chess/miniapp exec vitest run test/avatar.test.tsx test/miniBoard.test.tsx`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement the helpers**

`src/ui/avatar.ts`:

```ts
/** Telegram's own avatar colours, in its order (redesign spec §3.1). */
export const AVATAR_PALETTE = [
  '#e17076',
  '#faa774',
  '#a695e7',
  '#7bc862',
  '#6ec9cb',
  '#65aadd',
  '#ee7aae',
] as const;

/** Ids are decimal strings up to 19 digits, past a double's exact range, so BigInt it is. */
export function avatarColour(userId: string): string {
  return AVATAR_PALETTE[Number(BigInt(userId) % 7n)]!;
}

export function groupColour(publicId: string): string {
  let sum = 0;
  for (const char of publicId) sum += char.charCodeAt(0);
  return AVATAR_PALETTE[sum % 7]!;
}

/** The first character, whole even when it is an emoji; a username's @ is skipped. */
export function personInitial(name: string): string {
  const first = Array.from(name.replace(/^@/, '').trim())[0];
  return first ? first.toUpperCase() : '?';
}

export function groupInitials(title: string): string {
  const words = title.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  const initials = words.map((word) => Array.from(word)[0]!.toUpperCase()).join('');
  return initials || '?';
}
```

`src/ui/Avatar.tsx`:

```tsx
import type { GroupRef, PlayerRef } from '@group-chess/shared';
import { BRAND } from '../brand';
import { avatarColour, groupColour, groupInitials, personInitial } from './avatar';

type Size = 22 | 34 | 38 | 40 | 56;

export function BotMark(props: { size: Size }) {
  return (
    <img
      class="avatar bot"
      src={BRAND.markUrl}
      alt=""
      width={props.size}
      height={props.size}
      style={{ '--size': `${props.size}px` }}
    />
  );
}

/** A person as Telegram draws one without a photo; the bot as the Chess Goat mark. */
export function Avatar(props: { player: Pick<PlayerRef, 'id' | 'name' | 'isBot'>; size: Size }) {
  if (props.player.isBot) return <BotMark size={props.size} />;
  return (
    <span
      class="avatar"
      aria-hidden="true"
      style={{ '--size': `${props.size}px`, background: avatarColour(props.player.id) }}
    >
      {personInitial(props.player.name)}
    </span>
  );
}

export function GroupAvatar(props: { group: GroupRef; size: 48 | 56 }) {
  return (
    <span
      class="avatar group"
      aria-hidden="true"
      style={{ '--size': `${props.size}px`, background: groupColour(props.group.id) }}
    >
      {groupInitials(props.group.title)}
    </span>
  );
}
```

If TypeScript rejects `'--size'` in `style`, cast the object: `style={{ … } as Record<string, string>}`.

`src/ui/MiniBoard.tsx`:

```tsx
import type { Colour } from '@group-chess/shared';
import { read } from 'chessground/fen';
import type { Key } from 'chessground/types';
import { h } from 'preact';

const FILES = 'abcdefgh';

/** A still thumbnail of a position: the squares, the pieces, the last move tinted. */
export function MiniBoard(props: { fen: string; lastMove: string | null; orientation: Colour }) {
  const pieces = read(props.fen);
  const last = props.lastMove ? [props.lastMove.slice(0, 2), props.lastMove.slice(2, 4)] : [];
  const white = props.orientation === 'white';
  const squares = [];
  for (let row = 0; row < 8; row += 1) {
    for (let col = 0; col < 8; col += 1) {
      const file = white ? col : 7 - col;
      const rank = white ? 8 - row : row + 1;
      const key = `${FILES[file]}${rank}` as Key;
      const piece = pieces.get(key);
      // a1 (file 0, rank 1) is dark, so a square is light when file + rank is even.
      const shade = (file + rank) % 2 === 0 ? 'l' : 'd';
      squares.push(
        <span
          key={key}
          class={last.includes(key) ? `sq ${shade} lm` : `sq ${shade}`}
          data-square={key}
        >
          {piece ? h('piece', { class: `${piece.role} ${piece.color}` }) : null}
        </span>,
      );
    }
  }
  return (
    <span class="mini-board cg-wrap" aria-hidden="true">
      {squares}
    </span>
  );
}
```

- [ ] **Step 4: Style them**

Append to `styles.css`:

```css
.avatar {
  --size: 40px;
  width: var(--size);
  height: var(--size);
  border-radius: 50%;
  color: #fff;
  font-weight: 700;
  font-size: calc(var(--size) * 0.42);
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
}

.avatar.bot {
  object-fit: cover;
  object-position: 50% 30%;
}

.avatar.group {
  border-radius: 30%;
  font-size: calc(var(--size) * 0.36);
}

.mini-board {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  grid-template-rows: repeat(8, 1fr);
  width: 80px;
  height: 80px;
  flex: none;
  border-radius: 8px;
  overflow: hidden;
}

.mini-board .sq {
  position: relative;
  background: var(--bd);
}

.mini-board .sq.l {
  background: var(--bl);
}

.mini-board .sq.lm {
  background-image: linear-gradient(var(--lm), var(--lm));
}

.mini-board piece {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  transform: none;
  background-size: cover;
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @group-chess/miniapp exec vitest run test/avatar.test.tsx test/miniBoard.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/miniapp
git commit -m "feat(miniapp): avatars in Telegram's palette and a mini board thumbnail"
```

---

### Task 6: The game card: pill, shared clock tick and dimming

**Files:**
- Create: `apps/miniapp/src/ui/pill.ts`, `apps/miniapp/src/ui/useNow.ts`, `apps/miniapp/src/ui/GameCard.tsx`
- Modify: `packages/shared/src/i18n/en.ts`
- Modify: `apps/miniapp/src/styles.css`
- Create: `apps/miniapp/test/pill.test.ts`, `apps/miniapp/test/gameCard.test.tsx`

**Interfaces:**
- Consumes: `Avatar` (Task 5), `MiniBoard` (Task 5), `gameSummary`/`playerRef` fixtures (Task 1), `remainingMs`/`isUrgent` (`state/clock.ts`), `serverNow`/`session` (`state/session.ts`), `termsLabel` (`ui/format.ts`).
- Produces: `type Pill = { kind: 'yours' | 'urgent' | 'other'; text: string }`, `pillFor(game: GameSummary, viewerId: string | null, now: Date): Pill`, `outcomeFor(result, endReason, voided, role): string` in `ui/pill.ts`.
- Produces: `useNow(active: boolean): Date` in `ui/useNow.ts`.
- Produces: `<GameCard game={GameSummary} onOpen={(id: string) => void} context?={string} />` rendering `button.game-card[data-game]` (`.dim` unless it is the viewer's move).

- [ ] **Step 1: Add the copy**

`en.ts`, after `'app.lobby.void_badge'`:

```ts
  'app.card.your_move_clock': 'Your move · {clock}',
  'app.card.your_move_left': 'Your move · {clock} left',
  'app.card.to_move_clock': '{name} to move · {clock}',
  'app.card.watching': 'Watching',
```

- [ ] **Step 2: Write the failing tests**

`test/pill.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { pillFor } from '../src/ui/pill';
import { gameSummary, playerRef } from './support/summaryFixtures';

const now = new Date('2026-09-20T12:00:00.000Z');
const inHours = (hours: number) => new Date(now.getTime() + hours * 3_600_000).toISOString();

describe('pillFor', () => {
  it('counts down your move', () => {
    expect(pillFor(gameSummary({ deadlineAt: inHours(5) }), '1', now)).toEqual({
      kind: 'yours',
      text: 'Your move · 5:00:00',
    });
  });

  it('turns urgent near the deadline', () => {
    expect(pillFor(gameSummary({ deadlineAt: inHours(1) }), '1', now)).toEqual({
      kind: 'urgent',
      text: 'Your move · 1:00:00 left',
    });
  });

  it('never goes below zero once the deadline has passed', () => {
    expect(pillFor(gameSummary({ deadlineAt: inHours(-2) }), '1', now)).toEqual({
      kind: 'urgent',
      text: 'Your move · 0:00 left',
    });
  });

  it('says just "Your move" without a clock', () => {
    expect(pillFor(gameSummary({ timePerMove: null }), '1', now)).toEqual({
      kind: 'yours',
      text: 'Your move',
    });
  });

  it('names who is to move otherwise', () => {
    const theirs = gameSummary({ yourTurn: false, sideToMove: 'black', deadlineAt: inHours(26) });
    expect(pillFor(theirs, '1', now)).toEqual({ kind: 'other', text: 'Bob to move · 1d 2:00' });
    const untimed = gameSummary({ yourTurn: false, sideToMove: 'black', timePerMove: null });
    expect(pillFor(untimed, '1', now).text).toBe('Bob to move · No clock');
  });

  it('gives a finished game’s result from the viewer’s side', () => {
    const won = gameSummary({
      status: 'finished',
      yourTurn: false,
      result: '1-0',
      endReason: 'checkmate',
    });
    expect(pillFor(won, '1', now)).toEqual({ kind: 'other', text: 'You won · Checkmate · 1-0' });
    expect(pillFor(won, '3', now).text).toBe('White won · Checkmate · 1-0');
    const voided = gameSummary({ status: 'finished', yourTurn: false, voided: true, result: '1-0' });
    expect(pillFor(voided, '1', now).text).toBe('Voided');
  });

  it('reads the bot’s side like anyone else’s', () => {
    const bot = gameSummary({
      black: playerRef('9', 'Stockfish', { isBot: true }),
      yourTurn: false,
      sideToMove: 'black',
      timePerMove: null,
    });
    expect(pillFor(bot, '1', now).text).toBe('Stockfish to move · No clock');
  });
});
```

`test/gameCard.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import { GameCard } from '../src/ui/GameCard';
import { AFTER_E4 } from './support/gameFixtures';
import { renderApp } from './support/render';
import { gameSummary, playerRef } from './support/summaryFixtures';

const mount = (game: ReturnType<typeof gameSummary>, context?: string) => {
  const opened: string[] = [];
  const r = renderApp(
    () => <GameCard game={game} context={context} onOpen={(id) => opened.push(id)} />,
    () => ({ status: 200, body: {} }),
  );
  return { r, opened };
};

describe('GameCard', () => {
  it('shows the opponent, the group, the terms and a gold pill on your move', async () => {
    const { r, opened } = mount(gameSummary({ fen: AFTER_E4, lastMove: 'e2e4' }), 'Chess Club');
    await r.flush();
    const card = r.root.querySelector<HTMLElement>('[data-game="GameAaaaaa"]')!;
    expect(card.className).not.toContain('dim');
    expect(card.querySelector('.name')!.textContent).toBe('Bob');
    expect(card.querySelector('.rating')!.textContent).toBe('1500?');
    expect(r.text()).toContain('Chess Club');
    expect(r.text()).toContain('1 day per move · Rated');
    expect(card.querySelector('.pill')!.className).toBe('pill yours');
    expect(card.querySelectorAll('.mini-board .lm')).toHaveLength(2);
    await r.click('[data-game="GameAaaaaa"]');
    expect(opened).toEqual(['GameAaaaaa']);
  });

  it('dims a game that is waiting on someone else', async () => {
    const { r } = mount(gameSummary({ yourTurn: false, sideToMove: 'black' }));
    await r.flush();
    expect(r.root.querySelector('.game-card')!.className).toContain('dim');
  });

  it('turns the board for black and names both sides for a spectator', async () => {
    const asBlack = mount(gameSummary({ white: playerRef('2', 'Bob'), black: playerRef('1', 'Alice') }));
    await asBlack.r.flush();
    expect(asBlack.r.root.querySelector('[data-square]')!.getAttribute('data-square')).toBe('h1');

    const watching = mount(
      gameSummary({ white: playerRef('3', 'Carol'), black: playerRef('4', 'Dan'), yourTurn: false }),
    );
    await watching.r.flush();
    expect(watching.r.root.querySelector('.name')!.textContent).toBe('Carol vs Dan');
    expect(watching.r.root.querySelector('.tag')!.textContent).toBe('Watching');
  });

  it('shows the bot with its level instead of a rating', async () => {
    const { r } = mount(
      gameSummary({ black: playerRef('9', 'Stockfish', { isBot: true }), engineLevel: 'club' }),
    );
    await r.flush();
    expect(r.root.querySelector('.rating')!.textContent).toBe('Club');
    expect(r.root.querySelector('img.avatar.bot')).not.toBeNull();
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm --filter @group-chess/miniapp exec vitest run test/pill.test.ts test/gameCard.test.tsx`
Expected: FAIL (modules missing).

- [ ] **Step 4: Implement the pill**

`src/ui/pill.ts`:

```ts
import {
  endReasonLabel,
  formatClock,
  resultLabel,
  t,
  type Colour,
  type EndReason,
  type GameResult,
  type GameSummary,
} from '@group-chess/shared';
import { isUrgent, remainingMs } from '../state/clock';

export type Pill = { kind: 'yours' | 'urgent' | 'other'; text: string };

function roleOf(game: GameSummary, viewerId: string | null): Colour | null {
  if (viewerId === null) return null;
  if (game.white.id === viewerId) return 'white';
  if (game.black.id === viewerId) return 'black';
  return null;
}

/** "You won · Checkmate · 1-0" from a player's side, "White won · …" for anyone else. */
export function outcomeFor(
  result: GameResult | null,
  endReason: EndReason | null,
  voided: boolean,
  role: Colour | null,
): string {
  if (voided) return t('app.game.voided');
  let outcome: string;
  if (!result || result === '*') outcome = t('app.game.result.aborted');
  else if (result === '1/2-1/2') outcome = t('app.game.result.draw');
  else {
    const winner = result === '1-0' ? 'white' : 'black';
    outcome =
      role === null
        ? t(`app.game.result.${winner}`)
        : t(role === winner ? 'app.game.result.win' : 'app.game.result.loss');
  }
  const parts = [outcome];
  if (endReason) parts.push(endReasonLabel(endReason));
  if (result && result !== '*') parts.push(resultLabel(result));
  return parts.join(' · ');
}

/** The status line of a game row (redesign spec §3.1 Pill). */
export function pillFor(game: GameSummary, viewerId: string | null, now: Date): Pill {
  if (game.status === 'finished')
    return {
      kind: 'other',
      text: outcomeFor(game.result, game.endReason, game.voided, roleOf(game, viewerId)),
    };
  const remaining = remainingMs(game.deadlineAt, now);
  if (game.yourTurn) {
    if (game.timePerMove === null || remaining === null)
      return { kind: 'yours', text: t('app.lobby.your_move') };
    const clock = formatClock(remaining);
    return isUrgent(remaining, game.timePerMove)
      ? { kind: 'urgent', text: t('app.card.your_move_left', { clock }) }
      : { kind: 'yours', text: t('app.card.your_move_clock', { clock }) };
  }
  const mover = game.sideToMove === 'white' ? game.white.name : game.black.name;
  const clock =
    game.timePerMove === null
      ? t('app.game.no_clock')
      : formatClock(remaining ?? game.timePerMove * 1000);
  return { kind: 'other', text: t('app.card.to_move_clock', { name: mover, clock }) };
}
```

(`EndReason` and `GameResult` are exported from `@group-chess/shared`'s enums; if a name differs, use the one `GameSummarySchema` infers.)

- [ ] **Step 5: Implement the shared tick and the card**

`src/ui/useNow.ts`:

```ts
import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { serverNow } from '../state/session';

const now = signal(serverNow());
let subscribers = 0;
let timer: ReturnType<typeof setInterval> | null = null;

/**
 * The server's `now`, re-read once a second while any mounted caller is active. Every row of a
 * list shares one interval, and it stops when the last ticking row goes away.
 */
export function useNow(active: boolean): Date {
  useEffect(() => {
    if (!active) return;
    subscribers += 1;
    if (subscribers === 1) {
      now.value = serverNow();
      timer = setInterval(() => (now.value = serverNow()), 1_000);
    }
    return () => {
      subscribers -= 1;
      if (subscribers === 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  }, [active]);
  return now.value;
}
```

`src/ui/GameCard.tsx`:

```tsx
import { ratingLabel, t, type GameSummary } from '@group-chess/shared';
import { session } from '../state/session';
import { Avatar } from './Avatar';
import { termsLabel } from './format';
import { MiniBoard } from './MiniBoard';
import { pillFor } from './pill';
import { useNow } from './useNow';

/** One game in a list: thumbnail, opponent, terms and status (redesign spec §3.1). */
export function GameCard(props: {
  game: GameSummary;
  onOpen: (id: string) => void;
  /** The group's title, on lists that span groups. */
  context?: string;
}) {
  const { game } = props;
  const viewerId = session.value?.user.id ?? null;
  const role = game.white.id === viewerId ? 'white' : game.black.id === viewerId ? 'black' : null;
  const now = useNow(game.status === 'active' && game.deadlineAt !== null);
  const pill = pillFor(game, viewerId, now);
  const opponent = role === null ? null : game[role === 'white' ? 'black' : 'white'];
  const yours = game.status === 'active' && game.yourTurn;
  const rating = opponent
    ? opponent.isBot
      ? game.engineLevel
        ? t(`app.level.${game.engineLevel}`)
        : ''
      : ratingLabel(opponent.rating, opponent.provisional)
    : '';
  return (
    <button
      class={yours ? 'game-card' : 'game-card dim'}
      data-game={game.id}
      onClick={() => props.onOpen(game.id)}
    >
      <MiniBoard
        fen={game.fen}
        lastMove={game.lastMove}
        orientation={role === 'black' ? 'black' : 'white'}
      />
      <span class="grow">
        <span class="who">
          <Avatar player={opponent ?? game.white} size={22} />
          <span class="name">
            {opponent ? opponent.name : `${game.white.name} vs ${game.black.name}`}
          </span>
          {rating ? <span class="rating">{rating}</span> : null}
          {role === null ? <span class="tag">{t('app.card.watching')}</span> : null}
          {game.voided ? <span class="tag">{t('app.lobby.void_badge')}</span> : null}
        </span>
        {props.context ? <span class="meta">{props.context}</span> : null}
        <span class="meta">{termsLabel(game.timePerMove, game.rated)}</span>
        <span class={`pill ${pill.kind}`}>{pill.text}</span>
      </span>
      <span class="chevron" aria-hidden="true">
        ›
      </span>
    </button>
  );
}
```

- [ ] **Step 6: Style it**

Append to `styles.css`:

```css
.game-card {
  display: flex;
  gap: 12px;
  align-items: center;
  width: 100%;
  padding: 12px 14px;
  border: 0;
  border-top: 1px solid var(--sep);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
}

.card > .game-card:first-child {
  border-top: 0;
}

.game-card .grow {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.game-card .who {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}

.game-card .name {
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.game-card .meta {
  font-size: 13px;
  line-height: 1.35;
  color: var(--hint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.rating {
  color: var(--hint);
  font-size: 13px;
  font-weight: 400;
  white-space: nowrap;
}

.tag {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--page);
  color: var(--hint);
  white-space: nowrap;
}

.pill {
  align-self: flex-start;
  font-size: 13px;
  font-weight: 500;
  color: var(--hint);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.pill.yours,
.pill.urgent {
  padding: 4px 10px;
  border-radius: 999px;
  font-weight: 700;
}

.pill.yours {
  background: var(--move);
  color: var(--move-ink);
}

.pill.urgent {
  background: var(--urgent);
  color: #fff;
}

.game-card.dim .mini-board {
  opacity: 0.45;
  filter: grayscale(0.7);
}

.game-card.dim .avatar {
  opacity: 0.55;
}

.game-card.dim .name {
  color: var(--hint);
}
```

- [ ] **Step 7: Run the tests**

Run: `pnpm --filter @group-chess/miniapp exec vitest run test/pill.test.ts test/gameCard.test.tsx`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/miniapp packages/shared/src/i18n/en.ts
git commit -m "feat(miniapp): game cards with a thumbnail, a live status pill and dimming"
```

---

### Task 7: Games home and Groups

**Files:**
- Modify: `apps/miniapp/src/ui/screens/Games.tsx`, `apps/miniapp/src/ui/screens/Groups.tsx`
- Modify: `packages/shared/src/i18n/en.ts`
- Modify: `apps/miniapp/src/styles.css`
- Modify: `apps/miniapp/test/games.test.tsx`
- Create: `apps/miniapp/test/groups.test.tsx`

**Interfaces:**
- Consumes: `GameCard` (Task 6), `GroupAvatar` (Task 5), `BRAND` (Task 3).

- [ ] **Step 1: Add the copy**

```ts
  'app.games.count.one': '1 game',
  'app.games.count.other': '{count} games',
  'app.games.summary': '{games} · {yourMove} your move',
```

- [ ] **Step 2: Write the failing tests**

Append to `describe('Games', …)` in `test/games.test.tsx`:

```ts
  it('heads the list with the goat and a count of what is waiting', async () => {
    const r = renderApp(
      (app) => {
        app.prefetched.games = games;
        return <Games />;
      },
      () => ({ status: 200, body: games }),
    );
    await r.flush();
    expect(r.root.querySelector('img.goat-mark')?.getAttribute('src')).toMatch(/goat-mark/);
    expect(r.root.querySelector('.section')?.textContent).toBe('2 games · 1 your move');
    expect(r.root.querySelector('[data-game="GameAaaaaa"]')?.className).toContain('dim');
    expect(r.root.querySelector('[data-game="GameBbbbbb"]')?.className).not.toContain('dim');
  });
```

`test/groups.test.tsx`:

```tsx
import type { MeGroupsDto } from '@group-chess/shared';
import { describe, expect, it } from 'vitest';
import { Groups } from '../src/ui/screens/Groups';
import { renderApp } from './support/render';

const groups: MeGroupsDto = {
  groups: [
    { id: 'GrOuPiDxYz', title: 'Friday Chess Club', activeGames: 4, yourMove: 2 },
    { id: 'OtHeRgRoUp', title: 'Family', activeGames: 1, yourMove: 0 },
  ],
};

describe('Groups', () => {
  it('lists each group with its initials, counts and a badge only when games wait on you', async () => {
    const r = renderApp(
      (app) => {
        app.router.land('groups', { name: 'groups' });
        return <Groups />;
      },
      () => ({ status: 200, body: groups }),
    );
    await r.flush();
    const [club, family] = [...r.root.querySelectorAll('[data-group]')];
    expect(club!.querySelector('.avatar.group')?.textContent).toBe('FC');
    expect(club!.textContent).toContain('4 active · 2 your move');
    expect(club!.querySelector('.count-badge')?.textContent).toBe('2');
    expect(family!.querySelector('.count-badge')).toBeNull();
    await r.click('[data-group="GrOuPiDxYz"]');
    expect(r.app.router.current.value).toEqual({ name: 'lobby', groupId: 'GrOuPiDxYz' });
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm --filter @group-chess/miniapp exec vitest run test/games.test.tsx test/groups.test.tsx`
Expected: FAIL (no `.goat-mark`, no `.count-badge`).

- [ ] **Step 4: Rewrite the two screens**

`src/ui/screens/Games.tsx` — keep the resource and badge-recount code; replace the returned JSX with:

```tsx
  const items = games.data.items;
  const waiting = items.filter((game) => game.yourTurn).length;
  return (
    <div class="screen">
      <header class="home-head">
        <img class="goat-mark" src={BRAND.markUrl} alt="" width={42} height={42} />
        <h1 class="title">{t('app.games.title')}</h1>
      </header>
      {items.length === 0 ? (
        <div class="card empty">
          <span>{t('app.games.empty')}</span>
          <button
            class="btn block"
            data-action="browse-groups"
            onClick={() => router.select('groups')}
          >
            {t('app.games.browse')}
          </button>
        </div>
      ) : (
        <>
          <div class="section">
            {t('app.games.summary', {
              games:
                items.length === 1
                  ? t('app.games.count.one')
                  : t('app.games.count.other', { count: items.length }),
              yourMove: waiting,
            })}
          </div>
          <div class="card">
            {items.map((game) => (
              <GameCard
                key={game.id}
                game={game}
                context={game.group.title}
                onOpen={(gameId) => router.push({ name: 'game', gameId })}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
```

(import `BRAND` from `'../../brand'` and `GameCard` from `'../GameCard'`; drop the `GameRow` import.)

`src/ui/screens/Groups.tsx` — replace the returned JSX with:

```tsx
  return (
    <div class="screen">
      <h1 class="title">{t('app.groups.title')}</h1>
      {groups.data.groups.length === 0 ? (
        <div class="card empty">{t('app.groups.empty')}</div>
      ) : (
        <div class="stack">
          {groups.data.groups.map((group) => (
            <button
              key={group.id}
              class="group-row"
              data-group={group.id}
              onClick={() => router.push({ name: 'lobby', groupId: group.id })}
            >
              <GroupAvatar group={group} size={48} />
              <span class="grow">
                <span class="primary">{group.title}</span>
                <span class="secondary">
                  {t('app.groups.summary', { active: group.activeGames, yourMove: group.yourMove })}
                </span>
              </span>
              {group.yourMove > 0 ? <span class="count-badge">{group.yourMove}</span> : null}
              <span class="chevron" aria-hidden="true">
                ›
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
```

- [ ] **Step 5: Style them**

```css
.home-head {
  display: flex;
  align-items: center;
  gap: 12px;
}

.goat-mark {
  width: 42px;
  height: 42px;
  flex: none;
  border-radius: 50%;
  object-fit: cover;
  object-position: 50% 30%;
  box-shadow: 0 0 0 2px var(--acc);
}

.stack {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.group-row {
  display: flex;
  align-items: center;
  gap: 14px;
  width: 100%;
  padding: 12px 14px;
  border: 0;
  border-radius: 18px;
  background: var(--card);
  color: inherit;
  font: inherit;
  text-align: left;
}

.group-row .primary {
  font-size: 17px;
}

.count-badge {
  min-width: 24px;
  height: 24px;
  padding: 0 7px;
  border-radius: 999px;
  background: var(--move);
  color: var(--move-ink);
  font-size: 13px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
}
```

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @group-chess/miniapp exec vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/miniapp packages/shared/src/i18n/en.ts
git commit -m "feat(miniapp): the Games home and Groups list in the Chess Goat design"
```

---

### Task 8: Lobby and Leaderboard

**Files:**
- Create: `apps/miniapp/src/state/lobby.ts`, `apps/miniapp/src/ui/icons.ts`, `apps/miniapp/src/ui/screens/Leaderboard.tsx`
- Modify: `apps/miniapp/src/ui/screens/Lobby.tsx`, `apps/miniapp/src/ui/rows.tsx`, `apps/miniapp/src/ui/TabBar.tsx`, `apps/miniapp/src/router.ts`, `apps/miniapp/src/ui/App.tsx`
- Modify: `packages/shared/src/i18n/en.ts`
- Modify: `apps/miniapp/src/styles.css`
- Create: `apps/miniapp/test/lobbyModel.test.ts`
- Modify: `apps/miniapp/test/lobby.test.tsx`

**Interfaces:**
- Consumes: `GameCard`, `Avatar`, `GroupAvatar`, `Segmented`, `session`.
- Produces: `type LobbyScope = 'mine' | 'all'`, `plays(game, viewerId): boolean`, `scopedGames(data: Pick<LobbyDto, 'active' | 'finished'>, scope, viewerId): { active: GameSummary[]; finished: GameSummary[] }`, `rankOf(players: LeaderboardEntry[], viewerId): { rank: number; entry: LeaderboardEntry } | null` in `state/lobby.ts`.
- Produces: route `{ name: 'leaderboard'; groupId: string }`; `LobbyTab` is removed from `router.ts`.
- Produces: `ChallengeCard({ challenge, viewerId, onAccept, onDecline, onCancel })`, `PlayerRow({ entry, rank, you, onOpen })` in `ui/rows.tsx`; `GEAR_PATH` in `ui/icons.ts`.

- [ ] **Step 1: Add the copy**

Replace `'app.lobby.tab.active'`, `'app.lobby.tab.finished'` and `'app.lobby.tab.players'` with:

```ts
  'app.lobby.active': 'Active',
  'app.lobby.finished': 'Finished',
  'app.lobby.scope.mine': 'Your games',
  'app.lobby.scope.all': 'Whole group',
  'app.lobby.active_count': '{count} active',
  'app.lobby.your_move_count': '{count} your move',
  'app.lobby.challenges_count': 'Challenges · {count}',
  'app.lobby.challenge.you': '{challenger} challenges you',
  'app.lobby.no_active_mine': 'None of your games are running here.',
  'app.lobby.no_finished_mine': "You haven't finished a game here yet.",
  'app.lobby.leaderboard': 'Leaderboard',
  'app.lobby.leaderboard_rating': 'Leaderboard · {rating}',
  'app.lobby.rank': '#{rank}',
  'app.lobby.rank_detail': '{record} · of {players}',
  'app.lobby.ranked.one': '1 ranked player',
  'app.lobby.ranked.other': '{count} ranked players',
  'app.leaderboard.title': 'Leaderboard',
  'app.leaderboard.subtitle': '{group} · rated games only',
  'app.leaderboard.you': '(you)',
```

- [ ] **Step 2: Write the failing model tests**

`test/lobbyModel.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { rankOf, scopedGames } from '../src/state/lobby';
import { gameSummary, playerRef } from './support/summaryFixtures';

const mine = gameSummary({ id: 'MineAaaaaa', yourTurn: false });
const mineWaiting = gameSummary({ id: 'MineBbbbbb', yourTurn: true });
const theirs = gameSummary({
  id: 'TheirsAaaa',
  white: playerRef('3', 'Carol'),
  black: playerRef('4', 'Dan'),
  yourTurn: false,
});
const data = {
  active: [mine, theirs, mineWaiting],
  finished: { items: [theirs, mine], nextCursor: null },
};

describe('scopedGames', () => {
  it('keeps only the viewer’s games in "mine", their move first', () => {
    const { active, finished } = scopedGames(data, 'mine', '1');
    expect(active.map((g) => g.id)).toEqual(['MineBbbbbb', 'MineAaaaaa']);
    expect(finished.map((g) => g.id)).toEqual(['MineAaaaaa']);
  });

  it('keeps everything in "all", the viewer’s move first', () => {
    const { active, finished } = scopedGames(data, 'all', '1');
    expect(active.map((g) => g.id)).toEqual(['MineBbbbbb', 'MineAaaaaa', 'TheirsAaaa']);
    expect(finished).toHaveLength(2);
  });
});

describe('rankOf', () => {
  const entry = (id: string) => ({
    ...playerRef(id, id),
    gamesPlayed: 6,
    record: { wins: 3, draws: 1, losses: 2 },
  });

  it('finds the viewer’s 1-based rank', () => {
    expect(rankOf([entry('5'), entry('1')], '1')).toMatchObject({ rank: 2, entry: { id: '1' } });
  });

  it('is null when the viewer is not on the board', () => {
    expect(rankOf([entry('5')], '1')).toBeNull();
    expect(rankOf([entry('5')], null)).toBeNull();
  });
});
```

- [ ] **Step 3: Rewrite the lobby screen tests**

Replace the `lobby` fixture and the `describe('Lobby', …)` block of `test/lobby.test.tsx` with the version below (keep the imports, adding `App` from `'../src/ui/App'`, `Leaderboard` from `'../src/ui/screens/Leaderboard'`, and `gameSummary`, `playerRef` from `./support/summaryFixtures`):

```tsx
const watching = gameSummary({
  id: 'GameWwwwww',
  white: playerRef('3', 'Carol'),
  black: playerRef('4', 'Dan'),
  yourTurn: false,
});

const board = (ids: string[]) =>
  ids.map((id, index) => ({
    ...playerRef(id, id === '1' ? 'Alice' : `P${id}`),
    rating: 1600 - index * 10,
    provisional: false,
    gamesPlayed: 9,
    record: { wins: 5, draws: 1, losses: 3 },
  }));

const lobby: LobbyDto = {
  group: { id: 'GrOuPiDxYz', title: 'Chess Club' },
  isAdmin: true,
  settings: { defaultTimePerMove: 86400, ratedDefault: true, allowOpenChallenges: true },
  active: [summary('GameAaaaaa', false), summary('GameBbbbbb', true), watching],
  finished: { items: [summary('GameCccccc', false, 'finished')], nextCursor: null },
  challenges: [
    {
      id: 'ChalAaaaaa',
      challenger: ref('2', 'Bob'),
      opponent: ref('1', 'Alice'),
      timePerMove: 86400,
      challengerColour: 'random',
      rated: true,
      status: 'pending',
      createdAt: '2026-09-20T10:00:00.000Z',
      expiresAt: '2026-09-21T10:00:00.000Z',
      viewer: { canAccept: true, canDecline: true, canCancel: false },
    },
  ],
  players: board(['2', '1', '5']),
};

const open = (data: LobbyDto, route?: Parameters<typeof renderApp>[1]) =>
  renderApp(
    (app) => {
      app.prefetched.lobby = data;
      app.router.land('groups', { name: 'lobby', groupId: 'GrOuPiDxYz' });
      return <App />;
    },
    route ?? (() => ({ status: 200, body: data })),
  );
const ids = (root: HTMLElement) =>
  [...root.querySelectorAll('[data-game]')].map((el) => el.getAttribute('data-game'));

describe('Lobby', () => {
  it('heads the lobby with the group, its counts and the admin gear', async () => {
    const r = open(lobby);
    await r.flush();
    expect(r.calls).toHaveLength(0);
    expect(r.root.querySelector('.title')?.textContent).toBe('Chess Club');
    expect(r.root.querySelector('.avatar.group')?.textContent).toBe('CC');
    expect(r.text()).toContain('3 active · 1 your move');
    expect(r.root.querySelector('[data-action="group-settings"]')).not.toBeNull();
    expect(r.text()).toContain('Bob challenges you');
  });

  it('shows your games first and the whole group on request', async () => {
    const r = open(lobby);
    await r.flush();
    expect(ids(r.root)).toEqual(['GameBbbbbb', 'GameAaaaaa', 'GameCccccc']);
    await r.click('[data-scope="all"]');
    expect(ids(r.root)).toEqual(['GameBbbbbb', 'GameAaaaaa', 'GameWwwwww', 'GameCccccc']);
    expect(r.root.querySelector('[data-game="GameWwwwww"] .tag')?.textContent).toBe('Watching');
    expect(window.__tg!.haptics).toContain('selection');
  });

  it('ranks the viewer on the leaderboard chip and opens the leaderboard', async () => {
    const r = open(lobby);
    await r.flush();
    const chip = r.root.querySelector('[data-action="leaderboard"]')!;
    expect(chip.textContent).toContain('#2');
    expect(chip.textContent).toContain('Leaderboard · 1590');
    expect(chip.textContent).toContain('5 W · 1 D · 3 L · of 3 ranked players');
    await r.click('[data-action="leaderboard"]');
    expect(r.app.router.current.value).toEqual({ name: 'leaderboard', groupId: 'GrOuPiDxYz' });
  });

  it('offers a plain chip when the viewer is not ranked, and none on an empty board', async () => {
    const unranked = open({ ...lobby, players: board(['2']) });
    await unranked.flush();
    const chip = unranked.root.querySelector('[data-action="leaderboard"]')!;
    expect(chip.textContent).not.toContain('#');
    expect(chip.textContent).toContain('1 ranked player');
    const empty = open({ ...lobby, players: [] });
    await empty.flush();
    expect(empty.root.querySelector('[data-action="leaderboard"]')).toBeNull();
  });

  it('says you have no finished games only once every page is loaded', async () => {
    const othersOnly = { items: [{ ...watching, status: 'finished' as const }], nextCursor: 'c1' };
    const paged = open({ ...lobby, finished: othersOnly });
    await paged.flush();
    expect(paged.text()).not.toContain("You haven't finished a game here yet.");
    expect(paged.root.querySelector('[data-action="more"]')).not.toBeNull();
    const done = open({ ...lobby, finished: { ...othersOnly, nextCursor: null } });
    await done.flush();
    expect(done.text()).toContain("You haven't finished a game here yet.");
  });

  it('tells the user when the next page of finished games cannot be loaded', async () => {
    const paged = { ...lobby, finished: { ...lobby.finished, nextCursor: 'c1' } };
    const r = open(paged, ({ path }) =>
      path.includes('/finished?cursor=')
        ? { status: 500, body: { error: { code: 'internal', message: 'boom' } } }
        : { status: 200, body: paged },
    );
    await r.flush();
    await r.click('[data-action="more"]');
    expect(r.calls.at(-1)?.path).toBe('/api/groups/GrOuPiDxYz/finished?cursor=c1');
    expect(document.querySelector('.toast')?.textContent).toBe('Something went wrong');
    expect(r.root.querySelector<HTMLButtonElement>('[data-action="more"]')?.disabled).toBe(false);
  });

  it('accepts a challenge through the API and opens the game', async () => {
    const r = renderApp(
      () => <Lobby groupId="GrOuPiDxYz" />,
      ({ path, method }) =>
        method === 'POST' && path === '/api/challenges/ChalAaaaaa/accept'
          ? { status: 200, body: gameDto({ id: 'GameNnnnnn' }) }
          : { status: 200, body: lobby },
    );
    await r.flush();
    expect(r.calls.map((c) => c.path)).toEqual(['/api/groups/GrOuPiDxYz']);
    await r.click('[data-accept="ChalAaaaaa"]');
    expect(r.calls.at(-1)?.path).toBe('/api/challenges/ChalAaaaaa/accept');
    expect(r.app.router.current.value).toEqual({ name: 'game', gameId: 'GameNnnnnn' });
    expect(r.app.prefetched.game?.id).toBe('GameNnnnnn');
  });

  it('opens a game row and the new game screen', async () => {
    const r = renderApp(
      () => <Lobby groupId="GrOuPiDxYz" />,
      () => ({ status: 200, body: lobby }),
    );
    await r.flush();
    await r.click('[data-game="GameAaaaaa"]');
    expect(r.app.router.current.value).toEqual({ name: 'game', gameId: 'GameAaaaaa' });
    r.app.router.back();
    await r.click('[data-action="new-game"]');
    expect(r.app.router.current.value).toMatchObject({ name: 'newGame', groupId: 'GrOuPiDxYz' });
  });
});

describe('Leaderboard', () => {
  it('ranks the group, marks you, and opens a player', async () => {
    const r = renderApp(
      (app) => {
        app.router.land('groups', { name: 'leaderboard', groupId: 'GrOuPiDxYz' });
        return <Leaderboard groupId="GrOuPiDxYz" />;
      },
      () => ({ status: 200, body: lobby }),
    );
    await r.flush();
    expect(r.calls.map((c) => c.path)).toEqual(['/api/groups/GrOuPiDxYz']);
    expect(r.root.querySelector('.subtitle')?.textContent).toBe('Chess Club · rated games only');
    const rows = [...r.root.querySelectorAll('[data-player]')];
    expect(rows.map((row) => row.getAttribute('data-player'))).toEqual(['2', '1', '5']);
    expect(rows[0]!.querySelector('.rank')?.className).toContain('first');
    expect(rows[1]!.className).toContain('you');
    expect(rows[1]!.textContent).toContain('(you)');
    await r.click('[data-player="5"]');
    expect(r.app.router.current.value).toEqual({
      name: 'player',
      groupId: 'GrOuPiDxYz',
      userId: '5',
    });
  });
});
```

- [ ] **Step 4: Run them to see them fail**

Run: `pnpm --filter @group-chess/miniapp exec vitest run test/lobbyModel.test.ts test/lobby.test.tsx`
Expected: FAIL (modules and route missing, old markup).

- [ ] **Step 5: Implement the model, the route and the icon**

`src/state/lobby.ts`:

```ts
import type { GameSummary, LeaderboardEntry, LobbyDto } from '@group-chess/shared';

/** The lobby's two views: the viewer's own games, or everything in the group. */
export type LobbyScope = 'mine' | 'all';

export function plays(game: GameSummary, viewerId: string | null): boolean {
  return viewerId !== null && (game.white.id === viewerId || game.black.id === viewerId);
}

/** The lists for a scope; active games waiting on the viewer come first (PRD §8.2). */
export function scopedGames(
  data: Pick<LobbyDto, 'active' | 'finished'>,
  scope: LobbyScope,
  viewerId: string | null,
): { active: GameSummary[]; finished: GameSummary[] } {
  const keep = (game: GameSummary) => scope === 'all' || plays(game, viewerId);
  const active = data.active
    .filter(keep)
    .sort((a, b) => Number(b.yourTurn) - Number(a.yourTurn));
  return { active, finished: data.finished.items.filter(keep) };
}

/** The viewer's place on the leaderboard, from 1; null when they are not on it. */
export function rankOf(
  players: LeaderboardEntry[],
  viewerId: string | null,
): { rank: number; entry: LeaderboardEntry } | null {
  const index = viewerId === null ? -1 : players.findIndex((entry) => entry.id === viewerId);
  return index < 0 ? null : { rank: index + 1, entry: players[index]! };
}
```

`src/ui/icons.ts`:

```ts
/** The cog: the Settings tab and the lobby's group-settings button. */
export const GEAR_PATH =
  'M19.4 13a7.6 7.6 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-1.7-1L15 3.4h-4l-.3 2.6c-.6.25-1.2.6-1.7 1l-2.4-1-2 3.4L6.6 11a7.6 7.6 0 0 0 0 2l-2 1.6 2 3.4 2.4-1c.5.4 1.1.75 1.7 1l.3 2.6h4l.3-2.6c.6-.25 1.2-.6 1.7-1l2.4 1 2-3.4-2-1.6ZM12 15.2a3.2 3.2 0 1 1 0-6.4 3.2 3.2 0 0 1 0 6.4Z';
```

In `TabBar.tsx` use `d={GEAR_PATH}` for the settings icon.

`src/router.ts`: delete `export type LobbyTab …`; add `| { name: 'leaderboard'; groupId: string }` to `Route`. `src/ui/App.tsx`: import `Leaderboard` and add

```tsx
    case 'leaderboard':
      return <Leaderboard key={route.groupId} groupId={route.groupId} />;
```

- [ ] **Step 6: Implement the rows and the two screens**

`src/ui/rows.tsx` — replace `ChallengeRow` and `PlayerRow` (leave `GameRow` for Task 12):

```tsx
export function ChallengeCard(props: {
  challenge: ChallengeDto;
  viewerId: string | null;
  onAccept: (id: string) => void;
  onDecline: (id: string) => void;
  onCancel: (id: string) => void;
}) {
  const { challenge } = props;
  const challenger = challenge.challenger.name;
  const line =
    challenge.opponent === null
      ? t('app.lobby.challenge.open', { challenger })
      : challenge.opponent.id === props.viewerId
        ? t('app.lobby.challenge.you', { challenger })
        : t('app.lobby.challenge.direct', { challenger, opponent: challenge.opponent.name });
  return (
    <div class="challenge">
      <div class="challenge-who">
        <Avatar player={challenge.challenger} size={40} />
        <span class="grow">
          <span class="primary">{line}</span>
          <span class="secondary">{termsLabel(challenge.timePerMove, challenge.rated)}</span>
        </span>
      </div>
      <div class="challenge-actions">
        {challenge.viewer.canAccept ? (
          <button
            class="pill-btn primary"
            data-accept={challenge.id}
            onClick={() => props.onAccept(challenge.id)}
          >
            {t('button.accept')}
          </button>
        ) : null}
        {challenge.viewer.canDecline ? (
          <button
            class="pill-btn"
            data-decline={challenge.id}
            onClick={() => props.onDecline(challenge.id)}
          >
            {t('button.decline')}
          </button>
        ) : null}
        {challenge.viewer.canCancel ? (
          <button
            class="pill-btn"
            data-cancel={challenge.id}
            onClick={() => props.onCancel(challenge.id)}
          >
            {t('button.cancel')}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function PlayerRow(props: {
  entry: LeaderboardEntry;
  rank: number;
  you: boolean;
  onOpen: (id: string) => void;
}) {
  const { entry } = props;
  return (
    <button
      class={props.you ? 'player-row you' : 'player-row'}
      data-player={entry.id}
      onClick={() => props.onOpen(entry.id)}
    >
      <span class={props.rank === 1 ? 'rank first' : 'rank'}>{props.rank}</span>
      <Avatar player={entry} size={40} />
      <span class="grow">
        <span class="primary">
          {entry.name}
          {props.you ? ` ${t('app.leaderboard.you')}` : ''}{' '}
          <span class="rating">{ratingLabel(entry.rating, entry.provisional)}</span>
        </span>
        <span class="secondary">{t('app.player.record', entry.record)}</span>
      </span>
      <span class="hint">{t('app.player.games', { count: entry.gamesPlayed })}</span>
    </button>
  );
}
```

(import `Avatar` from `'./Avatar'`, `ratingLabel` from the shared package; `playerLabel` stays exported from `format.ts` for GroupSettings.)

`src/ui/screens/Lobby.tsx` — keep `lobby` resource, `act`, `accept`, `more` exactly; remove `TABS`, `byYourMoveFirst`, the `tab` state and the old imports of `LobbyTab`, `GameRow`, `ChallengeRow`, `PlayerRow`. Add:

```tsx
  const [scope, setScope] = useState<LobbyScope>('mine');
  // …after `if (!data) return <Loading />;`
  const viewerId = session.value?.user.id ?? null;
  const { active, finished } = scopedGames(data, scope, viewerId);
  const waiting = data.active.filter((game) => game.yourTurn).length;
  const ranked = rankOf(data.players, viewerId);
  const rankedPlayers =
    data.players.length === 1
      ? t('app.lobby.ranked.one')
      : t('app.lobby.ranked.other', { count: data.players.length });
```

and return:

```tsx
    <div class="screen">
      <header class="lobby-head">
        <GroupAvatar group={data.group} size={56} />
        <div class="grow">
          <h1 class="title">{data.group.title}</h1>
          <p class="subtitle">
            {t('app.lobby.active_count', { count: data.active.length })} ·{' '}
            <span class="move-text">{t('app.lobby.your_move_count', { count: waiting })}</span>
          </p>
        </div>
        {data.isAdmin ? (
          <button
            class="icon-btn"
            data-action="group-settings"
            aria-label={t('app.lobby.settings')}
            onClick={() => router.push({ name: 'groupSettings', groupId: props.groupId })}
          >
            <svg class="icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path fill-rule="evenodd" d={GEAR_PATH} />
            </svg>
          </button>
        ) : null}
      </header>
      {data.players.length > 0 ? (
        <button
          class="chip-row"
          data-action="leaderboard"
          onClick={() => router.push({ name: 'leaderboard', groupId: props.groupId })}
        >
          {ranked ? <span class="rank">{t('app.lobby.rank', { rank: ranked.rank })}</span> : null}
          <span class="grow">
            <span class="primary">
              {ranked
                ? t('app.lobby.leaderboard_rating', {
                    rating: ratingLabel(ranked.entry.rating, ranked.entry.provisional),
                  })
                : t('app.lobby.leaderboard')}
            </span>
            <span class="secondary">
              {ranked
                ? t('app.lobby.rank_detail', {
                    record: t('app.player.record', ranked.entry.record),
                    players: rankedPlayers,
                  })
                : rankedPlayers}
            </span>
          </span>
          <span class="chevron" aria-hidden="true">
            ›
          </span>
        </button>
      ) : null}
      <button
        class="btn block"
        data-action="new-game"
        onClick={() =>
          router.push({ name: 'newGame', groupId: props.groupId, defaults: data.settings })
        }
      >
        {t('app.lobby.new_game')}
      </button>
      {data.challenges.length > 0 ? (
        <>
          <div class="section">
            {t('app.lobby.challenges_count', { count: data.challenges.length })}
          </div>
          <div class="card">
            {data.challenges.map((challenge) => (
              <ChallengeCard
                key={challenge.id}
                challenge={challenge}
                viewerId={viewerId}
                onAccept={(id) => void accept(id)}
                onDecline={(id) => void act(`/api/challenges/${id}/decline`, lobby.reload)}
                onCancel={(id) => void act(`/api/challenges/${id}/cancel`, lobby.reload)}
              />
            ))}
          </div>
        </>
      ) : null}
      <Segmented
        value={scope}
        onChange={setScope}
        options={[
          { value: 'mine', label: t('app.lobby.scope.mine'), 'data-scope': 'mine' },
          { value: 'all', label: t('app.lobby.scope.all'), 'data-scope': 'all' },
        ]}
      />
      <div class="section">{t('app.lobby.active')}</div>
      {active.length === 0 ? (
        <div class="card empty">
          {t(scope === 'mine' ? 'app.lobby.no_active_mine' : 'app.lobby.no_active')}
        </div>
      ) : (
        <div class="card">
          {active.map((game) => (
            <GameCard key={game.id} game={game} onOpen={openGame} />
          ))}
        </div>
      )}
      <div class="section">{t('app.lobby.finished')}</div>
      {finished.length > 0 ? (
        <div class="card">
          {finished.map((game) => (
            <GameCard key={game.id} game={game} onOpen={openGame} />
          ))}
        </div>
      ) : data.finished.nextCursor === null ? (
        <div class="card empty">
          {t(scope === 'mine' ? 'app.lobby.no_finished_mine' : 'app.lobby.no_finished')}
        </div>
      ) : null}
      {data.finished.nextCursor ? (
        <button
          class="btn secondary block"
          data-action="more"
          disabled={loadingMore}
          onClick={() => void more()}
        >
          {t('app.common.more')}
        </button>
      ) : null}
    </div>
```

`src/ui/screens/Leaderboard.tsx`:

```tsx
import { LobbyDtoSchema, t } from '@group-chess/shared';
import { session } from '../../state/session';
import { useApp } from '../context';
import { useResource } from '../hooks';
import { PlayerRow } from '../rows';
import { ErrorScreen, Loading } from './Status';

/** The group's rated table; it loads the lobby itself so it is always current (spec §3.3). */
export function Leaderboard(props: { groupId: string }) {
  const { client, router } = useApp();
  const lobby = useResource(`leaderboard:${props.groupId}`, () =>
    client.get(`/api/groups/${props.groupId}`, LobbyDtoSchema),
  );
  if (lobby.error) return <ErrorScreen onRetry={() => void lobby.reload()} />;
  if (!lobby.data) return <Loading />;
  const { group, players } = lobby.data;
  const viewerId = session.value?.user.id ?? null;
  return (
    <div class="screen">
      <div>
        <h1 class="title">{t('app.leaderboard.title')}</h1>
        <p class="subtitle">{t('app.leaderboard.subtitle', { group: group.title })}</p>
      </div>
      {players.length === 0 ? (
        <div class="card empty">{t('app.lobby.no_players')}</div>
      ) : (
        <div class="card">
          {players.map((entry, index) => (
            <PlayerRow
              key={entry.id}
              entry={entry}
              rank={index + 1}
              you={entry.id === viewerId}
              onOpen={(userId) => router.push({ name: 'player', groupId: props.groupId, userId })}
            />
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 7: Style them**

```css
.lobby-head {
  display: flex;
  align-items: center;
  gap: 14px;
}

.lobby-head .title {
  font-size: 26px;
}

.move-text {
  color: var(--move-text);
  font-weight: 600;
}

.icon-btn {
  width: 40px;
  height: 40px;
  flex: none;
  border: 0;
  border-radius: 50%;
  background: var(--card);
  color: var(--hint);
  display: flex;
  align-items: center;
  justify-content: center;
}

.icon-btn .icon {
  width: 22px;
  height: 22px;
  display: block;
}

.chip-row {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 10px 14px;
  border: 0;
  border-radius: 14px;
  background: var(--card);
  color: inherit;
  font: inherit;
  text-align: left;
}

.chip-row .rank {
  font: 22px/1 var(--display);
  color: var(--acc-text);
}

.chip-row .primary {
  font-size: 15px;
}

.challenge {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
  border-top: 1px solid var(--sep);
}

.card > .challenge:first-child {
  border-top: 0;
}

.challenge-who {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1 1 100%;
  min-width: 0;
}

.challenge-actions {
  display: flex;
  gap: 8px;
  padding-left: 52px;
}

.pill-btn {
  border: 0;
  padding: 9px 14px;
  border-radius: 999px;
  background: var(--card);
  color: var(--text);
  font-family: inherit;
  font-size: 14px;
  font-weight: 600;
}

.challenge .pill-btn:not(.primary) {
  background: var(--page);
}

.pill-btn.primary {
  background: var(--acc);
  color: var(--acc-ink);
  font-weight: 700;
}

.pill-btn.danger {
  color: var(--destructive);
}

.pill-btn:disabled {
  opacity: 0.5;
}

.player-row {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 11px 14px;
  border: 0;
  border-top: 1px solid var(--sep);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
}

.card > .player-row:first-child {
  border-top: 0;
}

.player-row.you {
  background: var(--acc-soft);
}

.player-row .rank {
  width: 22px;
  flex: none;
  text-align: center;
  font-weight: 700;
  color: var(--hint);
}

.player-row .rank.first {
  color: var(--move-text);
}

.player-row .hint {
  font-size: 13px;
  white-space: nowrap;
}
```

- [ ] **Step 8: Run the tests**

Run: `pnpm --filter @group-chess/miniapp exec vitest run`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/miniapp packages/shared/src/i18n/en.ts
git commit -m "feat(miniapp): the lobby's Your games / Whole group view and a Leaderboard page"
```

---

### Task 9: Game screen

**Files:**
- Modify: `apps/miniapp/src/ui/game/PlayerBar.tsx`, `apps/miniapp/src/ui/game/MoveList.tsx`, `apps/miniapp/src/ui/game/result.ts`, `apps/miniapp/src/ui/game/GameView.tsx`
- Modify: `packages/shared/src/i18n/en.ts`
- Modify: `apps/miniapp/src/styles.css`
- Modify: `apps/miniapp/test/game.test.tsx`

**Interfaces:**
- Consumes: `Avatar` (Task 5), `PlayerRef.isBot`.
- Produces: `resultDetail(dto: GameDto): string` in `ui/game/result.ts`; `.player-bar` keeps `data-colour`, adds `.yours`; clock classes `active`, `yours`, `urgent`; `.result-card > .result-title + .result-detail`; toolbar buttons are `.pill-btn` with `data-action` unchanged and Rematch first.

- [ ] **Step 1: Add the copy**

```ts
  'app.game.to_move': 'To move',
  'app.game.side_in_group': '{side} · {group}',
```

- [ ] **Step 2: Write the failing tests**

In `test/game.test.tsx`, change the finished-game test's two text expectations (`'You won · Checkmate'` and `'1500? → 1662?'`) to:

```ts
    expect(r.root.querySelector('.result-title')?.textContent).toBe('You won');
    expect(r.root.querySelector('.result-detail')?.textContent).toBe(
      'Checkmate · 0-1 · 1500? → 1662?',
    );
    expect(r.root.querySelector('.toolbar button')?.getAttribute('data-action')).toBe('rematch');
```

and append to `describe('Game', …)`:

```ts
  it('marks your bar and clock gold on your move, and names the waiting side', async () => {
    const r = mount(afterPlies(2, { viewerRole: 'white' }));
    await r.flush();
    const mine = r.root.querySelector('.player-bar[data-colour="white"]')!;
    const theirs = r.root.querySelector('.player-bar[data-colour="black"]')!;
    expect(mine.className).toContain('yours');
    expect(mine.querySelector('.sub')?.textContent).toBe('Your move');
    expect(mine.querySelector('.clock')?.className).toContain('yours');
    expect(theirs.className).not.toContain('yours');
    expect(theirs.querySelector('.sub')?.textContent).toBe('Black · Chess Club');
    expect(theirs.querySelector('.avatar')?.textContent).toBe('B');
  });

  it('shows the bot as the goat with its level', async () => {
    const bot = { ...gameDto().black, name: 'Stockfish', isBot: true };
    const r = mount(gameDto({ black: bot, engineLevel: 'club', timePerMove: null, deadlineAt: null }));
    await r.flush();
    const bar = r.root.querySelector('.player-bar[data-colour="black"]')!;
    expect(bar.querySelector('img.avatar.bot')).not.toBeNull();
    expect(bar.querySelector('.rating')?.textContent).toBe('Club');
  });
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm --filter @group-chess/miniapp exec vitest run test/game.test.tsx`
Expected: FAIL (no `.result-title`, no `.sub`, no avatar).

- [ ] **Step 4: Rewrite the player bar**

`src/ui/game/PlayerBar.tsx`:

```tsx
import { ratingLabel, t, type Colour, type GameDto } from '@group-chess/shared';
import { clockLabel, isUrgent, remainingMs } from '../../state/clock';
import { Avatar } from '../Avatar';

export function PlayerBar(props: { dto: GameDto; colour: Colour; now: Date }) {
  const { dto, colour } = props;
  const player = dto[colour];
  const toMove =
    dto.status === 'active' && (dto.fen.split(' ')[1] === 'b' ? 'black' : 'white') === colour;
  const yours = toMove && dto.viewerRole === colour;
  const remaining = toMove ? remainingMs(dto.deadlineAt, props.now) : null;
  const urgent = toMove && isUrgent(remaining, dto.timePerMove);
  const rating = player.isBot
    ? dto.engineLevel
      ? t(`app.level.${dto.engineLevel}`)
      : ''
    : ratingLabel(player.rating, player.provisional) +
      (dto.status === 'finished' && player.ratingAfter !== null && player.provisionalAfter !== null
        ? ` → ${ratingLabel(player.ratingAfter, player.provisionalAfter)}`
        : '');
  const sub = yours
    ? t('app.lobby.your_move')
    : toMove
      ? t('app.game.to_move')
      : t('app.game.side_in_group', { side: t(`colour.${colour}`), group: dto.group.title });
  const clockClass = ['clock', toMove && 'active', yours && 'yours', urgent && 'urgent']
    .filter(Boolean)
    .join(' ');
  return (
    <div class={yours ? 'player-bar yours' : 'player-bar'} data-colour={colour}>
      <span class={`ring ${colour}`}>
        <Avatar player={player} size={34} />
      </span>
      <span class="who">
        <span class="name">
          {player.name} {rating ? <span class="rating">{rating}</span> : null}
        </span>
        <span class={yours ? 'sub yours' : toMove ? 'sub to-move' : 'sub'}>{sub}</span>
      </span>
      {dto.status === 'active' ? (
        <span class={clockClass}>{clockLabel(remaining, dto.timePerMove, toMove)}</span>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 5: Result detail, move strip, actions**

`src/ui/game/result.ts` — add `resultLabel` to the import and:

```ts
/** The result card's second line: how it ended, the score, and the viewer's rating change. */
export function resultDetail(dto: GameDto): string {
  return [
    reasonForViewer(dto),
    dto.result && dto.result !== '*' ? resultLabel(dto.result) : null,
    ratingChangeFor(dto),
  ]
    .filter(Boolean)
    .join(' · ');
}
```

`src/ui/game/MoveList.tsx` — keep the strip scrolled to the newest move:

```tsx
import { t } from '@group-chess/shared';
import { useEffect, useRef } from 'preact/hooks';
import type { GameStore } from '../../state/game';

export function MoveList(props: { store: GameStore }) {
  const { store } = props;
  const moves = store.dto.value.moves;
  const viewing = store.position.value.ply;
  const strip = useRef<HTMLDivElement>(null);
  // A new move scrolls the strip to its end, unless the viewer is replaying an earlier one.
  useEffect(() => {
    const element = strip.current;
    if (element && store.isLatest.value) element.scrollLeft = element.scrollWidth;
  }, [moves.length]);
  if (moves.length === 0) return <p class="move-list hint">{t('app.game.no_moves')}</p>;
  return (
    <div class="move-list" ref={strip}>
      {/* …the existing children, unchanged */}
    </div>
  );
}
```

`src/ui/game/GameView.tsx`:
- import `resultDetail`;
- replace the `banner result` block with
  ```tsx
      {dto.status === 'finished' ? (
        <div class="result-card" role="status">
          <span class="result-title">
            {dto.voided ? t('app.game.voided') : resultForViewer(dto)}
          </span>
          {resultDetail(dto) ? <span class="result-detail">{resultDetail(dto)}</span> : null}
        </div>
      ) : null}
  ```
  and drop the now-unused `reasonForViewer`/`ratingChangeFor` imports;
- the incoming draw offer: Accept becomes `class="pill-btn primary"`, Decline `class="pill-btn"`;
- "Draw offered": `<div class="banner soft">`;
- the replay ◀ ▶ buttons: `class="pill-btn"`;
- in `.toolbar`: move the Rematch button to be the first child and give it `class="pill-btn primary"`; every `btn secondary` becomes `pill-btn`; every `btn danger` becomes `pill-btn danger`.

- [ ] **Step 6: Style it**

Replace the `.player-bar`, `.player-bar .name`, `.player-bar .rating`, `.clock*`, `.move-list*`, `.banner*`, `.toolbar*` rules in `styles.css` with:

```css
.game {
  gap: 0;
}

.player-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
}

.player-bar.yours {
  background: var(--move-soft);
}

.player-bar .ring {
  display: inline-flex;
  flex: none;
  border-radius: 50%;
  box-shadow:
    0 0 0 2px var(--page),
    0 0 0 3.5px #ffffff;
}

.player-bar .ring.black {
  box-shadow:
    0 0 0 2px var(--page),
    0 0 0 3.5px #2b2b2b;
}

.player-bar .who {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  line-height: 1.2;
}

.player-bar .name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.player-bar .rating {
  font-size: 14px;
}

.player-bar .sub {
  font-size: 12px;
  color: var(--hint);
}

.player-bar .sub.yours {
  color: var(--move-text);
  font-weight: 600;
}

.player-bar .sub.to-move {
  color: var(--acc-text);
  font-weight: 600;
}

.clock {
  font-variant-numeric: tabular-nums;
  padding: 6px 12px;
  border-radius: 10px;
  background: var(--card);
  color: var(--hint);
  font-weight: 700;
  min-width: 84px;
  text-align: center;
}

.clock.active {
  background: var(--acc-soft);
  color: var(--acc-text);
}

.clock.yours {
  background: var(--move);
  color: var(--move-ink);
}

.clock.urgent {
  background: var(--urgent);
  color: #fff;
}

.move-list {
  display: flex;
  gap: 2px;
  align-items: center;
  overflow-x: auto;
  white-space: nowrap;
  padding: 10px 16px 6px;
  scrollbar-width: none;
  font-size: 15px;
  font-variant-numeric: tabular-nums;
}

.move-list button {
  border: 0;
  background: transparent;
  color: inherit;
  padding: 3px 7px;
  border-radius: 8px;
  white-space: nowrap;
  font: inherit;
}

.move-list button[aria-current='true'] {
  background: var(--acc-soft);
  color: var(--acc-text);
  font-weight: 700;
}

.move-list .number {
  color: var(--hint);
  padding-left: 6px;
}

.result-card {
  margin: 6px 16px;
  padding: 14px;
  border-radius: 16px;
  background: var(--hero-bg);
  color: var(--hero-ink);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.result-title {
  font: 24px/1.15 var(--display);
}

.result-detail {
  font-size: 14px;
  color: var(--hero-sub);
}

.banner {
  margin: 6px 16px;
  padding: 10px 14px;
  border-radius: 14px;
  background: var(--card);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.banner .grow {
  flex: 1;
}

.banner.soft {
  background: var(--acc-soft);
  color: var(--acc-text);
  font-size: 14px;
  font-weight: 600;
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 6px 16px;
}
```

- [ ] **Step 7: Run the tests**

Run: `pnpm --filter @group-chess/miniapp exec vitest run`
Expected: PASS (the existing `'1d 0:00'` clock text is unchanged).

- [ ] **Step 8: Commit**

```bash
git add apps/miniapp packages/shared/src/i18n/en.ts
git commit -m "feat(miniapp): the game screen's player bars, move strip, result card and pill actions"
```

---

### Task 10: New game

**Files:**
- Modify: `apps/miniapp/src/ui/screens/NewGame.tsx`, `apps/miniapp/src/ui/controls.tsx`, `apps/miniapp/src/router.ts`
- Modify: `packages/shared/src/i18n/en.ts`
- Modify: `apps/miniapp/src/styles.css`
- Modify: `apps/miniapp/test/newGame.test.tsx`, `apps/miniapp/test/router.test.ts`

**Interfaces:**
- Consumes: `Avatar`, `BotMark` (Task 5); `Tg.setClosingConfirmation`, `Tg.hapticSelection` (Task 4).
- Produces: `Tile<V>` type and `<Tiles tiles columns={3 | 4} value onChange variant?={'solid' | 'soft'} />` in `controls.tsx`; `Router.showTabs` is false on `newGame`.

- [ ] **Step 1: Add the copy**

```ts
  'app.new.start': 'Start game',
  'app.new.bot_sub': 'Unrated · no clock',
  'app.new.open_sub': 'Anyone in the group can accept',
```

- [ ] **Step 2: Write the failing tests**

In `test/router.test.ts`:

```ts
  it('hides the tab bar on New game, where the MainButton owns the bottom edge', () => {
    const { router } = setup();
    router.land('groups', { name: 'lobby', groupId: 'GrOuPiDxYz' });
    expect(router.showTabs.value).toBe(true);
    router.push({ name: 'newGame', groupId: 'GrOuPiDxYz' });
    expect(router.showTabs.value).toBe(false);
    router.back();
    expect(router.showTabs.value).toBe(true);
  });
```

In `test/newGame.test.tsx` (add `import { App } from '../src/ui/App';`):

```ts
  it('names the main button for what it will do', async () => {
    const r = renderApp(
      () => <NewGame groupId="GrOuPiDxYz" />,
      () => ({ status: 200, body: withBotAndPlayers }),
    );
    await r.flush();
    expect(window.__tg!.mainButton).toMatchObject({ text: 'Send challenge', enabled: false });
    await r.click('[data-testid="opponent-bot"]');
    expect(window.__tg!.mainButton).toMatchObject({ text: 'Start game', enabled: true });
    await r.click('[data-opponent="2"]');
    expect(window.__tg!.mainButton.text).toBe('Send challenge');
    expect(window.__tg!.haptics).toContain('selection');
  });

  it('asks before closing while the form is open, and stops asking once it is left', async () => {
    const r = renderApp(
      (app) => {
        app.router.land('groups', { name: 'groups' });
        app.router.push({ name: 'newGame', groupId: 'GrOuPiDxYz' });
        return <App />;
      },
      () => ({ status: 200, body: withBotAndPlayers }),
    );
    await r.flush();
    expect(window.__tg!.closingConfirmation).toBe(true);
    expect(r.root.querySelector('[data-nav]')).toBeNull();
    r.app.router.back();
    await r.flush();
    expect(window.__tg!.closingConfirmation).toBe(false);
  });

  it('draws each opponent with an avatar and marks the pick', async () => {
    const r = renderApp(
      () => <NewGame groupId="GrOuPiDxYz" />,
      () => ({ status: 200, body: withBotAndPlayers }),
    );
    await r.flush();
    expect(r.root.querySelector('[data-testid="opponent-bot"] img.avatar.bot')).not.toBeNull();
    expect(r.root.querySelector('[data-opponent="2"] .avatar')?.textContent).toBe('B');
    expect(r.root.querySelector('[data-opponent="open"] .secondary')?.textContent).toBe(
      'Anyone in the group can accept',
    );
    await r.click('[data-opponent="2"]');
    expect(r.root.querySelector('[data-opponent="2"]')?.className).toContain('on');
    expect(r.root.querySelector('[data-opponent="2"] .radio.on')).not.toBeNull();
  });
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm --filter @group-chess/miniapp exec vitest run test/newGame.test.tsx test/router.test.ts`
Expected: FAIL.

- [ ] **Step 4: Hide the tab bar on New game**

`src/router.ts`:

```ts
/** Screens with no tab bar: before a session, and New game, whose MainButton owns the bottom. */
const TABLESS: ReadonlySet<Route['name']> = new Set([
  'loading',
  'error',
  'reopen',
  'locked',
  'newGame',
]);
```

and use `TABLESS` in `showTabs` (remove `CHROMELESS`).

- [ ] **Step 5: Add Tiles**

`src/ui/controls.tsx` (add `type ComponentChildren` to the `preact` type import):

```tsx
export type Tile<V> = { key: string; value: V; label: ComponentChildren } & DataAttributes;

/** A grid of mutually exclusive choices: time per move, bot level, colour. */
export function Tiles<V>(props: {
  tiles: Tile<V>[];
  value: V;
  onChange: (value: V) => void;
  columns: 3 | 4;
  /** Soft: a tinted, ringed pick for tiles that carry a picture. */
  variant?: 'solid' | 'soft';
}) {
  const { tg } = useApp();
  return (
    <div
      class={`tiles cols-${props.columns}${props.variant === 'soft' ? ' soft' : ''}`}
      role="group"
    >
      {props.tiles.map(({ key, value, label, ...data }) => (
        <button
          type="button"
          key={key}
          class="tile"
          aria-pressed={value === props.value ? 'true' : 'false'}
          onClick={() => {
            tg.hapticSelection();
            props.onChange(value);
          }}
          {...data}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 6: Rewrite the form**

`src/ui/screens/NewGame.tsx` — keep `Selection`, the resource, the state, `ready` and `submit` exactly. Add imports: `h` from `preact`, `useEffect` from `preact/hooks`, `ratingLabel`, `timeSpanLabel` from the shared package, `Avatar`, `BotMark` from `'../Avatar'`, `Tiles`, `type DataAttributes` from `'../controls'`; drop `Segmented` and `playerLabel`. Then:

```tsx
function OpponentRow(props: {
  on: boolean;
  avatar: preact.ComponentChildren;
  title: preact.ComponentChildren;
  sub?: string;
  onPick: () => void;
  data: DataAttributes;
}) {
  const { tg } = useApp();
  return (
    <button
      type="button"
      class={props.on ? 'option-row on' : 'option-row'}
      aria-pressed={props.on ? 'true' : 'false'}
      onClick={() => {
        tg.hapticSelection();
        props.onPick();
      }}
      {...props.data}
    >
      {props.avatar}
      <span class="grow">
        <span class="primary">{props.title}</span>
        {props.sub ? <span class="secondary">{props.sub}</span> : null}
      </span>
      <span class={props.on ? 'radio on' : 'radio'} aria-hidden="true">
        {props.on ? '✓' : null}
      </span>
    </button>
  );
}

const king = (colour: 'white' | 'black') => h('piece', { class: `king ${colour}` });
```

Inside `NewGame`, take `tg` from `useApp()` and add, before `useMainButton`:

```tsx
  // A half-filled form is not lost to a stray swipe (Bot API 6.2).
  useEffect(() => {
    tg.setClosingConfirmation(true);
    return () => tg.setClosingConfirmation(false);
  }, [tg]);
  const actionLabel = t(selection.kind === 'bot' ? 'app.new.start' : 'app.new.send');
```

pass `text: actionLabel` to `useMainButton`, and return:

```tsx
    <div class="screen">
      <h1 class="title">{t('app.new.title')}</h1>
      <div class="section">{t('app.new.opponent')}</div>
      <div class="card">
        {botPicker && firstLevel ? (
          <OpponentRow
            on={selection.kind === 'bot'}
            avatar={<BotMark size={38} />}
            title={t('app.new.bot')}
            sub={t('app.new.bot_sub')}
            onPick={() => setSelection({ kind: 'bot', level: firstLevel })}
            data={{ 'data-testid': 'opponent-bot' }}
          />
        ) : null}
        {players.data.players.map((player) => (
          <OpponentRow
            key={player.id}
            on={selection.kind === 'human' && selection.id === player.id}
            avatar={<Avatar player={player} size={38} />}
            title={
              <>
                {player.name}{' '}
                <span class="rating">{ratingLabel(player.rating, player.provisional)}</span>
              </>
            }
            onPick={() => setSelection({ kind: 'human', id: player.id })}
            data={{ 'data-opponent': player.id }}
          />
        ))}
        {defaults.allowOpenChallenges ? (
          <OpponentRow
            on={selection.kind === 'open'}
            avatar={
              <span class="avatar open" aria-hidden="true" style={{ '--size': '38px' }}>
                +
              </span>
            }
            title={t('app.new.open_challenge')}
            sub={t('app.new.open_sub')}
            onPick={() => setSelection({ kind: 'open' })}
            data={{ 'data-opponent': 'open' }}
          />
        ) : null}
      </div>
      {players.data.players.length === 0 ? <p class="hint">{t('app.new.no_players')}</p> : null}
      {selection.kind === 'bot' && botPicker ? (
        <>
          <div class="section">{t('app.new.bot_level')}</div>
          <Tiles
            columns={4}
            value={selection.level}
            onChange={(level) => setSelection({ kind: 'bot', level })}
            tiles={botPicker.levels.map((level) => ({
              key: level,
              value: level,
              label: t(`app.level.${level}`),
              'data-testid': `bot-level-${level}`,
            }))}
          />
          <p class="hint">{t('app.new.bot_casual')}</p>
        </>
      ) : (
        <>
          <div class="section">{t('app.new.time')}</div>
          <Tiles
            columns={3}
            value={timePerMove}
            onChange={setTimePerMove}
            tiles={TIME_VALUES.map((value) => ({
              key: String(value),
              value,
              label: value === null ? t('time.per_move.none') : timeSpanLabel(value),
              'data-time': value === null ? 'none' : value,
            }))}
          />
        </>
      )}
      <div class="section">{t('app.new.colour')}</div>
      <Tiles
        columns={3}
        variant="soft"
        value={colour}
        onChange={setColour}
        tiles={(
          [
            ['white', [king('white')]],
            ['random', [king('white'), king('black')]],
            ['black', [king('black')]],
          ] as const
        ).map(([value, kings]) => ({
          key: value,
          value,
          'data-colour': value,
          label: (
            <>
              <span class="kings cg-wrap">{kings}</span>
              <span>{t(`colour.${value}`)}</span>
            </>
          ),
        }))}
      />
      <div class={selection.kind === 'bot' ? 'card field inert' : 'card field'}>
        <span>{t('app.new.rated')}</span>
        <Switch
          checked={selection.kind === 'bot' ? false : rated}
          onChange={setRated}
          disabled={selection.kind === 'bot'}
          data-rated=""
          label={t('app.new.rated')}
        />
      </div>
      {inPage ? (
        <div class="inline-main">
          <button class="btn block" disabled={!ready} onClick={() => void submit()}>
            {actionLabel}
          </button>
        </div>
      ) : null}
    </div>
```

(`timeSpanLabel` takes a `TimePerMoveSeconds`; the non-null branch narrows `value` to it. Cast the `style` object as in Task 5 if TypeScript objects to `'--size'`.)

- [ ] **Step 7: Style it**

```css
.option-row {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 10px 14px;
  border: 0;
  border-top: 1px solid var(--sep);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
}

.card > .option-row:first-child {
  border-top: 0;
}

.option-row.on {
  background: var(--acc-soft);
}

.avatar.open {
  box-shadow: inset 0 0 0 2px var(--sep-strong);
  color: var(--hint);
  font-size: 22px;
  font-weight: 400;
}

.radio {
  width: 22px;
  height: 22px;
  flex: none;
  border-radius: 50%;
  box-shadow: inset 0 0 0 2px var(--sep-strong);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 800;
}

.radio.on {
  background: var(--acc);
  color: var(--acc-ink);
  box-shadow: none;
}

.tiles {
  display: grid;
  gap: 8px;
}

.tiles.cols-3 {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.tiles.cols-4 {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.tile {
  border: 0;
  padding: 11px 0;
  border-radius: 12px;
  background: var(--card);
  color: var(--text);
  font: inherit;
  font-size: 15px;
  font-weight: 600;
}

.tile[aria-pressed='true'] {
  background: var(--acc);
  color: var(--acc-ink);
  font-weight: 700;
}

.tiles.soft .tile {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 8px 0;
  border-radius: 14px;
  font-size: 14px;
}

.tiles.soft .tile[aria-pressed='true'] {
  background: var(--acc-soft);
  color: var(--acc-text);
  box-shadow: inset 0 0 0 2px var(--acc);
}

.kings {
  display: flex;
}

.kings piece {
  position: static;
  display: block;
  width: 36px;
  height: 36px;
  transform: none;
  background-size: cover;
}

.kings piece + piece {
  margin-left: -12px;
}

.card.field {
  padding: 12px 14px;
}

.inert {
  opacity: 0.5;
}

.inline-main {
  background: var(--page);
}
```

- [ ] **Step 8: Run the tests**

Run: `pnpm --filter @group-chess/miniapp exec vitest run`
Expected: PASS (every earlier NewGame test still finds its `data-*` hooks).

- [ ] **Step 9: Commit**

```bash
git add apps/miniapp packages/shared/src/i18n/en.ts
git commit -m "feat(miniapp): the New game form as opponent cards and tiles, guarded against a stray close"
```

---

### Task 11: Settings

**Files:**
- Modify: `apps/miniapp/src/ui/screens/Settings.tsx`
- Modify: `packages/shared/src/i18n/en.ts`
- Modify: `apps/miniapp/src/styles.css`
- Modify: `apps/miniapp/test/settings.test.tsx`

**Interfaces:**
- Consumes: `BRAND`, `AUTHOR_URL`, `REPO_URL` (Task 3); `infoDialog`, `confirmDialog` (Task 4); `Tg.openTelegramLink`, `Tg.requestWriteAccess`.

- [ ] **Step 1: Change and add the copy**

`'app.settings.notifications': 'Receive turn notifications',` and add:

```ts
  'app.settings.made_by': 'Made by',
  'app.settings.made_by_sub': 'Message the developer on Telegram',
  'app.settings.source': 'Source code on GitHub',
  'app.settings.about_row': 'About & licences',
  'app.settings.about_title': 'About Chess Goat',
```

- [ ] **Step 2: Write the failing tests**

Append to `describe('Settings', …)`:

```ts
  it('asks for permission to message when notifications go on and the bot cannot write yet', async () => {
    const r = renderApp(
      () => <Settings />,
      ({ body }) => ({
        status: 200,
        body: {
          prefs: { ...prefs.value, ...((body as { prefs?: object }).prefs ?? {}) },
          dmAllowed: false,
        },
      }),
      { writeAccess: true },
    );
    await r.click('[data-pref="notifications"]'); // off: nothing to ask
    expect(window.__tg!.calls).not.toContain('requestWriteAccess');
    await r.click('[data-pref="notifications"]'); // on again
    expect(window.__tg!.calls).toContain('requestWriteAccess');
    expect(r.calls.at(-1)).toMatchObject({
      method: 'PUT',
      path: '/api/me/prefs',
      body: { writeAccess: { allowed: true } },
    });
  });

  it('links to the author, the source and the licences', async () => {
    const r = renderApp(
      () => <Settings />,
      () => ({ status: 200, body: { ok: true } }),
    );
    await r.flush();
    expect(r.root.querySelector('img.banner-img')?.getAttribute('src')).toMatch(/goat-banner/);
    await r.click('[data-action="author"]');
    await r.click('[data-action="source"]');
    expect(window.__tg!.links).toEqual([
      'https://t.me/Jarvl',
      'https://github.com/Jarvl/telegram-chess-bot',
    ]);
    await r.click('[data-action="about"]');
    expect(window.__tg!.popups.at(-1)).toMatchObject({
      title: 'About Chess Goat',
      message: expect.stringContaining('Chess Goat is free software'),
    });
  });

  it('confirms deletion in the page on clients without popups', async () => {
    const r = renderApp(
      () => <Settings />,
      () => ({ status: 200, body: { ok: true } }),
      { version: '6.1' },
    );
    await r.click('[data-action="delete"]');
    await r.click('[data-dialog="confirm"]');
    expect(r.calls[0]).toMatchObject({ method: 'DELETE', path: '/api/me' });
  });
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm --filter @group-chess/miniapp exec vitest run test/settings.test.tsx`
Expected: FAIL.

- [ ] **Step 4: Rewrite the screen**

`src/ui/screens/Settings.tsx`:

```tsx
import { PrefsSchema, t, type Prefs } from '@group-chess/shared';
import { z } from 'zod';
import { AUTHOR_URL, BRAND, REPO_URL } from '../../brand';
import { prefs } from '../../state/session';
import { useApp } from '../context';
import { Switch } from '../controls';
import { confirmDialog, infoDialog } from '../dialog';
import { toast } from '../toast';

const PrefsResponseSchema = z.object({ prefs: PrefsSchema, dmAllowed: z.boolean() });
const TOGGLES: {
  key: keyof Pick<Prefs, 'closeAfterMove' | 'notifications'>;
  label: 'app.settings.close_after_move' | 'app.settings.notifications';
}[] = [
  { key: 'closeAfterMove', label: 'app.settings.close_after_move' },
  { key: 'notifications', label: 'app.settings.notifications' },
];

export function Settings() {
  const { client, tg } = useApp();
  const current = prefs.value;
  // Turn notifications are DMs, which need the user's leave (spec §6.1 step 4).
  const askToMessage = async () => {
    const granted = await tg.requestWriteAccess();
    if (granted === null) return;
    await client.put('/api/me/prefs', { writeAccess: { allowed: granted } }).catch(() => undefined);
  };
  const update = async (patch: Partial<Prefs>) => {
    const previous = prefs.value;
    prefs.value = { ...previous, ...patch };
    try {
      const response = await client.put('/api/me/prefs', { prefs: patch }, PrefsResponseSchema);
      prefs.value = response.prefs;
      if (patch.notifications === true && !response.dmAllowed) await askToMessage();
    } catch {
      prefs.value = previous;
      toast(t('app.common.error'));
    }
  };
  const remove = async () => {
    if (
      !(await confirmDialog(t('app.settings.delete_confirm'), {
        confirmLabel: t('app.settings.delete'),
        danger: true,
      }))
    )
      return;
    try {
      await client.del('/api/me');
      toast(t('app.settings.deleted'));
      tg.close();
    } catch {
      toast(t('app.common.error'));
    }
  };
  return (
    <div class="screen">
      <h1 class="title">{t('app.settings.title')}</h1>
      <div class="card">
        {TOGGLES.map(({ key, label }) => (
          <div class="field" key={key}>
            <span>{t(label)}</span>
            <Switch
              checked={current[key]}
              onChange={(value) => void update({ [key]: value })}
              data-pref={key}
              label={t(label)}
            />
          </div>
        ))}
      </div>
      <div class="card">
        <img class="banner-img" src={BRAND.bannerUrl} alt="" loading="lazy" />
        <button class="link-row" data-action="author" onClick={() => tg.openTelegramLink(AUTHOR_URL)}>
          <span class="grow">
            <span class="primary">
              {t('app.settings.made_by')} <span class="acc-text">@{BRAND.author}</span>
            </span>
            <span class="secondary">{t('app.settings.made_by_sub')}</span>
          </span>
          <span class="chevron" aria-hidden="true">
            ›
          </span>
        </button>
        <button class="link-row" data-action="source" onClick={() => tg.openLink(REPO_URL)}>
          <span class="grow">
            <span class="primary">{t('app.settings.source')}</span>
            <span class="secondary">{BRAND.repository}</span>
          </span>
          <span class="chevron" aria-hidden="true">
            ›
          </span>
        </button>
        <button
          class="link-row"
          data-action="about"
          onClick={() => void infoDialog(t('app.settings.about'), t('app.settings.about_title'))}
        >
          <span class="grow">
            <span class="primary">{t('app.settings.about_row')}</span>
          </span>
          <span class="chevron" aria-hidden="true">
            ›
          </span>
        </button>
      </div>
      <button class="card danger-row" data-action="delete" onClick={() => void remove()}>
        {t('app.settings.delete')}
      </button>
    </div>
  );
}
```

- [ ] **Step 5: Style it**

```css
.card > .field + .field {
  border-top: 1px solid var(--sep);
}

.banner-img {
  display: block;
  width: 100%;
  aspect-ratio: 16 / 9;
  object-fit: cover;
}

.link-row {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 13px 14px;
  border: 0;
  border-top: 1px solid var(--sep);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
}

.banner-img + .link-row {
  border-top: 0;
}

.link-row .primary {
  font-weight: 400;
}

.acc-text {
  color: var(--acc-text);
  font-weight: 600;
}

.danger-row {
  width: 100%;
  padding: 14px;
  border: 0;
  color: var(--destructive);
  font: inherit;
  font-weight: 600;
  text-align: center;
}
```

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @group-chess/miniapp exec vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/miniapp packages/shared/src/i18n/en.ts
git commit -m "feat(miniapp): Settings with the author, source and licences, and write access for notifications"
```

---

### Task 12: Player, Group settings and status screens; retire the old rows

**Files:**
- Modify: `apps/miniapp/src/ui/screens/Player.tsx`, `apps/miniapp/src/ui/screens/GroupSettings.tsx`, `apps/miniapp/src/ui/screens/Status.tsx`
- Modify: `apps/miniapp/src/ui/rows.tsx` (delete `GameRow`), `apps/miniapp/src/ui/format.ts` (delete `summaryStatus`)
- Modify: `apps/miniapp/src/styles.css`
- Create: `apps/miniapp/test/player.test.tsx`
- Modify: `apps/miniapp/test/groupSettings.test.tsx`

**Interfaces:**
- Consumes: `Avatar`, `GameCard`, `Tiles`, `BRAND`.

- [ ] **Step 1: Write the failing tests**

`test/player.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import { Player } from '../src/ui/screens/Player';
import { renderApp } from './support/render';
import { gameSummary, playerRef } from './support/summaryFixtures';

const page = {
  player: {
    ...playerRef('2', '@bob', { rating: 1520, provisional: false }),
    gamesPlayed: 9,
    record: { wins: 5, draws: 1, losses: 3 },
  },
  headToHead: { wins: 2, draws: 0, losses: 1 },
  recentGames: [gameSummary({ id: 'GameRrrrrr' })],
};

describe('Player', () => {
  it('heads the page with the avatar and record and lists recent games as cards', async () => {
    const r = renderApp(
      () => <Player groupId="GrOuPiDxYz" userId="2" />,
      () => ({ status: 200, body: page }),
    );
    await r.flush();
    expect(r.root.querySelector('.player-head .avatar')?.textContent).toBe('B');
    expect(r.root.querySelector('.title')?.textContent).toBe('@bob');
    expect(r.text()).toContain('5 W · 1 D · 3 L');
    expect(r.text()).toContain('Against you: 2 W · 0 D · 1 L');
    expect(r.root.querySelector('.game-card[data-game="GameRrrrrr"]')).not.toBeNull();
  });
});
```

In `test/groupSettings.test.tsx`, append to the first test (before the MainButton click) a tile pick:

```ts
    await r.click('[data-setting="defaultTimePerMove"] [data-time="3600"]');
```

and change the expected PUT body to `{ defaultTimePerMove: 3600, ratedDefault: false, cardTopicMode: 'fixed', fixedTopicId: 42 }`.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @group-chess/miniapp exec vitest run test/player.test.tsx test/groupSettings.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Player page**

Replace the returned JSX of `src/ui/screens/Player.tsx`:

```tsx
    <div class="screen">
      <header class="player-head">
        <Avatar player={player} size={56} />
        <div class="grow">
          <h1 class="title">{player.name}</h1>
          <p class="subtitle">
            {ratingLabel(player.rating, player.provisional)} ·{' '}
            {t('app.player.record', player.record)} ·{' '}
            {t('app.player.games', { count: player.gamesPlayed })}
          </p>
        </div>
      </header>
      <p class="hint">{t('app.player.head_to_head', headToHead)}</p>
      <div class="section">{t('app.player.recent')}</div>
      <div class="card">
        {recentGames.map((game) => (
          <GameCard
            key={game.id}
            game={game}
            onOpen={(gameId) => router.push({ name: 'game', gameId })}
          />
        ))}
      </div>
    </div>
```

(imports: `Avatar`, `GameCard`, `ratingLabel`; drop `GameRow`, `playerLabel`.)

- [ ] **Step 4: Group settings**

In `src/ui/screens/GroupSettings.tsx`:
- replace the `<Field label={t('app.gsettings.default_time')}>…<Select …/></Field>` block with
  ```tsx
        <div class="field column" data-setting="defaultTimePerMove">
          <span>{t('app.gsettings.default_time')}</span>
          <Tiles
            columns={3}
            value={current.defaultTimePerMove}
            onChange={(value) => set('defaultTimePerMove', value)}
            tiles={[...TIME_PER_MOVE_OPTIONS, null].map((value) => ({
              key: String(value),
              value: value as TimePerMove,
              label: value === null ? t('time.per_move.none') : timeSpanLabel(value),
              'data-time': value === null ? 'none' : value,
            }))}
          />
        </div>
  ```
  (import `Tiles`, `timeSpanLabel`; drop `Select` and `timePerMoveLabel` if unused);
- wrap the heading as `<div><h1 class="title">…</h1><p class="subtitle">…</p></div>`;
- the three `<div class="list">` wrappers become `<div class="card">`;
- in the blocked and block-candidate rows put `<Avatar player={player} size={40} />` before the name span, and give their buttons `class="pill-btn"` / `class="pill-btn danger"`; the void rows' button becomes `class="pill-btn danger"`.

Add to `styles.css`:

```css
.field.column {
  flex-direction: column;
  align-items: stretch;
}

.card .tiles .tile {
  background: var(--page);
}

.card .tiles .tile[aria-pressed='true'] {
  background: var(--acc);
}

.player-head {
  display: flex;
  align-items: center;
  gap: 14px;
}

.status-mark {
  width: 72px;
  height: 72px;
  border-radius: 50%;
  object-fit: cover;
  object-position: 50% 30%;
}
```

- [ ] **Step 5: Status screens**

In `src/ui/screens/Status.tsx`, import `BRAND` and put `<img class="status-mark" src={BRAND.markUrl} alt="" width={72} height={72} />` as the first child of `ErrorScreen`, `Reopen` and `Locked` (not `Loading`: it flashes for a moment on every screen).

- [ ] **Step 6: Retire the old rows**

Delete `GameRow` from `src/ui/rows.tsx` and `summaryStatus` from `src/ui/format.ts` (and any import they leave unused). Run `grep -rn "GameRow\|summaryStatus\|ChallengeRow\|LobbyTab\|CHROMELESS" apps/miniapp/src`: expect no matches.

- [ ] **Step 7: Run everything**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/miniapp
git commit -m "feat(miniapp): Player, Group settings and status screens in the new design"
```

---

### Task 13: End-to-end flows, gates and the visual pass

**Files:**
- Modify: `apps/server/test/e2e/harness.ts`
- Modify: `apps/miniapp/e2e/support.ts`, `apps/miniapp/e2e/lobby.spec.ts`
- Create: `apps/miniapp/e2e/screens.spec.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: harness scenario `'ranked'` (the `fresh` game plus rated records for Alice 1540 and Bob 1510, 6 games each) and an optional `groupTitle` on seed requests; `openApp(page, { …, colorScheme })`.

- [ ] **Step 1: Extend the harness**

In `apps/server/test/e2e/harness.ts`:
- `type Scenario = 'none' | 'fresh' | 'opening' | 'promotion' | 'finished' | 'ranked';` and `type SeedRequest = { scenario: Scenario; prefs?: …; groupTitle?: string };`
- `title: request.groupTitle ?? 'Chess Club',` in `insertGroup`;
- import `ratings` from the schema, and after the `finished` branch:
  ```ts
    if (request.scenario === 'ranked') {
      game = await insertGame(db, group.id, alice, bob, { fen: INITIAL_FEN });
      await db.insert(ratings).values([
        { groupId: group.id, userId: alice, rating: 1540, rd: 60, volatility: 0.06, gamesPlayed: 6, wins: 4, draws: 1, losses: 1 },
        { groupId: group.id, userId: bob, rating: 1510, rd: 60, volatility: 0.06, gamesPlayed: 6, wins: 1, draws: 1, losses: 4 },
      ]);
    }
  ```

In `apps/miniapp/e2e/support.ts`: `seed(scenario: 'none' | 'fresh' | 'opening' | 'promotion' | 'finished' | 'ranked', prefs = {}, options: { groupTitle?: string } = {})` sending `{ scenario, prefs, ...options }`; `openApp` accepts `colorScheme?: 'light' | 'dark'` and passes `colorScheme: options.colorScheme` into `fake`.

- [ ] **Step 2: Add the leaderboard flow**

Append to `apps/miniapp/e2e/lobby.spec.ts`:

```ts
test('the lobby’s leaderboard chip ranks you and reaches a player', async ({ page }) => {
  const world = await seed('ranked');
  await openApp(page, {
    user: world.users.alice.telegram,
    startParam: `l_${world.group.publicId}`,
  });
  const chip = page.locator('[data-action="leaderboard"]');
  await expect(chip).toContainText('#1');
  await chip.click();
  await expect(page.locator('.title')).toHaveText('Leaderboard');
  await expect(page.locator('[data-player]')).toHaveCount(2);
  await expect(page.locator('.player-row.you')).toContainText('(you)');
  await page.locator(`[data-player="${world.users.bob.id}"]`).click();
  await expect(page.locator('.title')).toHaveText('@bob');
  await clickBack(page);
  await expect(page.locator('.title')).toHaveText('Leaderboard');
});
```

- [ ] **Step 3: Add the screens spec (overflow checks plus screenshots)**

`apps/miniapp/e2e/screens.spec.ts`:

```ts
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { openApp, seed } from './support';

// Review Focus 5: a long title must never push the page sideways at phone width.
const LONG_TITLE = 'The Extremely Long Friday Evening Correspondence Chess Club of Manchester';
test.use({ viewport: { width: 390, height: 844 } });

async function fits(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

const dir = process.env.SCREENS_DIR;
async function shot(page: Page, name: string): Promise<void> {
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`every main screen fits at 390 px (${colorScheme})`, async ({ page }) => {
    const world = await seed('ranked', {}, { groupTitle: LONG_TITLE });
    await openApp(page, { user: world.users.alice.telegram, colorScheme });
    await expect(page.locator('.title')).toHaveText('Your games');
    await fits(page);
    await shot(page, `${colorScheme}-games`);

    await page.locator('[data-nav="groups"]').click();
    await expect(page.locator('[data-group]')).toBeVisible();
    await fits(page);
    await shot(page, `${colorScheme}-groups`);

    await page.locator('[data-group]').click();
    await expect(page.locator('[data-action="new-game"]')).toBeVisible();
    await fits(page);
    await shot(page, `${colorScheme}-lobby`);

    await page.locator('[data-action="leaderboard"]').click();
    await expect(page.locator('[data-player]')).toHaveCount(2);
    await fits(page);
    await shot(page, `${colorScheme}-leaderboard`);

    await page.locator('[data-nav="games"]').click();
    await page.locator('[data-game]').click();
    await expect(page.locator('.cg-wrap')).toBeVisible();
    await fits(page);
    await shot(page, `${colorScheme}-game`);

    await page.locator('[data-nav="settings"]').click();
    await expect(page.locator('[data-action="about"]')).toBeVisible();
    await fits(page);
    await shot(page, `${colorScheme}-settings`);
  });
}
```

(The fake WebApp installs no `themeParams`, so dark mode here shows the fallback dark neutrals plus the dark accents, which is what a Telegram client without theme params would show.)

- [ ] **Step 4: Run the whole gate**

```bash
export TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/group_chess_test
pnpm lint && pnpm format:check && pnpm typecheck
pnpm test
pnpm build && pnpm check:budget
pnpm check:licences
SCREENS_DIR=<scratchpad>/screens pnpm e2e
```
Expected: every command succeeds; `check:budget` prints both `OK`; the e2e run passes all specs, including the two new ones, and leaves twelve PNGs in `<scratchpad>/screens`. If `pnpm e2e` cannot find Chromium: `pnpm --filter @group-chess/miniapp exec playwright install chromium`.

- [ ] **Step 5: Visual pass against the prototype**

Open each PNG in `<scratchpad>/screens` (Read tool) next to the matching prototype screen (`Chess Goat Prototype.dc.html`: Games home with `homeList: dim`, Groups, Lobby with `lobbyLayout: mine`, Leaderboard, Game, Settings; toggle `scheme` for dark). Check: the display face on titles; card surfaces on the page colour; the gold your-move pill and badge; dimmed boards on games waiting on someone else; the board's cream/green squares and gold last move; the long group title ellipsised or wrapped; the tab bar pill. Fix any mismatch in `styles.css`, re-run `SCREENS_DIR=<scratchpad>/screens pnpm e2e --grep "fits at 390"` and look again. Record in the PR description anything left deliberately different.

- [ ] **Step 6: Commit**

```bash
git add apps/server/test/e2e apps/miniapp/e2e apps/miniapp/src/styles.css
git commit -m "test: the leaderboard flow and a 390 px no-overflow pass over the redesigned screens"
```
