# Move Confirmations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring back the move confirmation step as a three-way user setting, **Move confirmations**
(Always / Only against people / Never, default Only against people), using Telegram's native
Cancel and Confirm move buttons, with the tab bar hidden while a move waits and a waiting move
cancelled whenever the player leaves the Game screen.

**Architecture:** The preference lives in the existing `users.prefs` jsonb and `PrefsSchema`.
The server only validates it and maps the pre-#16 `confirmMoves: false` to `never`. The Mini
App decides per move with a pure `needsConfirmation(setting, game)`. The move reducer regains
its `pendingConfirm` state. `GameView` drives Telegram's MainButton and SecondaryButton from
that state, freezes the board, and hides the tab bar through a new `Router.suppressTabs`
signal. It cancels the move on unmount, on Telegram's `deactivated` event (a new
`Tg.onDeactivated`, 8.0+), and when the game changes under it. Settings gets a row that opens a
new `choiceDialog`: Telegram's popup, or an in-page sheet on older clients.

**Tech Stack:** TypeScript, zod (shared schemas), Hono + Drizzle on PostgreSQL (server), Preact
+ @preact/signals + chessground (Mini App), Vitest (happy-dom for the Mini App), Playwright
(end-to-end).

**Spec:** [docs/superpowers/specs/2026-09-24-move-confirmations-design.md](../specs/2026-09-24-move-confirmations-design.md).
Read it before starting; this plan argues from it.

## Global Constraints

- Preference key `moveConfirmations`, values exactly `'always' | 'people' | 'never'`, default `'people'`.
- A game is against a person when `GameDto.engineLevel === null`.
- Copy, verbatim:
  - Setting: "Move confirmations"
  - Choices: "Always", "Only against people", "Never"
  - MainButton: "Confirm move"
  - Cancel: the existing `app.game.cancel` ("Cancel")
  - Sending: the existing `app.game.sending` ("Sending…")
  - Popup message: `Ask before a move is sent. With "Only against people", moves against the bot send on drop.`
- The popup marks the current choice by prefixing its button text with `✓ ` (check mark, space).
- Feature floors: SecondaryButton `7.10`, `showPopup` `6.2`, the `deactivated` event `8.0`. Below
  each, the stated fallback applies. Never call an API the client doesn't have.
- **No closing confirmation on the Game screen.** Never call `tg.setClosingConfirmation` from
  `GameView`.
- No database migration. Storage is the existing `users.prefs` jsonb.
- The pre-#16 `confirmMoves` key is never returned by the API. `confirmMoves: false` reads as
  `never` unless a `moveConfirmations` is stored, which always wins.
- Integration tests and the end-to-end harness need `TEST_DATABASE_URL`. On this machine that is
  `postgres://postgres:postgres@127.0.0.1:5432/<database>` (PostgreSQL in Docker Desktop, not
  OrbStack), with a database of this worktree's own. Task 1 step 1 creates it.
- Run commands from the worktree root. Unit files run with `pnpm vitest run <path>`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

The spec implies these inputs, but no single flow test would hit them. Each line names the task
whose test pins it.

1. **A player who had `confirmMoves: false` then picks "Only against people".** The stored
   choice must win over the legacy mapping on every later read, or the setting silently snaps
   back to Never (Task 1).
2. **Confirm tapped twice before the screen re-renders.** Exactly one move must be sent
   (Task 3).
3. **A snapshot that changes nothing arrives while a move waits** (the resume refresh, or a
   draw offer). The move must stay waiting, on the board, with Confirm move still up. Only a
   new ply or status cancels it (Tasks 3 and 4).
4. **Telegram minimises the app after Confirm, while the move is sending.** The move is already
   on its way, so it must land, not snap back (Task 4).
5. **The setting changes between two moves of the same game** (Settings tab, then back). The
   next drop must use the new value, read at the drop (Task 3).

---

### Task 1: The `moveConfirmations` preference

**Files:**
- Modify: `packages/shared/src/protocol/enums.ts` (append after `EngineLevelSchema`)
- Modify: `packages/shared/src/protocol/dto.ts` (imports at the top; `PrefsSchema` and `PREFS_DEFAULTS` near line 225)
- Test: `packages/shared/test/enums.test.ts`, `packages/shared/test/protocol/dto.test.ts`, `packages/shared/test/protocol/requests.test.ts`
- Modify: `apps/server/src/domain/users.ts` (`prefsOf`)
- Test: `apps/server/test/integration/users-groups.test.ts`, `apps/server/test/integration/api-auth.test.ts`
- Modify (fixtures that build a full `Prefs`): `apps/miniapp/test/support/render.tsx`, `apps/miniapp/test/launch.test.ts`, `apps/miniapp/test/boot.test.ts`

**Interfaces:**
- Produces (from `@group-chess/shared`):
  - `MOVE_CONFIRMATIONS: readonly ['always', 'people', 'never']`
  - `type MoveConfirmations = 'always' | 'people' | 'never'`
  - `MoveConfirmationsSchema`
  - `Prefs.moveConfirmations: MoveConfirmations`
  - `PREFS_DEFAULTS.moveConfirmations === 'people'`
- Produces (server): `prefsOf(user)` returns `moveConfirmations`, applying the legacy mapping.

- [ ] **Step 1: Give this worktree its own test database**

The Docker Desktop PostgreSQL must be running; start Docker Desktop if `docker ps` fails.

```bash
docker ps --format '{{.Names}}' | grep -i db
```

Using the container name that prints (for example `telegram-chess-bot-db-1`):

```bash
docker exec telegram-chess-bot-db-1 psql -U postgres -c "create database group_chess_test_moveconfirm"
```

Use this for every integration and end-to-end run in this plan:

```bash
export TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/group_chess_test_moveconfirm
```

The global setup runs migrations itself.

- [ ] **Step 2: Write the failing shared tests**

In `packages/shared/test/enums.test.ts`, change the import to
`import { ENGINE_LEVELS, EngineLevelSchema, MOVE_CONFIRMATIONS, MoveConfirmationsSchema } from '../src';`
and append:

```ts
describe('move confirmations', () => {
  it('lists the three settings, most confirming first', () => {
    expect(MOVE_CONFIRMATIONS).toEqual(['always', 'people', 'never']);
  });

  it('accepts a known setting and refuses anything else', () => {
    expect(MoveConfirmationsSchema.safeParse('people').success).toBe(true);
    expect(MoveConfirmationsSchema.safeParse('sometimes').success).toBe(false);
    expect(MoveConfirmationsSchema.safeParse(true).success).toBe(false);
  });
});
```

In `packages/shared/test/protocol/dto.test.ts`, add `PREFS_DEFAULTS` and `PrefsSchema` to the
import from `'../../src/protocol/dto'`, and append:

```ts
describe('PrefsSchema', () => {
  it('defaults move confirmations to games against people', () => {
    expect(PREFS_DEFAULTS.moveConfirmations).toBe('people');
    expect(PrefsSchema.parse(PREFS_DEFAULTS)).toEqual(PREFS_DEFAULTS);
  });

  it('accepts the three move confirmation settings and nothing else', () => {
    for (const value of ['always', 'people', 'never']) {
      expect(PrefsSchema.safeParse({ ...PREFS_DEFAULTS, moveConfirmations: value }).success).toBe(
        true,
      );
    }
    expect(
      PrefsSchema.safeParse({ ...PREFS_DEFAULTS, moveConfirmations: 'sometimes' }).success,
    ).toBe(false);
  });
});
```

In `packages/shared/test/protocol/requests.test.ts`, inside `describe('PrefsUpdateRequestSchema', …)`, add:

```ts
  it('accepts a move confirmations change and refuses an unknown one', () => {
    expect(PrefsUpdateRequestSchema.parse({ prefs: { moveConfirmations: 'never' } })).toEqual({
      prefs: { moveConfirmations: 'never' },
    });
    expect(
      PrefsUpdateRequestSchema.safeParse({ prefs: { moveConfirmations: 'sometimes' } }).success,
    ).toBe(false);
  });
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm vitest run packages/shared/test/enums.test.ts packages/shared/test/protocol/dto.test.ts packages/shared/test/protocol/requests.test.ts`
Expected: FAIL. `MOVE_CONFIRMATIONS` is not exported, `PREFS_DEFAULTS.moveConfirmations` is
undefined, and the partial update strips the unknown key, so `toEqual` fails.

- [ ] **Step 4: Add the enum and the preference**

Append to `packages/shared/src/protocol/enums.ts`:

```ts
/** When a dropped move waits for Confirm move (move confirmations spec). */
export const MOVE_CONFIRMATIONS = ['always', 'people', 'never'] as const;

export type MoveConfirmations = (typeof MOVE_CONFIRMATIONS)[number];

export const MoveConfirmationsSchema = z.enum(MOVE_CONFIRMATIONS);
```

In `packages/shared/src/protocol/dto.ts`, add `MoveConfirmationsSchema,` to the import list from
`'./enums'` (keep it alphabetical, after `GameStatusSchema`). Then replace the `PrefsSchema` and
`PREFS_DEFAULTS` blocks with:

```ts
export const PrefsSchema = z.object({
  closeAfterMove: z.boolean(),
  notifications: z.boolean(),
  moveConfirmations: MoveConfirmationsSchema,
  boardTheme: z.string().max(32).nullable(),
  pieceSet: z.string().max(32).nullable(),
});

export type Prefs = z.infer<typeof PrefsSchema>;

export const PREFS_DEFAULTS: Prefs = {
  closeAfterMove: true,
  notifications: true,
  moveConfirmations: 'people',
  boardTheme: null,
  pieceSet: null,
};
```

- [ ] **Step 5: Run the shared tests to see them pass**

Run: `pnpm vitest run packages/shared`
Expected: PASS.

- [ ] **Step 6: Write the failing server tests**

In `apps/server/test/integration/users-groups.test.ts`:

1. Add `import { eq } from 'drizzle-orm';` and change the schema import to
   `import { ratings, users } from '../../src/db/schema';`.
2. In `'creates a user once and refreshes the name on later sightings'`, add
   `moveConfirmations: 'people',` to the expected object after `notifications: true,`.
3. Replace the whole `'leaves retired preference keys out of the stored preferences'` test with:

```ts
  it('reads a pre-#16 confirmMoves: false as Never and leaves the retired key out', () => {
    const prefs = prefsOf({ prefs: { confirmMoves: false, notifications: false } as never });
    expect(prefs).not.toHaveProperty('confirmMoves');
    expect(prefs.moveConfirmations).toBe('never');
    expect(prefs.notifications).toBe(false);
  });

  it('reads confirmMoves: true, or no stored choice, as the default', () => {
    expect(prefsOf({ prefs: { confirmMoves: true } as never }).moveConfirmations).toBe('people');
    expect(prefsOf({ prefs: {} }).moveConfirmations).toBe('people');
  });

  it('lets a stored move confirmations choice win over the retired key', async () => {
    expect(
      prefsOf({ prefs: { confirmMoves: false, moveConfirmations: 'always' } as never })
        .moveConfirmations,
    ).toBe('always');
    // Review Focus 1: turned confirmations off before #16, now picks Only against people.
    const user = await ensureUser(db, { telegramUserId: 42, firstName: 'Alice' });
    await db
      .update(users)
      .set({ prefs: { confirmMoves: false } as never })
      .where(eq(users.id, user.id));
    expect((await updatePrefs(db, user.id, { moveConfirmations: 'people' })).moveConfirmations).toBe(
      'people',
    );
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(prefsOf(row!).moveConfirmations).toBe('people');
  });
```

In `apps/server/test/integration/api-auth.test.ts`, inside `describe('me routes', …)`, add:

```ts
  it('saves a move confirmations choice and refuses an unknown one', async () => {
    const user = await insertUser(db);
    const token = await api.sessionFor(user);
    const saved = await api.request('PUT', '/api/me/prefs', {
      token,
      body: { prefs: { moveConfirmations: 'never' } },
    });
    expect(await saved.json()).toMatchObject({ prefs: { moveConfirmations: 'never' } });
    const refused = await api.request('PUT', '/api/me/prefs', {
      token,
      body: { prefs: { moveConfirmations: 'sometimes' } },
    });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: { code: 'validation' } });
  });
```

- [ ] **Step 7: Run them to see the legacy tests fail**

Run: `pnpm vitest run apps/server/test/integration/users-groups.test.ts apps/server/test/integration/api-auth.test.ts`
Expected: FAIL on `'reads a pre-#16 confirmMoves: false as Never…'`, because
`moveConfirmations` is `'people'`, not `'never'`. The API test already passes, since the
schema did the work in Step 4.

- [ ] **Step 8: Map the legacy key in `prefsOf`**

In `apps/server/src/domain/users.ts`, replace `prefsOf` and its comment with:

```ts
/**
 * Stored preferences over the defaults; keys no longer in the schema are dropped. A
 * `confirmMoves: false` stored before #16 reads as `moveConfirmations: 'never'`, and a stored
 * `moveConfirmations` always wins over it (move confirmations spec).
 */
export function prefsOf(user: Pick<UserRow, 'prefs'>): Prefs {
  const stored = user.prefs as Partial<Prefs> & { confirmMoves?: unknown };
  const legacy: Partial<Prefs> =
    stored.confirmMoves === false ? { moveConfirmations: 'never' } : {};
  return PrefsSchema.parse({ ...PREFS_DEFAULTS, ...legacy, ...user.prefs });
}
```

- [ ] **Step 9: Run the server tests to see them pass**

Run: `pnpm vitest run apps/server/test/integration/users-groups.test.ts apps/server/test/integration/api-auth.test.ts`
Expected: PASS.

- [ ] **Step 10: Add the field to the Mini App fixtures that build a full `Prefs`**

Add `moveConfirmations: 'people',` after `notifications: true,` (or `notifications: …,`) in the
`prefs` object of:
- `apps/miniapp/test/support/render.tsx` (the `prefs.value = { … }` in `renderApp`)
- `apps/miniapp/test/launch.test.ts` (`response.prefs`)
- `apps/miniapp/test/boot.test.ts` (`launchBody`'s `prefs`)

Without it, the launch fixtures fail `LaunchResponseSchema`, which now requires the field.

- [ ] **Step 11: Run the whole suite, typecheck and lint**

Run: `pnpm typecheck && pnpm lint && pnpm vitest run`
Expected: everything passes. Nothing in the Mini App reads `moveConfirmations` yet, so behaviour
is unchanged.

- [ ] **Step 12: Commit**

```bash
git add packages/shared apps/server/src/domain/users.ts apps/server/test/integration/users-groups.test.ts apps/server/test/integration/api-auth.test.ts apps/miniapp/test/support/render.tsx apps/miniapp/test/launch.test.ts apps/miniapp/test/boot.test.ts
git commit -F - <<'EOF'
feat: a moveConfirmations preference, defaulting to games against people

Always, Only against people or Never, stored in users.prefs with no
migration. A confirmMoves: false saved before #16 reads as Never, and a
stored moveConfirmations always wins over it.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 2: The move reducer's confirmation state

**Files:**
- Modify: `apps/miniapp/src/state/moveMachine.ts`
- Test: `apps/miniapp/test/moveMachine.test.ts`

**Interfaces:**
- Consumes: `MoveConfirmations`, `EngineLevel` from `@group-chess/shared` (Task 1).
- Produces:
  - `MoveState` gains `{ kind: 'pendingConfirm'; move: PendingMove }`.
  - `MoveEvent` gains `{ type: 'confirm' }` and `{ type: 'cancel' }`.
  - `reduceMove(state, event, options?: { confirm: boolean })`. `options` defaults to
    `{ confirm: false }`, so today's callers keep sending on drop.
  - `needsConfirmation(setting: MoveConfirmations, game: { engineLevel: EngineLevel | null }): boolean`.

- [ ] **Step 1: Write the failing tests**

In `apps/miniapp/test/moveMachine.test.ts`, add `needsConfirmation` to the import from
`'../src/state/moveMachine'`. Replace the `run` helper with one that can confirm:

```ts
const run = (events: MoveEvent[], from: MoveState = { kind: 'idle' }, confirm = false) => {
  let state = from;
  const effects: string[] = [];
  for (const event of events) {
    const out = reduceMove(state, event, { confirm });
    state = out.state;
    effects.push(...out.effects.map((effect) => effect.type));
  }
  return { state, effects };
};
```

Inside `describe('reduceMove', …)`, add:

```ts
  it('holds a dropped move for confirmation, then sends it exactly once', () => {
    const move = { uci: 'e2e4', expectedPly: 0, clientMoveId: 'm-0000000001' };
    const pending = run([drop], { kind: 'idle' }, true);
    expect(pending.state).toEqual({ kind: 'pendingConfirm', move });
    expect(pending.effects).toEqual([]);
    const confirmed = run([{ type: 'confirm' }], pending.state);
    expect(confirmed.state).toEqual({ kind: 'sending', move, attempt: 1 });
    expect(confirmed.effects).toEqual(['send']);
    // Review Focus 2: a second Confirm before the screen catches up sends nothing more.
    expect(run([{ type: 'confirm' }], confirmed.state).effects).toEqual([]);
  });

  it('puts the piece back on cancel and sends nothing', () => {
    const pending = run([drop], { kind: 'idle' }, true).state;
    const { state, effects } = run([{ type: 'cancel' }], pending);
    expect(state).toEqual({ kind: 'idle' });
    expect(effects).toEqual(['restore']);
  });

  it('ignores another drop, network answers and ticks while a move waits', () => {
    const pending = run([drop], { kind: 'idle' }, true).state;
    const stray: MoveEvent[] = [
      { ...drop, uci: 'd2d4' },
      { type: 'sent' },
      { type: 'networkError', now: 1 },
      { type: 'tick', now: 99_999 },
      { type: 'retryNow' },
    ];
    for (const event of stray) {
      const out = run([event], pending);
      expect(out.state).toBe(pending);
      expect(out.effects).toEqual([]);
    }
  });

  it('ignores a cancel once the move is on its way', () => {
    const sending = run([drop]).state;
    const out = run([{ type: 'cancel' }], sending);
    expect(out.state).toBe(sending);
    expect(out.effects).toEqual([]);
  });
```

After the `describe('reduceMove', …)` block, add:

```ts
describe('needsConfirmation', () => {
  it.each([
    ['always', null, true],
    ['always', 'casual', true],
    ['people', null, true],
    ['people', 'casual', false],
    ['never', null, false],
    ['never', 'casual', false],
  ] as const)('%s against engine level %s → %s', (setting, engineLevel, expected) => {
    expect(needsConfirmation(setting, { engineLevel })).toBe(expected);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run apps/miniapp/test/moveMachine.test.ts`
Expected: FAIL. `needsConfirmation` is not exported, and a drop with `confirm: true` still goes
to `sending`.

- [ ] **Step 3: Implement**

In `apps/miniapp/src/state/moveMachine.ts`:

Add at the top: `import type { EngineLevel, MoveConfirmations } from '@group-chess/shared';`

Replace the `MoveState` and `MoveEvent` types with:

```ts
export type MoveState =
  | { kind: 'idle' }
  /** Dropped and shown on the board, waiting for Confirm move or Cancel (move confirmations spec). */
  | { kind: 'pendingConfirm'; move: PendingMove }
  | { kind: 'sending'; move: PendingMove; attempt: number }
  | { kind: 'retry'; move: PendingMove; attempt: number; nextAt: number };

export type MoveEvent =
  | { type: 'drop'; uci: string; expectedPly: number; clientMoveId?: string }
  | { type: 'confirm' }
  | { type: 'cancel' }
  | { type: 'sent' }
  /** 409 or 422: reload the state and snap back without a message (spec §6.3). */
  | { type: 'rejected' }
  | { type: 'networkError'; now: number }
  | { type: 'retryNow' }
  | { type: 'tick'; now: number };
```

Add, above `reduceMove`:

```ts
/** Whether a dropped move waits for Confirm move: the player's setting against this kind of game. */
export function needsConfirmation(
  setting: MoveConfirmations,
  game: { engineLevel: EngineLevel | null },
): boolean {
  switch (setting) {
    case 'always':
      return true;
    case 'people':
      return game.engineLevel === null;
    case 'never':
      return false;
  }
}
```

Change the signature of `reduceMove` to:

```ts
export function reduceMove(
  state: MoveState,
  event: MoveEvent,
  options: { confirm: boolean } = { confirm: false },
): { state: MoveState; effects: MoveEffect[] } {
```

In its `case 'idle'`, return early for a move that waits, just before the existing `return` that
goes to `sending`:

```ts
      if (options.confirm) return { state: { kind: 'pendingConfirm', move }, effects: [] };
```

Add a case between `'idle'` and `'sending'`:

```ts
    case 'pendingConfirm': {
      if (event.type === 'confirm') {
        return {
          state: { kind: 'sending', move: state.move, attempt: 1 },
          effects: [{ type: 'send', move: state.move }],
        };
      }
      if (event.type === 'cancel') return { state: { kind: 'idle' }, effects: [{ type: 'restore' }] };
      return same;
    }
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm vitest run apps/miniapp/test/moveMachine.test.ts`
Expected: PASS, the six existing tests included.

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm typecheck && pnpm lint`
Expected: clean. `GameView` still calls `reduceMove(state, event)` and gets the default.

```bash
git add apps/miniapp/src/state/moveMachine.ts apps/miniapp/test/moveMachine.test.ts
git commit -F - <<'EOF'
feat(miniapp): a confirmation state in the move reducer

A drop can wait in pendingConfirm until Confirm sends it or Cancel puts
the piece back. needsConfirmation decides per move from the player's
setting and whether the game is against the bot.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 3: Confirm move and Cancel on the game screen

**Files:**
- Modify: `apps/miniapp/src/ui/game/GameView.tsx`
- Modify: `apps/miniapp/src/ui/game/Board.tsx` (a `frozen` prop)
- Modify: `apps/miniapp/src/ui/game/MoveList.tsx` (a `locked` prop)
- Modify: `packages/shared/src/i18n/en.ts` (`app.game.confirm_move`)
- Modify: `apps/miniapp/test/support/render.tsx` (a `tg` option)
- Test: `apps/miniapp/test/game.test.tsx`
- Modify (e2e seeds that play a move against a person and expect it sent on drop):
  - `apps/miniapp/e2e/move.spec.ts` (two tests)
  - `apps/miniapp/e2e/live.spec.ts` (two tests)
  - `apps/miniapp/e2e/fallbacks.spec.ts` (the 6.0 test)
  - `apps/miniapp/e2e/promotion.spec.ts`

**Interfaces:**
- Consumes: `reduceMove(…, { confirm })` and `needsConfirmation` (Task 2);
  `prefs.value.moveConfirmations` (Task 1).
- Produces:
  - `GameView` state `confirming: boolean`, true from a drop that enters `pendingConfirm`
    until the machine is `idle` again. Task 4 reads it.
  - `Board` prop `frozen?: boolean`.
  - `MoveList` prop `locked?: boolean`.
  - `renderApp(…, { tg?: Tg })`.
  - Toolbar pills `data-action="confirm-move"` and `data-action="cancel-move"`.

- [ ] **Step 1: Let tests render with a Telegram-less client**

In `apps/miniapp/test/support/render.tsx`, add `tg?: Tg;` to `renderApp`'s `options` type, and
replace `const tg = createTg(window.Telegram!.WebApp);` with:

```ts
  const tg = options.tg ?? createTg(window.Telegram!.WebApp);
```

- [ ] **Step 2: Keep the existing game tests on send-on-drop**

In `apps/miniapp/test/game.test.tsx`:
- Add `import type { MoveConfirmations } from '@group-chess/shared';` and
  `import { createTg } from '../src/tg/webapp';`. `renderApp`, `prefs`, `FakeResponse`,
  `gameDto` and `afterPlies` are already imported.
- Replace `const wantPrefs = { closeAfterMove: false };` with:

```ts
const wantPrefs: { closeAfterMove: boolean; moveConfirmations: MoveConfirmations } = {
  closeAfterMove: false,
  // The flows below predate move confirmations; the describe block for them sets its own.
  moveConfirmations: 'never',
};
```

- In `beforeEach`, after `wantPrefs.closeAfterMove = false;`, add
  `wantPrefs.moveConfirmations = 'never';`.

- [ ] **Step 3: Write the failing tests**

Append to `apps/miniapp/test/game.test.tsx`:

```ts
describe('Game with move confirmations', () => {
  beforeEach(() => {
    wantPrefs.moveConfirmations = 'people';
  });
  const posts = (r: ReturnType<typeof mount>) =>
    r.calls.filter((c) => c.method === 'POST' && c.path === `/api/games/${GAME}/moves`);

  it('holds a move against a person for Confirm move, then sends it once', async () => {
    const r = mount(gameDto());
    await r.flush();
    adapter.drop('e2', 'e4');
    await r.flush();
    expect(posts(r)).toHaveLength(0);
    expect(window.__tg!.mainButton).toMatchObject({ text: 'Confirm move', visible: true });
    expect(window.__tg!.secondaryButton).toMatchObject({ text: 'Cancel', visible: true });
    expect(r.root.querySelector('[data-action="resign"]')?.hasAttribute('disabled')).toBe(true);
    // Review Focus 2: two taps before the screen re-renders still send one move.
    window.__tg!.clickMain();
    window.__tg!.clickMain();
    await r.flush();
    expect(posts(r)).toHaveLength(1);
    expect(posts(r)[0]?.body).toMatchObject({ uci: 'e2e4', expectedPly: 0 });
    expect(window.__tg!.mainButton.visible).toBe(false);
    expect(window.__tg!.secondaryButton!.visible).toBe(false);
  });

  it('keeps the bar up with a spinner while a confirmed move sends', async () => {
    let answer: (response: FakeResponse) => void = () => undefined;
    const r = mount(
      gameDto(),
      okRoute(gameDto(), () => new Promise<FakeResponse>((resolve) => (answer = resolve))),
    );
    await r.flush();
    adapter.drop('e2', 'e4');
    await r.flush();
    window.__tg!.clickMain();
    await r.flush();
    expect(window.__tg!.mainButton).toMatchObject({
      text: 'Sending…',
      visible: true,
      progress: true,
    });
    expect(window.__tg!.secondaryButton!.visible).toBe(false);
    answer({ status: 200, body: afterPlies(1) });
    await r.flush();
    expect(window.__tg!.mainButton.visible).toBe(false);
  });

  it('puts the piece back on Cancel and sends nothing', async () => {
    const r = mount(gameDto());
    await r.flush();
    adapter.drop('e2', 'e4');
    await r.flush();
    const restored = adapter.restored;
    window.__tg!.clickSecondary();
    await r.flush();
    expect(adapter.restored).toBe(restored + 1);
    expect(adapter.positions.at(-1)?.fen).toBe(gameDto().fen);
    expect(posts(r)).toHaveLength(0);
    expect(window.__tg!.mainButton.visible).toBe(false);
    expect(window.__tg!.secondaryButton!.visible).toBe(false);
  });

  it('holds the waiting move on the board through a snapshot, and locks the move strip', async () => {
    const r = mount(afterPlies(2));
    await r.flush();
    adapter.drop('b1', 'c3');
    await r.flush();
    const before = adapter.positions.length;
    // Review Focus 3: a draw offer bumps the version but is no new ply.
    FakeEventSource.instances[0]!.send(
      'state',
      afterPlies(2, { version: 3, drawOffer: { by: 'black', atPly: 2 } }),
      '3',
    );
    await r.flush();
    expect(adapter.positions).toHaveLength(before);
    expect(r.text()).toContain('Bob offers a draw');
    expect(window.__tg!.mainButton).toMatchObject({ text: 'Confirm move', visible: true });
    expect(
      r.root.querySelector<HTMLButtonElement>('.move-list [data-ply="1"]')?.disabled,
    ).toBe(true);
  });

  it('holds a promotion for Confirm move once the piece is picked', async () => {
    const r = mount(gameDto({ fen: '4k3/4P3/8/8/8/8/8/4K3 w - - 0 1', plyCount: 6, version: 6 }));
    await r.flush();
    adapter.drop('e7', 'e8');
    await r.flush();
    await r.click('[data-promote="q"]');
    expect(posts(r)).toHaveLength(0);
    expect(window.__tg!.mainButton).toMatchObject({ text: 'Confirm move', visible: true });
    window.__tg!.clickMain();
    await r.flush();
    expect(posts(r)[0]?.body).toMatchObject({ uci: 'e7e8q', expectedPly: 6 });
  });

  it('sends on drop against the bot under the default', async () => {
    const r = mount(gameDto({ engineLevel: 'casual' }));
    await r.flush();
    adapter.drop('e2', 'e4');
    await r.flush();
    expect(posts(r)).toHaveLength(1);
    expect(window.__tg!.calls).not.toContain('MainButton.show');
  });

  it('holds a move against the bot when the setting is Always', async () => {
    wantPrefs.moveConfirmations = 'always';
    const r = mount(gameDto({ engineLevel: 'casual' }));
    await r.flush();
    adapter.drop('e2', 'e4');
    await r.flush();
    expect(posts(r)).toHaveLength(0);
    expect(window.__tg!.mainButton).toMatchObject({ text: 'Confirm move', visible: true });
  });

  it('reads the setting at each drop, so a change mid-game applies to the next move', async () => {
    // Review Focus 5.
    const r = mount(gameDto());
    await r.flush();
    prefs.value = { ...prefs.value, moveConfirmations: 'never' };
    adapter.drop('e2', 'e4');
    await r.flush();
    expect(posts(r)).toHaveLength(1);
  });

  it('puts Cancel in the action row below 7.10', async () => {
    const r = mount(gameDto(), okRoute(gameDto()), '7.0');
    await r.flush();
    adapter.drop('e2', 'e4');
    await r.flush();
    expect(window.__tg!.mainButton).toMatchObject({ text: 'Confirm move', visible: true });
    expect(r.root.querySelector('[data-action="confirm-move"]')).toBeNull();
    await r.click('.toolbar [data-action="cancel-move"]');
    expect(posts(r)).toHaveLength(0);
    expect(r.root.querySelector('[data-action="cancel-move"]')).toBeNull();
  });

  it('puts both Confirm move and Cancel first in the action row without Telegram buttons', async () => {
    const initial = gameDto();
    const r = renderApp(
      (app) => {
        app.prefetched.game = initial;
        return <Game gameId={GAME} />;
      },
      okRoute(initial),
      { tg: createTg(null) },
    );
    prefs.value = { ...prefs.value, ...wantPrefs };
    await r.flush();
    adapter.drop('e2', 'e4');
    await r.flush();
    const toolbar = r.root.querySelector('.toolbar')!;
    expect(toolbar.children[0]?.getAttribute('data-action')).toBe('confirm-move');
    expect(toolbar.children[1]?.getAttribute('data-action')).toBe('cancel-move');
    await r.click('[data-action="confirm-move"]');
    expect(
      r.calls.filter((c) => c.method === 'POST' && c.path === `/api/games/${GAME}/moves`),
    ).toHaveLength(1);
  });
});
```

- [ ] **Step 4: Run them to see them fail**

Run: `pnpm vitest run apps/miniapp/test/game.test.tsx`
Expected: the new block FAILs, because moves send on drop and there's no Confirm move button.
The original `describe('Game', …)` tests still PASS.

- [ ] **Step 5: Add the copy**

In `packages/shared/src/i18n/en.ts`, after `'app.game.confirm': 'Confirm',` add:

```ts
  'app.game.confirm_move': 'Confirm move',
```

- [ ] **Step 6: Let the board hold a waiting move**

Replace `apps/miniapp/src/ui/game/Board.tsx`'s doc comment, props and position effect so that it reads:

```tsx
/**
 * Mounts the adapter once and pushes position, movable set and view-only flag from the store.
 * While `frozen` (a move is waiting for Confirm move) position updates are held back so the shown
 * move stays on the board; the screen re-pushes the position when the move resolves.
 */
export function Board(props: {
  store: GameStore;
  onMove: MoveHandler;
  onReady: (adapter: BoardAdapter) => void;
  frozen?: boolean;
  children?: preact.ComponentChildren;
}) {
  const element = useRef<HTMLDivElement>(null);
  const onMoveRef = useRef(props.onMove);
  onMoveRef.current = props.onMove;
  const frozenRef = useRef(props.frozen ?? false);
  frozenRef.current = props.frozen ?? false;
```

and inside the first `effect(() => { … })`, replace `adapter.setPosition(next);` with
`if (!frozenRef.current) adapter.setPosition(next);`.

- [ ] **Step 7: Let the move strip lock**

In `apps/miniapp/src/ui/game/MoveList.tsx`, change the signature to
`export function MoveList(props: { store: GameStore; locked?: boolean })`, add a comment above
it, `/** `locked` while a move waits for Confirm move: the board holds that move, so the strip can't switch position. */`,
and add `disabled={props.locked}` to both the per-move `<button>` and the `data-action="latest"`
badge button.

- [ ] **Step 8: Drive the flow from `GameView`**

In `apps/miniapp/src/ui/game/GameView.tsx`:

1. Add `needsConfirmation,` to the import from `'../../state/moveMachine'`.
2. Below `const SLOW_SEND_MS = 1_000;`, add:

```ts
/** Telegram shows Confirm move and Cancel itself; the page draws neither. */
const NO_IN_PAGE = { confirm: false, cancel: false };
```

3. Below `const [slowSend, setSlowSend] = useState(false);`, add:

```ts
  // True from a drop that waits for Confirm move until that move settles (sent, cancelled or
  // rejected): the bar stays up through the send, and the tab bar stays hidden (move confirmations spec).
  const [confirming, setConfirming] = useState(false);
  // Which of Confirm move and Cancel this client has no Telegram button for, so the page draws them.
  const [inPage, setInPage] = useState(NO_IN_PAGE);
```

4. Replace the `dispatch` callback with:

```ts
  const dispatch = useCallback(
    (event: MoveEvent) => {
      // Read at each drop, so a setting changed mid-game applies from the next move.
      const confirm = needsConfirmation(prefs.value.moveConfirmations, store.dto.value);
      const { state, effects } = reduceMove(moveRef.current, event, { confirm });
      moveRef.current = state;
      setMoveState(state);
      if (state.kind === 'pendingConfirm') setConfirming(true);
      else if (state.kind === 'idle') setConfirming(false);
      for (const effect of effects) runEffectRef.current(effect);
    },
    [store],
  );
```

5. Replace the "Telegram buttons per machine state" effect and the cleanup effect below it with:

```ts
  // Telegram buttons per machine state (spec §6.3, move confirmations spec). A send that needed
  // no confirmation shows none: the main button resizes the viewport, and the board with it, so
  // flashing it on every move makes the page jump. After Confirm move the bar is already up, so
  // it stays, with a spinner, until the move settles.
  useEffect(() => {
    switch (moveState.kind) {
      case 'pendingConfirm': {
        const main = tg.setMainButton({
          text: t('app.game.confirm_move'),
          onClick: () => dispatch({ type: 'confirm' }),
        });
        const secondary = tg.setSecondaryButton({
          text: t('app.game.cancel'),
          onClick: () => dispatch({ type: 'cancel' }),
        });
        setInPage({ confirm: !main, cancel: !secondary });
        return;
      }
      case 'sending':
        tg.setSecondaryButton(null);
        tg.setMainButton(
          confirming
            ? { text: t('app.game.sending'), onClick: () => undefined, progress: true }
            : null,
        );
        setInPage(NO_IN_PAGE);
        return;
      case 'retry':
        tg.setSecondaryButton(null);
        tg.setMainButton({
          text: t('app.game.retry'),
          onClick: () => dispatch({ type: 'retryNow' }),
        });
        setInPage(NO_IN_PAGE);
        return;
      case 'idle':
        tg.setMainButton(null);
        tg.setSecondaryButton(null);
        setInPage(NO_IN_PAGE);
        return;
    }
  }, [moveState.kind, confirming, tg, dispatch]);
  useEffect(
    () => () => {
      tg.setMainButton(null);
      tg.setSecondaryButton(null);
    },
    [tg],
  );
```

6. In the JSX, pass `frozen` to the board:
   `<Board store={store} onMove={onDrop} onReady={(adapter) => (adapterRef.current = adapter)} frozen={moveState.kind === 'pendingConfirm'}>`.
7. Replace `<MoveList store={store} />` with
   `<MoveList store={store} locked={moveState.kind === 'pendingConfirm'} />`.
8. Make these the first children of `<div class="toolbar">`, before the Rematch button:

```tsx
        {moveState.kind === 'pendingConfirm' && inPage.confirm ? (
          <button
            class="pill-btn primary"
            data-action="confirm-move"
            onClick={() => dispatch({ type: 'confirm' })}
          >
            {t('app.game.confirm_move')}
          </button>
        ) : null}
        {moveState.kind === 'pendingConfirm' && inPage.cancel ? (
          <button
            class="pill-btn"
            data-action="cancel-move"
            onClick={() => dispatch({ type: 'cancel' })}
          >
            {t('app.game.cancel')}
          </button>
        ) : null}
```

Offer draw, Claim draw, Abort and Resign already carry `disabled={busy}`, and `busy` is true in
`pendingConfirm`. Leave them.

- [ ] **Step 9: Run the game tests to see them pass**

Run: `pnpm vitest run apps/miniapp/test/game.test.tsx`
Expected: PASS, both describe blocks.

- [ ] **Step 10: Seed the end-to-end specs that expect send-on-drop**

The harness replaces a seeded user's `prefs` with the given object, so after this task Alice
would confirm by default. Add `moveConfirmations: 'never'` next to `closeAfterMove` in Alice's
seeded prefs in:
- `apps/miniapp/e2e/move.spec.ts`: `seed('fresh', { alice: { closeAfterMove: true, moveConfirmations: 'never' } })` and `seed('fresh', { alice: { closeAfterMove: false, moveConfirmations: 'never' } })`
- `apps/miniapp/e2e/live.spec.ts`: both `seed('fresh', { alice: { closeAfterMove: false, moveConfirmations: 'never' } })`
- `apps/miniapp/e2e/fallbacks.spec.ts`: the 6.0 test's seed
- `apps/miniapp/e2e/promotion.spec.ts`: `seed('promotion', { alice: { closeAfterMove: false, moveConfirmations: 'never' } })`

Leave `bot.spec.ts` alone: under the default a bot game sends on drop, which Task 7 asserts.
Leave `spectator.spec.ts` alone too, since spectators never confirm. The full end-to-end run
comes in Task 7.

- [ ] **Step 11: Typecheck, lint, run the Mini App suite, commit**

Run: `pnpm typecheck && pnpm lint && pnpm vitest run apps/miniapp packages/shared`
Expected: PASS.

```bash
git add apps/miniapp packages/shared/src/i18n/en.ts
git commit -F - <<'EOF'
feat(miniapp): Confirm move and Cancel in Telegram's bottom bar

A move that needs confirming waits on a frozen board with the move strip
locked. Telegram's MainButton reads Confirm move and its SecondaryButton
Cancel; after Confirm the bar stays up with a spinner until the move
settles. Below 7.10 Cancel is an in-page pill, and without Telegram
buttons both are. The e2e specs that expect send-on-drop seed Never.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 4: Leaving cancels a waiting move, and the tab bar steps aside

**Files:**
- Modify: `apps/miniapp/src/router.ts` (`suppressTabs`)
- Modify: `apps/miniapp/src/tg/webapp.ts` (`Feature` `'activation'`, `Tg.onDeactivated`)
- Modify: `apps/miniapp/src/ui/game/GameView.tsx`
- Test: `apps/miniapp/test/router.test.ts`, `apps/miniapp/test/tg.test.ts`, `apps/miniapp/test/game.test.tsx`

**Interfaces:**
- Consumes: `confirming` and the `cancel` event (Task 3).
- Produces:
  - `Router.suppressTabs: Signal<boolean>`, with `showTabs` false while it is true.
  - `Tg.onDeactivated(callback: () => void): () => void`, a no-op below 8.0.
  - `FEATURE_MIN_VERSION.activation === '8.0'`.

- [ ] **Step 1: Write the failing router and Telegram tests**

In `apps/miniapp/test/router.test.ts`, inside `describe('Router', …)`, add:

```ts
  it('hides the tab bar while a screen suppresses it', () => {
    const { router } = setup();
    router.land('games', { name: 'game', gameId: 'AbCdEfGhIj' });
    expect(router.showTabs.value).toBe(true);
    router.suppressTabs.value = true;
    expect(router.showTabs.value).toBe(false);
    router.suppressTabs.value = false;
    expect(router.showTabs.value).toBe(true);
  });
```

In `apps/miniapp/test/tg.test.ts`, inside `describe('createTg', …)`, add:

```ts
  it('reports deactivation only from 8.0, until unsubscribed', () => {
    let seen = 0;
    tgFor({ version: '7.10' }).onDeactivated(() => (seen += 1));
    window.__tg!.emit('deactivated');
    expect(seen).toBe(0);
    const off = tgFor({ version: '8.0' }).onDeactivated(() => (seen += 1));
    window.__tg!.emit('deactivated');
    off();
    window.__tg!.emit('deactivated');
    expect(seen).toBe(1);
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run apps/miniapp/test/router.test.ts apps/miniapp/test/tg.test.ts`
Expected: FAIL. `suppressTabs` and `onDeactivated` don't exist.

- [ ] **Step 3: Implement the router signal**

In `apps/miniapp/src/router.ts`, add a field after `readonly stacks …`:

```ts
  /** Set by a screen that needs the bottom edge to itself for a while (a move waiting for Confirm move). */
  readonly suppressTabs: Signal<boolean> = signal(false);
```

and in the constructor, replace the `showTabs` line with:

```ts
    this.showTabs = computed(
      () => !TABLESS.has(this.current.value.name) && !this.suppressTabs.value,
    );
```

- [ ] **Step 4: Implement `onDeactivated`**

In `apps/miniapp/src/tg/webapp.ts`:
- Add `| 'activation'` to the `Feature` union, and `activation: '8.0',` to `FEATURE_MIN_VERSION`.
- Add to the `Tg` interface, after `onSettingsButton`:

```ts
  /** Telegram minimising or backgrounding the app (8.0+); a no-op below. Returns the undo. */
  onDeactivated(callback: () => void): () => void;
```

- In `nullTg()`, add `onDeactivated: () => () => undefined,` after `onSettingsButton`.
- In `createTg`'s returned object, after `onSettingsButton(…) { … },`, add:

```ts
    onDeactivated(callback) {
      if (!supports('activation')) return () => undefined;
      raw.onEvent('deactivated', callback);
      return () => raw.offEvent('deactivated', callback);
    },
```

- [ ] **Step 5: Run the router and Telegram tests to see them pass**

Run: `pnpm vitest run apps/miniapp/test/router.test.ts apps/miniapp/test/tg.test.ts`
Expected: PASS. `'gates every capability by the client version'` now covers `activation` too.

- [ ] **Step 6: Write the failing game tests**

In `apps/miniapp/test/game.test.tsx`, add `import { render } from 'preact';`. Then, inside
`describe('Game with move confirmations', …)`, add:

```ts
  it('hides the tab bar while a move waits and brings it back once the move is sent', async () => {
    const r = mount(gameDto());
    await r.flush();
    expect(r.app.router.suppressTabs.value).toBe(false);
    adapter.drop('e2', 'e4');
    await r.flush();
    expect(r.app.router.suppressTabs.value).toBe(true);
    window.__tg!.clickMain();
    await r.flush();
    expect(r.app.router.suppressTabs.value).toBe(false);
  });

  it('brings the tab bar back on Cancel', async () => {
    const r = mount(gameDto());
    await r.flush();
    adapter.drop('e2', 'e4');
    await r.flush();
    window.__tg!.clickSecondary();
    await r.flush();
    expect(r.app.router.suppressTabs.value).toBe(false);
  });

  it('keeps the tab bar hidden through a network retry of a confirmed move', async () => {
    vi.useFakeTimers();
    let failures = 0;
    const r = mount(
      gameDto(),
      okRoute(gameDto(), () => {
        failures += 1;
        if (failures === 1) throw new TypeError('Failed to fetch');
        return { status: 200, body: afterPlies(1) };
      }),
    );
    await vi.advanceTimersByTimeAsync(100); // effects run on the next (faked) frame
    adapter.drop('e2', 'e4');
    await vi.advanceTimersByTimeAsync(100);
    window.__tg!.clickMain();
    await vi.advanceTimersByTimeAsync(100);
    expect(window.__tg!.mainButton).toMatchObject({ text: 'Retry', visible: true });
    expect(r.app.router.suppressTabs.value).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(100);
    expect(r.app.router.suppressTabs.value).toBe(false);
  });

  it('drops a waiting move when the screen goes away, without asking and without sending', async () => {
    const r = mount(gameDto());
    await r.flush();
    adapter.drop('e2', 'e4');
    await r.flush();
    expect(window.__tg!.closingConfirmation).toBe(false);
    render(null, r.root);
    await r.flush();
    expect(window.__tg!.mainButton.visible).toBe(false);
    expect(window.__tg!.secondaryButton!.visible).toBe(false);
    expect(r.app.router.suppressTabs.value).toBe(false);
    window.__tg!.clickMain(); // the handler is gone with the screen
    await r.flush();
    expect(r.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect(window.__tg!.calls).not.toContain('enableClosingConfirmation');
  });

  it('drops a waiting move when Telegram minimises the app', async () => {
    const r = mount(gameDto());
    await r.flush();
    adapter.drop('e2', 'e4');
    await r.flush();
    const restored = adapter.restored;
    window.__tg!.emit('deactivated');
    await r.flush();
    expect(adapter.restored).toBe(restored + 1);
    expect(window.__tg!.mainButton.visible).toBe(false);
    expect(r.app.router.suppressTabs.value).toBe(false);
    expect(r.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('lets a confirmed move land when the app is minimised while it sends', async () => {
    // Review Focus 4.
    let answer: (response: FakeResponse) => void = () => undefined;
    const r = mount(
      gameDto(),
      okRoute(gameDto(), () => new Promise<FakeResponse>((resolve) => (answer = resolve))),
    );
    await r.flush();
    adapter.drop('e2', 'e4');
    await r.flush();
    window.__tg!.clickMain();
    await r.flush();
    const restored = adapter.restored;
    window.__tg!.emit('deactivated');
    answer({ status: 200, body: afterPlies(1) });
    await r.flush();
    expect(adapter.restored).toBe(restored);
    expect(r.root.querySelectorAll('.move-list [data-ply]')).toHaveLength(1);
  });

  it('keeps a waiting move through a draw offer, and drops it when the game ends under it', async () => {
    // Review Focus 3: only a new ply or status cancels.
    const r = mount(gameDto());
    await r.flush();
    adapter.drop('e2', 'e4');
    await r.flush();
    const before = adapter.positions.length;
    FakeEventSource.instances[0]!.send(
      'state',
      gameDto({ version: 1, drawOffer: { by: 'black', atPly: 0 } }),
      '1',
    );
    await r.flush();
    expect(window.__tg!.mainButton).toMatchObject({ text: 'Confirm move', visible: true });
    FakeEventSource.instances[0]!.send(
      'state',
      gameDto({ version: 2, status: 'finished', result: '*', endReason: 'abort' }),
      '2',
    );
    await r.flush();
    expect(adapter.positions.length).toBeGreaterThan(before);
    expect(window.__tg!.mainButton.visible).toBe(false);
    expect(r.app.router.suppressTabs.value).toBe(false);
    expect(r.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });
```

- [ ] **Step 7: Run them to see them fail**

Run: `pnpm vitest run apps/miniapp/test/game.test.tsx`
Expected: FAIL. `suppressTabs` never goes true, deactivation does nothing, and the abort
snapshot leaves the move waiting. `'lets a confirmed move land…'` already passes.

- [ ] **Step 8: Wire the leaving rules into `GameView`**

In `apps/miniapp/src/ui/game/GameView.tsx`:

1. Just above `const applyState = useCallback(`, add:

```ts
  // applyState is defined before dispatch; it reaches the machine through this ref.
  const dispatchRef = useRef<(event: MoveEvent) => void>(() => undefined);
```

2. Inside `applyState`, after the check-haptic `if (…) tg.hapticNotify('warning');`, add:

```ts
      // A move waiting for Confirm move is void once the game has moved on (the server would
      // reject its expectedPly anyway): take it off the board and the buttons.
      if (
        moveRef.current.kind === 'pendingConfirm' &&
        (next.plyCount !== previous.plyCount || next.status !== previous.status)
      )
        dispatchRef.current({ type: 'cancel' });
```

3. Directly after the `dispatch` `useCallback`, add `dispatchRef.current = dispatch;`.
4. After the buttons effect from Task 3, add:

```ts
  // Telegram's bar takes about the space the tab bar frees, so the board keeps its size while a
  // move waits; and no tab tap can leave the move unsent (move confirmations spec).
  useEffect(() => {
    router.suppressTabs.value = confirming;
  }, [router, confirming]);
  // Minimising (Telegram 8.0) is leaving too: a waiting move is dropped. Once sent, cancel is a no-op.
  useEffect(() => tg.onDeactivated(() => dispatch({ type: 'cancel' })), [tg, dispatch]);
```

5. Replace the unmount cleanup effect from Task 3 with:

```ts
  // Leaving the screen (a tab, Back, Telegram's Settings item, another game) discards a waiting
  // move with the component; this puts Telegram's buttons and the tab bar back.
  useEffect(
    () => () => {
      tg.setMainButton(null);
      tg.setSecondaryButton(null);
      router.suppressTabs.value = false;
    },
    [tg, router],
  );
```

- [ ] **Step 9: Run the Mini App tests to see them pass**

Run: `pnpm vitest run apps/miniapp`
Expected: PASS.

- [ ] **Step 10: Typecheck, lint, commit**

Run: `pnpm typecheck && pnpm lint`
Expected: clean.

```bash
git add apps/miniapp/src/router.ts apps/miniapp/src/tg/webapp.ts apps/miniapp/src/ui/game/GameView.tsx apps/miniapp/test/router.test.ts apps/miniapp/test/tg.test.ts apps/miniapp/test/game.test.tsx
git commit -F - <<'EOF'
feat(miniapp): leaving the game cancels a waiting move

The tab bar hides from the drop until the move settles, so Telegram's
bar takes its space and the board keeps its size. Unmounting, Telegram's
deactivated event (8.0) and a new ply or status under the move all drop
it without sending and without a closing prompt.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 5: `choiceDialog`, one of up to three choices

**Files:**
- Modify: `apps/miniapp/src/ui/dialog.tsx`
- Modify: `apps/miniapp/src/styles.css` (the in-page choice list, next to the `.dialog` rules near line 500)
- Test (create): `apps/miniapp/test/choiceDialog.test.tsx`

**Interfaces:**
- Produces:
  - `type Choice<V extends string> = { value: V; label: string }`
  - `choiceDialog<V extends string>(request: { title: string; message: string; choices: Choice<V>[]; current: V }): Promise<V | null>`,
    where `null` means dismissed.
  - In-page markup: `[data-choice="<value>"]` buttons (`role="radio"`, `aria-checked` on the
    current one) and `[data-dialog="cancel"]`.

- [ ] **Step 1: Write the failing tests**

Create `apps/miniapp/test/choiceDialog.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import { choiceDialog } from '../src/ui/dialog';
import { renderApp } from './support/render';

const ok = () => ({ status: 200, body: { ok: true } });
const ask = () =>
  choiceDialog({
    title: 'Move confirmations',
    message: 'Ask before a move is sent.',
    choices: [
      { value: 'always', label: 'Always' },
      { value: 'people', label: 'Only against people' },
      { value: 'never', label: 'Never' },
    ],
    current: 'people',
  });

describe('choiceDialog', () => {
  it('asks through Telegram’s popup, marking the current choice', async () => {
    const r = renderApp(() => null, ok);
    await r.flush();
    const answer = ask();
    expect(window.__tg!.popups.at(-1)).toEqual({
      title: 'Move confirmations',
      message: 'Ask before a move is sent.',
      buttons: [
        { id: 'always', type: 'default', text: 'Always' },
        { id: 'people', type: 'default', text: '✓ Only against people' },
        { id: 'never', type: 'default', text: 'Never' },
      ],
    });
    window.__tg!.answerPopup('never');
    expect(await answer).toBe('never');
  });

  it('reads a dismissed popup as no choice', async () => {
    const r = renderApp(() => null, ok);
    await r.flush();
    const answer = ask();
    window.__tg!.answerPopup('');
    expect(await answer).toBeNull();
  });

  it('offers the choices in the page on clients without popups', async () => {
    const r = renderApp(() => null, ok, { version: '6.1' });
    await r.flush();
    const answer = ask();
    await r.flush();
    expect(document.querySelector('[data-choice="people"]')?.getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(document.querySelector('[data-choice="always"]')?.getAttribute('aria-checked')).toBe(
      'false',
    );
    await r.click('[data-choice="always"]');
    expect(await answer).toBe('always');
    expect(document.querySelector('[data-choice]')).toBeNull();
  });

  it('falls back to the page when the client rejects the popup, and Cancel dismisses', async () => {
    const r = renderApp(() => null, ok, { popupError: 'WebAppPopupParamInvalid' });
    await r.flush();
    const answer = ask();
    await r.flush();
    expect(document.querySelector('[data-choice="never"]')).not.toBeNull();
    await r.click('[data-dialog="cancel"]');
    expect(await answer).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run apps/miniapp/test/choiceDialog.test.tsx`
Expected: FAIL. `choiceDialog` is not exported.

- [ ] **Step 3: Implement**

In `apps/miniapp/src/ui/dialog.tsx`, after `const pending = signal<Pending | null>(null);`, add:

```ts
export type Choice<V extends string> = { value: V; label: string };

type ChoiceRequest = {
  title: string;
  message: string;
  choices: Choice<string>[];
  current: string;
};

const pendingChoice = signal<(ChoiceRequest & { resolve: (value: string | null) => void }) | null>(
  null,
);

/** The in-page list: Telegram below 6.2, or a client that refused the popup. */
function chooseInPage(request: ChoiceRequest): Promise<string | null> {
  pendingChoice.value?.resolve(null);
  return new Promise((resolve) => {
    pendingChoice.value = { ...request, resolve };
  });
}
```

After `infoDialog`, add:

```ts
/**
 * One of up to three choices (Telegram's popup takes at most three buttons): the native popup
 * from 6.2, with the current choice's text prefixed "✓ " because a popup button has no selected
 * state; the in-page list below. Resolves the picked value, or null when dismissed.
 */
export async function choiceDialog<V extends string>(request: {
  title: string;
  message: string;
  choices: Choice<V>[];
  current: V;
}): Promise<V | null> {
  const native = host?.showPopup({
    title: request.title,
    message: request.message,
    buttons: request.choices.map((choice) => ({
      id: choice.value,
      type: 'default',
      text: choice.value === request.current ? `✓ ${choice.label}` : choice.label,
    })),
  });
  // As in `ask`: a rejection is the client refusing the call, not the user dismissing it.
  const picked = native
    ? await native.catch(() => chooseInPage(request))
    : await chooseInPage(request);
  return request.choices.find((choice) => choice.value === picked)?.value ?? null;
}
```

In `Dialogs()`, after the `useEffect(…)` and before `const current = pending.value;`, add:

```tsx
  const choice = pendingChoice.value;
  if (choice) {
    const pick = (value: string | null) => {
      pendingChoice.value = null;
      choice.resolve(value);
    };
    return (
      <div class="dialog-backdrop" onClick={() => pick(null)}>
        <div class="dialog" role="dialog" onClick={(event) => event.stopPropagation()}>
          <strong>{choice.title}</strong>
          <p>{choice.message}</p>
          <div class="choices" role="radiogroup">
            {choice.choices.map((option) => (
              <button
                key={option.value}
                class="choice"
                role="radio"
                aria-checked={option.value === choice.current}
                data-choice={option.value}
                onClick={() => pick(option.value)}
              >
                <span class="grow">{option.label}</span>
                {option.value === choice.current ? (
                  <span class="check" aria-hidden="true">
                    ✓
                  </span>
                ) : null}
              </button>
            ))}
          </div>
          <div class="actions">
            <button class="btn secondary" data-dialog="cancel" onClick={() => pick(null)}>
              {t('app.game.cancel')}
            </button>
          </div>
        </div>
      </div>
    );
  }
```

In `apps/miniapp/src/styles.css`, after the `.dialog strong { … }` rule, add:

```css
.dialog .choices {
  display: flex;
  flex-direction: column;
  border-radius: 12px;
  overflow: hidden;
  background: var(--page);
}

.dialog .choice {
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

.dialog .choice:first-child {
  border-top: 0;
}

.dialog .choice .check {
  color: var(--acc);
  font-weight: 700;
}
```

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm vitest run apps/miniapp/test/choiceDialog.test.tsx apps/miniapp/test/settings.test.tsx`
Expected: PASS. The Settings tests exercise `confirmDialog`'s sheet, which must still work.

- [ ] **Step 5: Typecheck, lint, commit**

Run: `pnpm typecheck && pnpm lint && pnpm format:check`
Expected: clean.

```bash
git add apps/miniapp/src/ui/dialog.tsx apps/miniapp/src/styles.css apps/miniapp/test/choiceDialog.test.tsx
git commit -F - <<'EOF'
feat(miniapp): choiceDialog, one of up to three choices

Telegram's popup from 6.2, with the current choice marked "✓ " since a
popup button has no selected state; an in-page list below 6.2 or when
the client refuses the popup. Dismissing resolves null.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 6: The Move confirmations row in Settings

**Files:**
- Modify: `apps/miniapp/src/ui/screens/Settings.tsx`
- Modify: `packages/shared/src/i18n/en.ts` (five `app.settings.move_confirmations*` keys)
- Modify: `apps/miniapp/src/styles.css` (the row button, next to `.field` near line 350)
- Test: `apps/miniapp/test/settings.test.tsx`

**Interfaces:**
- Consumes:
  - `choiceDialog` (Task 5)
  - `MOVE_CONFIRMATIONS`, `MoveConfirmations` (Task 1)
  - `Settings`'s existing `update(patch)`: optimistic, reverts and toasts on failure
- Produces: `[data-pref="moveConfirmations"]`, a row button first in the preferences card.

- [ ] **Step 1: Write the failing tests**

In `apps/miniapp/test/settings.test.tsx`, add `import { t } from '@group-chess/shared';`. Replace
the whole `'has no move confirmation toggle'` test with:

```tsx
  it('shows Move confirmations first in the card, with the current choice', () => {
    const r = renderApp(
      () => <Settings />,
      () => ({ status: 200, body: { ok: true } }),
    );
    const row = r.root.querySelector('.card [data-pref="moveConfirmations"]');
    expect(row?.textContent).toContain('Move confirmations');
    expect(row?.textContent).toContain('Only against people');
    expect(r.root.querySelector('.card')?.firstElementChild).toBe(row);
    expect(r.root.querySelector('[data-pref="confirmMoves"]')).toBeNull();
  });

  it('saves a choice picked in Telegram’s popup', async () => {
    const r = renderApp(
      () => <Settings />,
      ({ body }) => ({
        status: 200,
        body: { prefs: { ...prefs.value, ...(body as { prefs: object }).prefs }, dmAllowed: false },
      }),
    );
    await r.click('[data-pref="moveConfirmations"]');
    expect(window.__tg!.popups.at(-1)).toMatchObject({
      title: 'Move confirmations',
      message:
        'Ask before a move is sent. With "Only against people", moves against the bot send on drop.',
      buttons: [
        { id: 'always', text: 'Always' },
        { id: 'people', text: '✓ Only against people' },
        { id: 'never', text: 'Never' },
      ],
    });
    window.__tg!.answerPopup('never');
    await r.flush();
    expect(r.calls[0]).toMatchObject({
      method: 'PUT',
      path: '/api/me/prefs',
      body: { prefs: { moveConfirmations: 'never' } },
    });
    expect(window.__tg!.haptics).toContain('selection');
    expect(prefs.value.moveConfirmations).toBe('never');
    expect(r.root.querySelector('[data-pref="moveConfirmations"]')?.textContent).toContain(
      'Never',
    );
  });

  it('changes nothing when the popup is dismissed or the current choice is picked', async () => {
    const r = renderApp(
      () => <Settings />,
      () => ({ status: 200, body: { ok: true } }),
    );
    await r.click('[data-pref="moveConfirmations"]');
    window.__tg!.answerPopup('');
    await r.flush();
    await r.click('[data-pref="moveConfirmations"]');
    window.__tg!.answerPopup('people');
    await r.flush();
    expect(r.calls).toHaveLength(0);
    expect(window.__tg!.haptics).not.toContain('selection');
    expect(prefs.value.moveConfirmations).toBe('people');
  });

  it('reverts the choice and says so when the save fails', async () => {
    const r = renderApp(
      () => <Settings />,
      () => ({ status: 500, body: { error: { code: 'internal', message: 'boom' } } }),
    );
    await r.click('[data-pref="moveConfirmations"]');
    window.__tg!.answerPopup('always');
    await r.flush();
    expect(prefs.value.moveConfirmations).toBe('people');
    expect(document.querySelector('.toast')?.textContent).toBe(t('app.common.error'));
  });

  it('offers the choices in the page on clients without popups', async () => {
    const r = renderApp(
      () => <Settings />,
      ({ body }) => ({
        status: 200,
        body: { prefs: { ...prefs.value, ...(body as { prefs: object }).prefs }, dmAllowed: false },
      }),
      { version: '6.1' },
    );
    await r.click('[data-pref="moveConfirmations"]');
    await r.click('[data-choice="always"]');
    expect(r.calls[0]).toMatchObject({ body: { prefs: { moveConfirmations: 'always' } } });
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run apps/miniapp/test/settings.test.tsx`
Expected: FAIL. There is no `[data-pref="moveConfirmations"]`.

- [ ] **Step 3: Add the copy**

In `packages/shared/src/i18n/en.ts`, after `'app.settings.notifications': …,` add:

```ts
  'app.settings.move_confirmations': 'Move confirmations',
  'app.settings.move_confirmations.always': 'Always',
  'app.settings.move_confirmations.people': 'Only against people',
  'app.settings.move_confirmations.never': 'Never',
  'app.settings.move_confirmations_help':
    'Ask before a move is sent. With "Only against people", moves against the bot send on drop.',
```

- [ ] **Step 4: Add the row**

In `apps/miniapp/src/ui/screens/Settings.tsx`:

1. Replace the shared import with
   `import { MOVE_CONFIRMATIONS, PrefsSchema, t, type MessageKey, type MoveConfirmations, type Prefs } from '@group-chess/shared';`
   and the dialog import with `import { choiceDialog, confirmDialog, infoDialog } from '../dialog';`.
2. After `TOGGLES`, add:

```ts
const CONFIRMATION_LABEL: Record<MoveConfirmations, MessageKey> = {
  always: 'app.settings.move_confirmations.always',
  people: 'app.settings.move_confirmations.people',
  never: 'app.settings.move_confirmations.never',
};
```

3. Inside `Settings()`, after `update`, add:

```ts
  const pickConfirmations = async () => {
    const picked = await choiceDialog({
      title: t('app.settings.move_confirmations'),
      message: t('app.settings.move_confirmations_help'),
      choices: MOVE_CONFIRMATIONS.map((value) => ({ value, label: t(CONFIRMATION_LABEL[value]) })),
      current: prefs.value.moveConfirmations,
    });
    if (picked === null || picked === prefs.value.moveConfirmations) return;
    tg.hapticSelection();
    await update({ moveConfirmations: picked });
  };
```

4. Make this the first child of the first `<div class="card">`, before `{TOGGLES.map(…)}`:

```tsx
        <button
          class="field pick"
          data-pref="moveConfirmations"
          onClick={() => void pickConfirmations()}
        >
          <span class="grow">{t('app.settings.move_confirmations')}</span>
          <span class="value">{t(CONFIRMATION_LABEL[current.moveConfirmations])}</span>
          <span class="chevron" aria-hidden="true">
            ›
          </span>
        </button>
```

The existing `.card > .field + .field` rule gives the two switch rows their separator.

In `apps/miniapp/src/styles.css`, after the `.card > .field + .field { … }` rule, add:

```css
.field.pick {
  width: 100%;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
}

.field.pick .value {
  color: var(--hint);
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `pnpm vitest run apps/miniapp/test/settings.test.tsx`
Expected: PASS, the existing Settings tests included.

- [ ] **Step 6: Typecheck, lint, format, commit**

Run: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm vitest run apps/miniapp packages/shared`
Expected: clean and PASS.

```bash
git add apps/miniapp/src/ui/screens/Settings.tsx apps/miniapp/src/styles.css apps/miniapp/test/settings.test.tsx packages/shared/src/i18n/en.ts
git commit -F - <<'EOF'
feat(miniapp): a Move confirmations row in Settings

The first row of the preferences card shows the current choice and
opens Telegram's popup (or the in-page list) to pick Always, Only
against people or Never. A change saves at once and reverts with the
error toast if the server refuses it.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 7: End-to-end coverage

**Files:**
- Modify: `apps/miniapp/e2e/support.ts` (`clickSecondary`, `clickSettings`)
- Create: `apps/miniapp/e2e/confirm.spec.ts`
- Modify: `apps/miniapp/e2e/bot.spec.ts` (one assertion)

**Interfaces:**
- Consumes: everything above. `window.__tg.clickSecondary` and `window.__tg.clickSettings`
  already exist in the fake WebApp.
- Produces: `clickSecondary(page)` and `clickSettings(page)` helpers.

- [ ] **Step 1: Add the helpers**

In `apps/miniapp/e2e/support.ts`, after `clickBack`, add:

```ts
export const clickSecondary = (page: Page) => page.evaluate(() => window.__tg!.clickSecondary());
export const clickSettings = (page: Page) => page.evaluate(() => window.__tg!.clickSettings());
```

- [ ] **Step 2: Write the spec**

Create `apps/miniapp/e2e/confirm.spec.ts`:

```ts
import { expect, test } from '@playwright/test';
import {
  clickMain,
  clickSecondary,
  clickSettings,
  dragMove,
  harnessGame,
  openApp,
  seed,
  tgState,
} from './support';

// Move confirmations spec: Alice keeps the default, Only against people, and plays Bob.
const openAsAlice = async (page: Parameters<typeof openApp>[0]) => {
  const world = await seed('fresh', { alice: { closeAfterMove: false } });
  await openApp(page, {
    user: world.users.alice.telegram,
    startParam: `g_${world.game!.publicId}`,
  });
  return world.game!.publicId;
};

test('a move against a person waits for Confirm move, with the tab bar hidden, then is sent', async ({
  page,
}) => {
  const gameId = await openAsAlice(page);
  await expect(page.locator('.tabbar')).toBeVisible();
  await dragMove(page, 'e2', 'e4');
  await expect
    .poll(async () => (await tgState(page)).mainButton)
    .toMatchObject({ text: 'Confirm move', visible: true });
  expect((await tgState(page)).secondaryButton).toMatchObject({ text: 'Cancel', visible: true });
  await expect(page.locator('.tabbar')).toHaveCount(0);
  expect((await harnessGame(gameId)).plyCount).toBe(0);
  await clickMain(page);
  await expect.poll(async () => (await harnessGame(gameId)).plyCount).toBe(1);
  await expect(page.locator('.move-list [data-ply="1"]')).toHaveText('e4');
  await expect.poll(async () => (await tgState(page)).mainButton.visible).toBe(false);
  await expect(page.locator('.tabbar')).toBeVisible();
});

test('Cancel puts the piece back and sends nothing', async ({ page }) => {
  const gameId = await openAsAlice(page);
  await dragMove(page, 'e2', 'e4');
  await expect.poll(async () => (await tgState(page)).secondaryButton?.visible).toBe(true);
  await clickSecondary(page);
  await expect.poll(async () => (await tgState(page)).mainButton.visible).toBe(false);
  expect((await harnessGame(gameId)).plyCount).toBe(0);
  // The pawn is back on e2, so the same move can be played again.
  await dragMove(page, 'e2', 'e4');
  await expect.poll(async () => (await tgState(page)).mainButton.visible).toBe(true);
  await clickMain(page);
  await expect.poll(async () => (await harnessGame(gameId)).plyCount).toBe(1);
});

test('leaving the game with a move waiting cancels it', async ({ page }) => {
  const gameId = await openAsAlice(page);
  await dragMove(page, 'e2', 'e4');
  await expect.poll(async () => (await tgState(page)).mainButton.visible).toBe(true);
  // The tab bar is hidden while the move waits; Telegram's Settings item still selects a tab.
  await clickSettings(page);
  await expect(page.locator('[data-pref="moveConfirmations"]')).toBeVisible();
  const state = await tgState(page);
  expect(state.mainButton.visible).toBe(false);
  expect(state.secondaryButton?.visible).toBe(false);
  await clickMain(page); // nothing is bound any more
  await page.waitForTimeout(500);
  expect((await harnessGame(gameId)).plyCount).toBe(0);
});
```

- [ ] **Step 3: Pin the bot game under the default**

In `apps/miniapp/e2e/bot.spec.ts`, add `tgState` to the import from `'./support'`. Directly after
`await expect(page.locator('.move-list [data-ply="1"]')).not.toBeEmpty();`, add:

```ts
  // Move confirmations default, Only against people: a bot game sends on drop, with no Cancel.
  expect((await tgState(page)).secondaryButton?.visible ?? false).toBe(false);
```

- [ ] **Step 4: Run the whole end-to-end suite**

Run: `pnpm e2e` with `TEST_DATABASE_URL` exported (Task 1, Step 1). It builds the Mini App and
starts the harness. If Chromium isn't found, set `PLAYWRIGHT_CHROMIUM_PATH`, or run
`pnpm --filter @group-chess/miniapp exec playwright install chromium`.
Expected: every spec passes, including the three new ones and the reseeded
`move`, `live`, `fallbacks` and `promotion` specs.

- [ ] **Step 5: Commit**

```bash
git add apps/miniapp/e2e
git commit -F - <<'EOF'
test(e2e): move confirmations end to end

Confirm move sends, Cancel restores and sends nothing, and leaving the
game through Telegram's Settings item drops a waiting move. A bot game
under the default still sends on drop.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 8: Docs, and the full check

**Files:**
- Modify: `docs/PRD.md` (§6.3 step 3, line 102; §7.4 "Confirm moves", line 153; §8.2 Settings, line 274)
- Modify: `docs/superpowers/specs/2026-09-20-group-chess-technical-design.md` (§6.2 row, line 313; §6.3 state machine, lines 322–335; §8 `users` row, line 521)
- Modify: `docs/superpowers/specs/2026-09-22-miniapp-tab-navigation.md` ("Tab bar visibility", lines 93–97)

**Interfaces:** none (docs).

- [ ] **Step 1: The PRD**

In §6.3, replace step 3 with:

```markdown
3. Bob drags a piece (or taps piece then square). Legal targets are shown while he holds the piece. An illegal drop snaps back silently. If **Move confirmations** applies to this game (by default, any game against a person), **Confirm move** and **Cancel** appear in Telegram's bottom bar; otherwise the move is sent on drop.
```

In §7.4, replace the "Confirm moves" bullet with:

```markdown
- **Move confirmations**: user setting, one of Always, Only against people (default) and Never. Moves are permanent and mobile drops are easy to fumble, which matters most against a person; a bot game is many quick moves where the extra tap costs more than a slip. When a move needs confirming it is shown on the board with **Confirm move** / **Cancel** before it is sent, and leaving the game cancels it.
```

In §8.2, replace the Settings bullet with:

```markdown
- **Settings**: move confirmations, return to chat after moving, notifications, board theme and piece set (P1). Group settings for admins.
```

- [ ] **Step 2: The technical design**

§6.2, the Settings row becomes:

```markdown
| Settings (user), a tab of its own | prefs from launch | Move confirmations, return to chat after moving, notifications, board theme and piece set (P1) |
```

§6.3, replace the state-machine code block with:

```
idle ──pick up──▶ dragging ──drop on legal square──▶ [promotion? chooser over target square]
   ▲                  │ drop elsewhere: snap back, no message
   │                  ▼
   │               [needs confirmation?] pendingConfirm: the board holds the move, the tab bar hides,
   │                  │ MainButton "Confirm move", SecondaryButton "Cancel" (in-page below 7.10).
   │                  │ Cancel, leaving the screen, Telegram's deactivated (8.0) or a new ply or status
   │                  │ → snap back, send nothing
   │                  ▼ Confirm move (or no confirmation needed)
   │               sending: POST /api/games/:id/moves { uci, expectedPly, clientMoveId }
   │                  │ 200 → sent: haptic; close_after_move ? show "Sent" 300 ms then close() : stay
   │                  │ 409 stale_state / not_your_turn / expired → reload state, snap back, no message
   │                  │ 422 illegal_move (should not happen; client validated) → snap back, no message
   └──────────────────┘ network error → stay in sending with exponential retry (1 s … 30 s) using the same clientMoveId;
                        MainButton shows "Retry". This is the one visible non-error state; the PRD's "no error messages"
                        covers illegal and out-of-turn input, not a dead network
```

and add this paragraph directly after the block:

```markdown
Whether a move needs confirmation is the `moveConfirmations` preference against the game: `always`, `people` (the default: games with no `engineLevel`) or `never`, read at the drop. See the [move confirmations spec](./2026-09-24-move-confirmations-design.md).
```

§8, in the `users` row, change the `prefs jsonb` list to:
`` `prefs jsonb` (`close_after_move` default true, `notifications` default true, `move_confirmations` default `people`, `board_theme`, `piece_set`) ``

- [ ] **Step 3: The navigation spec**

Replace the paragraph that begins "It shows on the Game screen." with:

```markdown
It shows on the Game screen, except while a move waits for Confirm move. Then Telegram's
MainButton and SecondaryButton carry Confirm move and Cancel below the WebView, and the tab bar
hides so that Telegram's bar takes about the space it frees and the board keeps its size (see
[move confirmations](./2026-09-24-move-confirmations-design.md)). The board is
`min(100vw, stable-height − 200px)` (styles.css); the bar adds itself to that subtraction,
so it costs board area only on screens tall enough that height, not width, was the binding
constraint.
```

- [ ] **Step 4: Run everything**

Run: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm vitest run`
with `TEST_DATABASE_URL` exported.
Expected: all clean, with every unit and integration test passing. Task 7 already ran
`pnpm e2e`. Run it again only if a file under `apps/` changed since then.

- [ ] **Step 5: Commit**

```bash
git add docs/PRD.md docs/superpowers/specs/2026-09-20-group-chess-technical-design.md docs/superpowers/specs/2026-09-22-miniapp-tab-navigation.md
git commit -F - <<'EOF'
docs: move confirmations in the PRD, technical design and navigation spec

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

- [ ] **Step 6: Hand back the manual check**

Tell your human partner the automated work is done, and that the spec's by-hand merge gate is
theirs. On a real iPhone and a real Android phone, open a game against a person and drop a
move. The board should keep its size, or change by a few pixels at most, as Telegram's bar
appears and the tab bar hides. If it jumps noticeably, stop and revisit the tab-bar decision
before merging.
