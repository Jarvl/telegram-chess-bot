# Group Chess 04 — Mini App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `apps/miniapp`, the Telegram Mini App that plays on top of the plan 03 API: one launch request, the lobby, new game, the live board with drag and tap-tap moves, confirm and cancel, promotion, draw and resign controls, replay of finished games, player pages, user and group settings, delete-my-data, theme and version fallbacks — with unit tests in happy-dom and Playwright end-to-end tests that drive the real server against a fake Bot API through a fake `window.Telegram.WebApp`.

**Architecture:** `tg/` (typed wrapper over `telegram-web-app.js` with version gating and a null implementation for plain browsers), `api/` (fetch client with the session token in memory, launch flow, SSE game stream with reconnect and refresh), `state/` (session signals, the pure move state machine, the game store with positions, clocks and banners), `board/` (the only module that imports chessground), `router.ts` (in-memory route stack bound to the BackButton), `ui/` (Preact screens and components, one stylesheet driven by Telegram theme variables). The server gains a CSP header on the app's HTML and a query-token rule for the PGN download; nothing else in plans 01–03 changes.

**Tech Stack:** Preact 10.29 + `@preact/signals` 2.11, chessground 9.2.1 (GPL-3.0-or-later), chess.js 1.4 via `@group-chess/shared`, Vite 8.3 (`base: '/app/'`), vitest 5 with happy-dom 20 for unit tests, Playwright 1.63 with Chromium (touch emulation) for end-to-end tests, the plan 03 server and its `FakeTelegram` as the e2e backend.

**Spec:** [docs/superpowers/specs/2026-09-20-group-chess-technical-design.md](../specs/2026-09-20-group-chess-technical-design.md) §6 (all), §9, §12 (transport and browser), §13, §15, §16; [PRD](../../PRD.md) §5, §6, §7.4, §7.8–§7.12, §8.2, §8.4; parent plan [2026-09-20-group-chess.md](2026-09-20-group-chess.md); consumes plans 01–03.

## Global Constraints

- Launch (spec §6.1): `index.html` loads `https://telegram.org/js/telegram-web-app.js` synchronously before the app bundle; on start `ready()`, `expand()`, theme applied, `disableVerticalSwipes()` when the client is 7.7 or newer; exactly one `POST /api/launch` with `initData`; the write-access prompt runs after the first screen rendered and only when `askWriteAccess` is true and the client is 6.9 or newer; the BackButton is bound to the router; `close()` when the back stack is empty and the app was opened from a game link; a 401 re-runs the launch once with the original `initData`; a launch rejected as unauthorized shows one screen, "Reopen from Telegram".
- Routes and screens exactly as spec §6.2: Groups, Lobby (Active with "your move" first, Finished, Players, pending challenges, admin flag), New game, Game (active and finished on the same route), Replay, Player page, Settings, Group settings. Routes live in memory; the URL never changes, because Telegram owns the fragment.
- Board (spec §6.3, PRD §7.4): `BoardAdapter` is the only module importing chessground; legal destinations come from the shared `legalDests(fen)` (chess.js 1.4); `movable.color` is the viewer's colour only when the game is active, it is their turn and they look at the latest position, otherwise `'none'`; spectators are `viewOnly`; tap-tap (`selectable`) is always on; earlier positions are view-only with a "Latest" affordance; promotion opens a four-piece chooser over the target square.
- Move state machine verbatim from spec §6.3: drop → optional pending-confirm (MainButton "Confirm", SecondaryButton "Cancel" or an in-page Cancel below 7.10, closing confirmation on) → sending `{ uci, expectedPly, clientMoveId }` → 200 sent (haptic; `closeAfterMove` and opened from a game link → "Sent" 300 ms then `close()`); 409 and 422 → reload state, snap back, no message; network error → stay in sending with exponential retry 1 s … 30 s using the same `clientMoveId`, MainButton "Retry". No error text for illegal or out-of-turn input, ever.
- Haptics (spec §6.3): `impactOccurred('light')` on drop, `'medium'` on capture, `notificationOccurred('warning')` on check; skipped below 6.1.
- Live updates (spec §6.4): `EventSource` on `/api/games/:id/events?token=…`; `state` snapshots keyed by version and `ping`; reconnect on `visibilitychange` to visible and `online`, each with one `GET /api/games/:id`; clocks tick locally from `deadlineAt` and the `serverTime` offset, show `0:00` at zero and wait for the server; the client never declares a result; banners derive from the diff between consecutive states.
- Performance (spec §6.5): initial JavaScript ≤ 120 KB gzipped, CSS ≤ 25 KB gzipped; before the first board paint only `index.html`, one JS, one CSS, `telegram-web-app.js` and `POST /api/launch`; enforced by `scripts/check-bundle-size.mjs`.
- Version fallbacks (spec §6.6): `disableVerticalSwipes` 7.7, `requestWriteAccess` 6.9 (else skip), `SecondaryButton` 7.10 (else in-page Cancel), `HapticFeedback` 6.1 (else skip), `downloadFile` 8.0 (else `openLink`).
- Theme and layout (spec §6.7): colours from `themeParams` with fixed light and dark fallbacks; the board keeps its own colours; board width `min(viewport width, stable height − 200 px)`; no horizontal scroll down to 320 px.
- Security (spec §12): CSP `default-src 'self'; script-src 'self' https://telegram.org; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'` on the app's HTML; the session token lives in memory only; no third-party scripts, fonts or analytics; the PGN download takes the token as `?token=` exactly like the SSE route.
- Copy (PRD §8.4): short and chess-literate, SAN, `1-0`, `½-½`; emoji only as button icons; every string in the shared catalog under `app.*` keys; no engine evaluation, hints or annotations anywhere.
- Licence (spec D2, §12): chessground makes the repository GPL-3.0-or-later; the `LICENSE` file and `"license"` fields land in this plan.
- Telemetry (spec §14): `launch_failed`, `move_retry` and `sse_failed` (no `open` within 30 s) go to `POST /api/telemetry`, codes and timings only.

## Review Focus

1. A phone that backgrounds the Mini App for minutes must show the latest position on resume without a manual refresh → Task 2, test "refreshes the state and reopens the stream when the page becomes visible or online again"; Task 6, e2e "shows the latest position after the connection drops and comes back".
2. A spectator, or the player who is not to move, must never lift a piece; nothing is shown → Task 3, test "lets only the player to move move, and only at the latest position"; Task 6, e2e "a spectator cannot lift a piece".
3. A 409 must snap the piece back silently and reload; a dead network must keep the same `clientMoveId` across retries → Task 3, tests "returns to idle and restores the position on a stale rejection", "keeps the client move id and backs off across network retries".
4. Cancel must restore the position and Confirm must send exactly one request → Task 6, e2e "confirms or cancels a move".
5. The bundle must stay inside the spec's budget so the first board paints under 2 s on 4G → Task 6, `node scripts/check-bundle-size.mjs` in the build step.

---

### Task 1: Mini App scaffold, licence, Telegram wrapper, theme and the app catalog

**Files:**
- Create: `apps/miniapp/package.json`, `apps/miniapp/tsconfig.json`, `apps/miniapp/vite.config.ts`, `apps/miniapp/vitest.config.ts`, `apps/miniapp/index.html`, `apps/miniapp/src/main.tsx` (placeholder, replaced in Task 4), `apps/miniapp/src/tg/types.ts`, `apps/miniapp/src/tg/webapp.ts`, `apps/miniapp/src/tg/theme.ts`, `apps/miniapp/src/styles.css`, `apps/miniapp/test/support/fakeWebApp.ts`, `LICENSE`
- Modify: `tsconfig.json` (root references), `package.json`, `apps/server/package.json`, `packages/shared/package.json` (`"license": "GPL-3.0-or-later"`), `packages/shared/src/i18n/en.ts` (the `app.*` keys)
- Test: `apps/miniapp/test/tg.test.ts`

**Interfaces:**
- Consumes: nothing from earlier plans except the catalog.
- Produces: `type TelegramWebApp` (the subset of the Mini App API the app uses, `Window.Telegram`), `type Feature`, `FEATURE_MIN_VERSION`, `versionAtLeast(version, minimum)`, `interface Tg { available; version; platform; initData; startParam; colorScheme; themeParams; stableHeight; supports(feature); ready(); expand(); close(); disableVerticalSwipes(): boolean; closingConfirmation(on); haptic(kind); hapticNotify(kind); setMainButton(spec | null): boolean; setSecondaryButton(spec | null): boolean; setBackButton(visible, onClick); requestWriteAccess(): Promise<boolean | null>; openLink(url); downloadFile(url, fileName): boolean; onViewportChanged(cb): () => void; onThemeChanged(cb): () => void }`, `type ButtonSpec = { text; onClick; progress?; enabled? }`, `createTg(raw?)`; `themeVariables(params, scheme)`, `applyTheme(tg, root?)`; test support `installFakeWebApp(options)` (self-contained, also used by Playwright's `addInitScript`) exposing `window.__tg` with `calls`, `mainButton`, `secondaryButton`, `backButton`, `haptics`, `links`, `downloads`, `closed`, `clickMain()`, `clickSecondary()`, `clickBack()`, `emit(event)`.

- [ ] **Step 1: Package, configs, licence and root wiring**

`apps/miniapp/package.json`:

```json
{
  "name": "@group-chess/miniapp",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "license": "GPL-3.0-or-later",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "e2e": "vite build && playwright test"
  },
  "dependencies": {
    "@group-chess/shared": "workspace:*",
    "@preact/signals": "^2.11.2",
    "chess.js": "1.4.0",
    "chessground": "^9.2.1",
    "preact": "^10.29.8",
    "zod": "^4.6.5"
  },
  "devDependencies": {
    "@playwright/test": "^1.63.0",
    "happy-dom": "^20.14.5",
    "vite": "^8.3.0",
    "vitest": "^5.0.1"
  }
}
```

`apps/miniapp/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "rootDir": ".",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "jsxImportSource": "preact",
    "types": ["vite/client", "node"]
  },
  "include": ["src", "test", "e2e", "vite.config.ts", "vitest.config.ts", "playwright.config.ts"]
}
```

`apps/miniapp/vite.config.ts`:

```ts
import { defineConfig } from 'vite';

/** Served by the server under /app/ (spec §4.4); hashed assets are immutable there. */
export default defineConfig({
  base: '/app/',
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  build: { target: 'es2022', sourcemap: false, reportCompressedSize: true },
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:3000' } },
});
```

`apps/miniapp/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact', jsxDev: false },
  test: {
    name: 'miniapp',
    environment: 'happy-dom',
    include: ['test/**/*.test.{ts,tsx}'],
  },
});
```

`apps/miniapp/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta
      name="viewport"
      content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no"
    />
    <meta name="color-scheme" content="light dark" />
    <title>Group Chess</title>
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
    <script type="module" src="/src/main.tsx"></script>
  </head>
  <body>
    <div id="app"></div>
  </body>
</html>
```

`apps/miniapp/src/main.tsx` (placeholder until Task 4):

```tsx
import { render } from 'preact';
import './styles.css';

render(<main class="screen">Group Chess</main>, document.getElementById('app')!);
```

In the root `tsconfig.json` add `{ "path": "apps/miniapp" }` to `references`. Add `"license": "GPL-3.0-or-later",` after `"private": true,` in the root `package.json`, `apps/server/package.json` and `packages/shared/package.json`.

Run: `pnpm install`
Expected: exit 0 (chessground, preact, signals, happy-dom and Playwright are installed; no browser download happens because `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` is set in this environment).

Then copy the licence text that chessground ships (the verbatim GNU GPL v3):

```bash
cp node_modules/.pnpm/chessground@9.2.1/node_modules/chessground/LICENSE LICENSE
head -3 LICENSE
```

Expected: the first line reads `GNU GENERAL PUBLIC LICENSE` and the second `Version 3, 29 June 2007`.

- [ ] **Step 2: Add the app strings to the shared catalog**

In `packages/shared/src/i18n/en.ts`, add after `'dm.start'`'s entry (before the closing `} as const;`):

```ts
  'colour.random': 'Random',
  'app.common.back': 'Back',
  'app.common.close': 'Close',
  'app.common.retry': 'Retry',
  'app.common.loading': 'Loading…',
  'app.common.error': 'Something went wrong',
  'app.common.offline': "You're offline",
  'app.common.save': 'Save',
  'app.common.saved': 'Saved',
  'app.common.more': 'More',
  'app.reopen.title': 'Reopen from Telegram',
  'app.reopen.body': 'This session has expired. Open the app again from a game card or the bot.',
  'app.locked.title': 'This group is private',
  'app.groups.title': 'Your groups',
  'app.groups.empty': 'No groups yet. Add the bot to a group and open a game card there once.',
  'app.groups.summary': '{active} active · {yourMove} your move',
  'app.lobby.tab.active': 'Active',
  'app.lobby.tab.finished': 'Finished',
  'app.lobby.tab.players': 'Players',
  'app.lobby.new_game': 'New game',
  'app.lobby.settings': 'Group settings',
  'app.lobby.challenges': 'Challenges',
  'app.lobby.no_active': 'No games running.',
  'app.lobby.no_finished': 'No finished games yet.',
  'app.lobby.no_players': 'Nobody has played enough rated games here yet.',
  'app.lobby.your_move': 'Your move',
  'app.lobby.to_move': '{name} to move',
  'app.lobby.challenge.direct': '{challenger} challenges {opponent}',
  'app.lobby.challenge.open': '{challenger} · open challenge',
  'app.lobby.terms': '{timePerMove} · {rated}',
  'app.lobby.void_badge': 'void',
  'app.new.title': 'New game',
  'app.new.opponent': 'Opponent',
  'app.new.open_challenge': 'Open challenge',
  'app.new.time': 'Time per move',
  'app.new.colour': 'Your colour',
  'app.new.rated': 'Rated',
  'app.new.send': 'Send challenge',
  'app.new.sent': 'Challenge posted to the group',
  'app.new.no_players':
    "The bot hasn't seen anyone else here yet. Reply to their message with /play instead.",
  'app.game.your_move': 'Your move',
  'app.game.waiting': 'Waiting for {name}',
  'app.game.latest': 'Latest',
  'app.game.share': 'Share position',
  'app.game.shared': 'Shared to the group',
  'app.game.share_limit': 'One share per minute',
  'app.game.offer_draw': 'Offer draw',
  'app.game.draw_offered': 'Draw offered',
  'app.game.draw_offer_from': '{name} offers a draw',
  'app.game.claim_draw': 'Claim draw',
  'app.game.draw_declined': 'Draw declined',
  'app.game.resign': 'Resign',
  'app.game.resign_confirm': 'Resign this game?',
  'app.game.abort': 'Abort',
  'app.game.abort_confirm': 'Abort this game?',
  'app.game.flip': 'Flip',
  'app.game.confirm': 'Confirm',
  'app.game.cancel': 'Cancel',
  'app.game.sending': 'Sending…',
  'app.game.retry': 'Retry',
  'app.game.sent': 'Sent',
  'app.game.rematch': 'Rematch',
  'app.game.rematch_sent': 'Rematch challenge posted',
  'app.game.analyse': 'Analyse on Lichess',
  'app.game.pgn': 'PGN',
  'app.game.done': 'Done',
  'app.game.void': 'Void game',
  'app.game.void_confirm': 'Void this game? Ratings are recomputed without it.',
  'app.game.voided': 'Voided',
  'app.game.no_clock': 'No clock',
  'app.game.result.win': 'You won',
  'app.game.result.loss': 'You lost',
  'app.game.result.draw': 'Draw',
  'app.game.result.white': 'White won',
  'app.game.result.black': 'Black won',
  'app.game.result.aborted': 'Aborted',
  'app.game.by': 'by {reason}',
  'app.game.promotion': 'Promote to',
  'app.game.no_moves': 'No moves yet',
  'app.player.record': '{wins} W · {draws} D · {losses} L',
  'app.player.head_to_head': 'Against you: {wins} W · {draws} D · {losses} L',
  'app.player.recent': 'Recent games',
  'app.player.games': '{count} games',
  'app.settings.title': 'Settings',
  'app.settings.confirm_moves': 'Confirm moves',
  'app.settings.close_after_move': 'Return to the chat after moving',
  'app.settings.notifications': 'Turn notifications',
  'app.settings.delete': 'Delete my data',
  'app.settings.delete_confirm':
    'Delete your data? Running games are resigned and your name is removed from past games. This cannot be undone.',
  'app.settings.deleted': 'Your data was deleted',
  'app.settings.about':
    'Pieces by Colin M.L. Burnett (CC BY-SA 3.0). Board by chessground. Group Chess is free software under the GPL-3.0-or-later.',
  'app.gsettings.title': 'Group settings',
  'app.gsettings.default_time': 'Default time per move',
  'app.gsettings.rated_default': 'Rated by default',
  'app.gsettings.open': 'Allow open challenges',
  'app.gsettings.max_active': 'Max active games per player',
  'app.gsettings.min_games': 'Leaderboard minimum games',
  'app.gsettings.topic': 'Post cards in',
  'app.gsettings.topic.origin': 'The topic of the challenge',
  'app.gsettings.topic.fixed': 'A fixed topic',
  'app.gsettings.topic_id': 'Topic id',
  'app.gsettings.blocked': 'Blocked players',
  'app.gsettings.none_blocked': 'Nobody is blocked.',
  'app.gsettings.block': 'Block a player',
  'app.gsettings.unblock': 'Unblock',
  'app.gsettings.void': 'Void a game',
```

- [ ] **Step 3: Write the failing wrapper tests**

`apps/miniapp/test/support/fakeWebApp.ts`:

```ts
/**
 * A fake `window.Telegram.WebApp` for unit tests and for Playwright (`page.addInitScript`).
 * The function must stay self-contained: Playwright serialises its source into the page.
 */
export type FakeWebAppOptions = {
  version: string;
  initData: string;
  startParam?: string;
  colorScheme?: 'light' | 'dark';
  themeParams?: Record<string, string>;
  stableHeight?: number;
  platform?: string;
  /** What `requestWriteAccess` answers; undefined means the client has no such method. */
  writeAccess?: boolean;
};

export type FakeButton = {
  text: string;
  visible: boolean;
  progress: boolean;
  enabled: boolean;
};

export type FakeWebAppRecord = {
  calls: string[];
  mainButton: FakeButton;
  secondaryButton: FakeButton | null;
  backButton: { visible: boolean };
  haptics: string[];
  links: string[];
  downloads: { url: string; file_name: string }[];
  closed: boolean;
  closingConfirmation: boolean;
  clickMain(): void;
  clickSecondary(): void;
  clickBack(): void;
  emit(event: string, ...args: unknown[]): void;
  setStableHeight(height: number): void;
};

declare global {
  interface Window {
    __tg?: FakeWebAppRecord;
  }
}

export function installFakeWebApp(options: FakeWebAppOptions): void {
  const atLeast = (version: string, minimum: string): boolean => {
    const a = version.split('.').map((p) => Number.parseInt(p, 10) || 0);
    const b = minimum.split('.').map((p) => Number.parseInt(p, 10) || 0);
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      const x = a[i] ?? 0;
      const y = b[i] ?? 0;
      if (x !== y) return x > y;
    }
    return true;
  };
  const record: FakeWebAppRecord = {
    calls: [],
    mainButton: { text: '', visible: false, progress: false, enabled: true },
    secondaryButton: atLeast(options.version, '7.10')
      ? { text: '', visible: false, progress: false, enabled: true }
      : null,
    backButton: { visible: false },
    haptics: [],
    links: [],
    downloads: [],
    closed: false,
    closingConfirmation: false,
    clickMain: () => {
      for (const cb of [...handlers.main]) cb();
    },
    clickSecondary: () => {
      for (const cb of [...handlers.secondary]) cb();
    },
    clickBack: () => {
      for (const cb of [...handlers.back]) cb();
    },
    emit: (event, ...args) => {
      for (const cb of [...(listeners[event] ?? [])]) cb(...args);
    },
    setStableHeight: (height) => {
      webApp.viewportStableHeight = height;
      webApp.viewportHeight = height;
      record.emit('viewportChanged', { isStateStable: true });
    },
  };
  const handlers = { main: [] as (() => void)[], secondary: [] as (() => void)[], back: [] as (() => void)[] };
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  const button = (state: FakeButton, list: (() => void)[], name: string) => ({
    get isVisible() {
      return state.visible;
    },
    setText: (text: string) => {
      state.text = text;
      record.calls.push(`${name}.setText:${text}`);
    },
    show: () => {
      state.visible = true;
      record.calls.push(`${name}.show`);
    },
    hide: () => {
      state.visible = false;
      record.calls.push(`${name}.hide`);
    },
    onClick: (cb: () => void) => {
      list.push(cb);
    },
    offClick: (cb: () => void) => {
      const at = list.indexOf(cb);
      if (at >= 0) list.splice(at, 1);
    },
    showProgress: () => {
      state.progress = true;
    },
    hideProgress: () => {
      state.progress = false;
    },
    enable: () => {
      state.enabled = true;
    },
    disable: () => {
      state.enabled = false;
    },
  });
  const params = new URLSearchParams(options.initData);
  const rawUser = params.get('user');
  const parseUser = (raw: string): unknown => {
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  };
  const webApp: Record<string, unknown> & { viewportStableHeight: number; viewportHeight: number } = {
    initData: options.initData,
    initDataUnsafe: {
      start_param: options.startParam,
      user: rawUser ? parseUser(rawUser) : undefined,
    },
    version: options.version,
    platform: options.platform ?? 'android',
    colorScheme: options.colorScheme ?? 'light',
    themeParams: options.themeParams ?? {},
    viewportStableHeight: options.stableHeight ?? 720,
    viewportHeight: options.stableHeight ?? 720,
    isExpanded: false,
    ready: () => record.calls.push('ready'),
    expand: () => {
      webApp.isExpanded = true;
      record.calls.push('expand');
    },
    close: () => {
      record.closed = true;
      record.calls.push('close');
    },
    isVersionAtLeast: (v: string) => atLeast(options.version, v),
    onEvent: (event: string, cb: (...args: unknown[]) => void) => {
      (listeners[event] ??= []).push(cb);
    },
    offEvent: (event: string, cb: (...args: unknown[]) => void) => {
      const list = listeners[event] ?? [];
      const at = list.indexOf(cb);
      if (at >= 0) list.splice(at, 1);
    },
    openLink: (url: string) => {
      record.links.push(url);
      record.calls.push(`openLink:${url}`);
    },
    openTelegramLink: (url: string) => {
      record.links.push(url);
    },
    BackButton: {
      get isVisible() {
        return record.backButton.visible;
      },
      show: () => {
        record.backButton.visible = true;
        record.calls.push('BackButton.show');
      },
      hide: () => {
        record.backButton.visible = false;
        record.calls.push('BackButton.hide');
      },
      onClick: (cb: () => void) => {
        handlers.back.push(cb);
      },
      offClick: (cb: () => void) => {
        const at = handlers.back.indexOf(cb);
        if (at >= 0) handlers.back.splice(at, 1);
      },
    },
    MainButton: button(record.mainButton, handlers.main, 'MainButton'),
  };
  if (record.secondaryButton) {
    webApp.SecondaryButton = button(record.secondaryButton, handlers.secondary, 'SecondaryButton');
  }
  if (atLeast(options.version, '6.1')) {
    webApp.HapticFeedback = {
      impactOccurred: (style: string) => record.haptics.push(`impact:${style}`),
      notificationOccurred: (type: string) => record.haptics.push(`notification:${type}`),
      selectionChanged: () => record.haptics.push('selection'),
    };
  }
  if (atLeast(options.version, '6.2')) {
    webApp.enableClosingConfirmation = () => {
      record.closingConfirmation = true;
      record.calls.push('enableClosingConfirmation');
    };
    webApp.disableClosingConfirmation = () => {
      record.closingConfirmation = false;
      record.calls.push('disableClosingConfirmation');
    };
  }
  if (atLeast(options.version, '6.9') && options.writeAccess !== undefined) {
    webApp.requestWriteAccess = (cb?: (granted: boolean) => void) => {
      record.calls.push('requestWriteAccess');
      cb?.(options.writeAccess === true);
    };
  }
  if (atLeast(options.version, '7.7')) {
    webApp.disableVerticalSwipes = () => record.calls.push('disableVerticalSwipes');
    webApp.enableVerticalSwipes = () => record.calls.push('enableVerticalSwipes');
  }
  if (atLeast(options.version, '8.0')) {
    webApp.downloadFile = (
      request: { url: string; file_name: string },
      cb?: (accepted: boolean) => void,
    ) => {
      record.downloads.push(request);
      record.calls.push(`downloadFile:${request.file_name}`);
      cb?.(true);
    };
  }
  (window as unknown as { Telegram: unknown }).Telegram = { WebApp: webApp };
  window.__tg = record;
}
```

`apps/miniapp/test/tg.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { themeVariables } from '../src/tg/theme';
import type { TelegramWebApp } from '../src/tg/types';
import { createTg, FEATURE_MIN_VERSION, versionAtLeast } from '../src/tg/webapp';
import { installFakeWebApp, type FakeWebAppOptions } from './support/fakeWebApp';

const raw = () => (window as unknown as { Telegram: { WebApp: TelegramWebApp } }).Telegram.WebApp;
const tgFor = (options: Partial<FakeWebAppOptions> & { version: string }) => {
  installFakeWebApp({ initData: 'user=%7B%22id%22%3A1%7D&hash=x', ...options });
  return createTg(raw());
};

beforeEach(() => {
  delete window.__tg;
});

describe('versionAtLeast', () => {
  it('compares numerically, so 7.10 is newer than 7.9', () => {
    expect(versionAtLeast('7.10', '7.9')).toBe(true);
    expect(versionAtLeast('7.9', '7.10')).toBe(false);
    expect(versionAtLeast('8.0', '8.0')).toBe(true);
    expect(versionAtLeast('6.0', '6.1')).toBe(false);
  });
});

describe('createTg', () => {
  it('gates every capability by the client version', () => {
    const old = tgFor({ version: '6.0' });
    const fresh = tgFor({ version: '8.0' });
    for (const feature of Object.keys(FEATURE_MIN_VERSION) as (keyof typeof FEATURE_MIN_VERSION)[]) {
      expect(old.supports(feature)).toBe(false);
      expect(fresh.supports(feature)).toBe(true);
    }
  });

  it('disables vertical swipes only from 7.7', () => {
    expect(tgFor({ version: '7.6' }).disableVerticalSwipes()).toBe(false);
    expect(window.__tg!.calls).not.toContain('disableVerticalSwipes');
    expect(tgFor({ version: '7.7' }).disableVerticalSwipes()).toBe(true);
    expect(window.__tg!.calls).toContain('disableVerticalSwipes');
  });

  it('binds one handler at a time to the main button', () => {
    const tg = tgFor({ version: '8.0' });
    let first = 0;
    let second = 0;
    tg.setMainButton({ text: 'One', onClick: () => (first += 1) });
    tg.setMainButton({ text: 'Two', onClick: () => (second += 1), progress: true });
    window.__tg!.clickMain();
    expect([first, second]).toEqual([0, 1]);
    expect(window.__tg!.mainButton).toMatchObject({ text: 'Two', visible: true, progress: true });
    tg.setMainButton(null);
    expect(window.__tg!.mainButton.visible).toBe(false);
  });

  it('offers the secondary button only from 7.10', () => {
    expect(tgFor({ version: '7.9' }).setSecondaryButton({ text: 'Cancel', onClick: () => {} })).toBe(false);
    const tg = tgFor({ version: '7.10' });
    let clicks = 0;
    expect(tg.setSecondaryButton({ text: 'Cancel', onClick: () => (clicks += 1) })).toBe(true);
    window.__tg!.clickSecondary();
    expect(clicks).toBe(1);
    expect(window.__tg!.secondaryButton).toMatchObject({ text: 'Cancel', visible: true });
  });

  it('skips haptics below 6.1 and forwards them from 6.1', () => {
    tgFor({ version: '6.0' }).haptic('light');
    expect(window.__tg!.haptics).toEqual([]);
    const tg = tgFor({ version: '6.1' });
    tg.haptic('medium');
    tg.hapticNotify('warning');
    expect(window.__tg!.haptics).toEqual(['impact:medium', 'notification:warning']);
  });

  it('answers null for write access below 6.9 and the client answer from 6.9', async () => {
    expect(await tgFor({ version: '6.8', writeAccess: true }).requestWriteAccess()).toBeNull();
    expect(await tgFor({ version: '6.9', writeAccess: true }).requestWriteAccess()).toBe(true);
    expect(await tgFor({ version: '6.9', writeAccess: false }).requestWriteAccess()).toBe(false);
  });

  it('downloads files only from 8.0', () => {
    expect(tgFor({ version: '7.11' }).downloadFile('https://x/g.pgn', 'g.pgn')).toBe(false);
    expect(window.__tg!.downloads).toEqual([]);
    expect(tgFor({ version: '8.0' }).downloadFile('https://x/g.pgn', 'g.pgn')).toBe(true);
    expect(window.__tg!.downloads).toEqual([{ url: 'https://x/g.pgn', file_name: 'g.pgn' }]);
  });

  it('shows and hides the back button with a single handler', () => {
    const tg = tgFor({ version: '8.0' });
    let backs = 0;
    tg.setBackButton(true, () => (backs += 1));
    tg.setBackButton(true, () => (backs += 10));
    window.__tg!.clickBack();
    expect(backs).toBe(10);
    tg.setBackButton(false, () => undefined);
    expect(window.__tg!.backButton.visible).toBe(false);
  });

  it('reports viewport changes', () => {
    const tg = tgFor({ version: '8.0', stableHeight: 700 });
    const seen: number[] = [];
    const off = tg.onViewportChanged((height) => seen.push(height));
    window.__tg!.setStableHeight(640);
    off();
    window.__tg!.setStableHeight(600);
    expect(seen).toEqual([640]);
  });

  it('is a null client outside Telegram', () => {
    const tg = createTg(null);
    expect(tg.available).toBe(false);
    expect(tg.supports('haptics')).toBe(false);
    expect(tg.setMainButton({ text: 'x', onClick: () => undefined })).toBe(false);
    expect(tg.initData).toBe('');
  });
});

describe('themeVariables', () => {
  it('takes Telegram colours and falls back per scheme', () => {
    const dark = themeVariables({ bg_color: '#101010' }, 'dark');
    expect(dark['--bg']).toBe('#101010');
    expect(dark['--text']).toBe('#ffffff');
    const light = themeVariables({}, 'light');
    expect(light['--bg']).toBe('#ffffff');
    expect(light['--button']).toBe('#2481cc');
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `pnpm vitest run --project miniapp`
Expected: FAIL — cannot resolve `../src/tg/theme` and `../src/tg/webapp`.

- [ ] **Step 5: Write the wrapper, the theme and the stylesheet**

`apps/miniapp/src/tg/types.ts`:

```ts
/** The subset of the Telegram Mini Apps API this app uses (Bot API 6.0 – 8.0 surface). */
export type ThemeParams = Partial<
  Record<
    | 'bg_color'
    | 'text_color'
    | 'hint_color'
    | 'link_color'
    | 'button_color'
    | 'button_text_color'
    | 'secondary_bg_color'
    | 'header_bg_color'
    | 'accent_text_color'
    | 'section_bg_color'
    | 'subtitle_text_color'
    | 'destructive_text_color',
    string
  >
>;

export type TelegramButton = {
  readonly isVisible: boolean;
  setText(text: string): void;
  show(): void;
  hide(): void;
  onClick(callback: () => void): void;
  offClick(callback: () => void): void;
  showProgress(leaveActive?: boolean): void;
  hideProgress(): void;
  enable(): void;
  disable(): void;
};

export type TelegramUser = {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
};

export type TelegramWebApp = {
  initData: string;
  initDataUnsafe: { start_param?: string; user?: TelegramUser };
  version: string;
  platform: string;
  colorScheme: 'light' | 'dark';
  themeParams: ThemeParams;
  viewportHeight: number;
  viewportStableHeight: number;
  isExpanded: boolean;
  ready(): void;
  expand(): void;
  close(): void;
  isVersionAtLeast?(version: string): boolean;
  onEvent(event: string, callback: (...args: unknown[]) => void): void;
  offEvent(event: string, callback: (...args: unknown[]) => void): void;
  openLink(url: string, options?: { try_instant_view?: boolean }): void;
  openTelegramLink(url: string): void;
  BackButton: {
    readonly isVisible: boolean;
    show(): void;
    hide(): void;
    onClick(callback: () => void): void;
    offClick(callback: () => void): void;
  };
  MainButton: TelegramButton;
  SecondaryButton?: TelegramButton;
  HapticFeedback?: {
    impactOccurred(style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'): void;
    notificationOccurred(type: 'error' | 'success' | 'warning'): void;
    selectionChanged(): void;
  };
  enableClosingConfirmation?(): void;
  disableClosingConfirmation?(): void;
  disableVerticalSwipes?(): void;
  enableVerticalSwipes?(): void;
  requestWriteAccess?(callback?: (granted: boolean) => void): void;
  downloadFile?(
    request: { url: string; file_name: string },
    callback?: (accepted: boolean) => void,
  ): void;
};

declare global {
  interface Window {
    Telegram?: { WebApp: TelegramWebApp };
  }
}
```

`apps/miniapp/src/tg/webapp.ts`:

```ts
import type { TelegramButton, TelegramWebApp, ThemeParams } from './types';

export type Feature =
  | 'haptics'
  | 'closingConfirmation'
  | 'writeAccess'
  | 'verticalSwipes'
  | 'secondaryButton'
  | 'downloadFile';

/** Spec §6.6: the first Bot API version that has each capability. */
export const FEATURE_MIN_VERSION: Record<Feature, string> = {
  haptics: '6.1',
  closingConfirmation: '6.2',
  writeAccess: '6.9',
  verticalSwipes: '7.7',
  secondaryButton: '7.10',
  downloadFile: '8.0',
};

export function versionAtLeast(version: string, minimum: string): boolean {
  const a = version.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const b = minimum.split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

export type HapticImpact = 'light' | 'medium' | 'heavy';
export type HapticNotification = 'success' | 'warning' | 'error';

export type ButtonSpec = {
  text: string;
  onClick: () => void;
  /** Shows the spinner and disables the button while true. */
  progress?: boolean;
  enabled?: boolean;
};

export interface Tg {
  /** False in a plain browser: every capability is off and buttons are rendered in-page. */
  readonly available: boolean;
  readonly version: string;
  readonly platform: string;
  readonly initData: string;
  readonly startParam: string | null;
  readonly colorScheme: 'light' | 'dark';
  readonly themeParams: ThemeParams;
  readonly stableHeight: number;
  supports(feature: Feature): boolean;
  ready(): void;
  expand(): void;
  close(): void;
  /** True when the client supports it and it was called. */
  disableVerticalSwipes(): boolean;
  closingConfirmation(on: boolean): void;
  haptic(kind: HapticImpact): void;
  hapticNotify(kind: HapticNotification): void;
  /** False when the client has no such button; the caller renders one in the page. */
  setMainButton(spec: ButtonSpec | null): boolean;
  setSecondaryButton(spec: ButtonSpec | null): boolean;
  setBackButton(visible: boolean, onClick: () => void): void;
  /** null when the client cannot ask (below 6.9). */
  requestWriteAccess(): Promise<boolean | null>;
  openLink(url: string): void;
  /** False when the client cannot download (below 8.0); the caller opens the link instead. */
  downloadFile(url: string, fileName: string): boolean;
  onViewportChanged(callback: (stableHeight: number) => void): () => void;
  onThemeChanged(callback: () => void): () => void;
}

class ButtonBinding {
  private handler: (() => void) | null = null;

  constructor(private readonly button: TelegramButton | undefined) {}

  set(spec: ButtonSpec | null): boolean {
    const { button } = this;
    if (!button) return false;
    if (this.handler) button.offClick(this.handler);
    this.handler = null;
    if (!spec) {
      button.hide();
      return true;
    }
    this.handler = spec.onClick;
    button.setText(spec.text);
    button.onClick(spec.onClick);
    if (spec.enabled === false) button.disable();
    else button.enable();
    if (spec.progress) button.showProgress(false);
    else button.hideProgress();
    button.show();
    return true;
  }
}

function nullTg(): Tg {
  return {
    available: false,
    version: '0.0',
    platform: 'unknown',
    initData: '',
    startParam: null,
    colorScheme:
      typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light',
    themeParams: {},
    stableHeight: typeof window === 'undefined' ? 0 : window.innerHeight,
    supports: () => false,
    ready: () => undefined,
    expand: () => undefined,
    close: () => undefined,
    disableVerticalSwipes: () => false,
    closingConfirmation: () => undefined,
    haptic: () => undefined,
    hapticNotify: () => undefined,
    setMainButton: () => false,
    setSecondaryButton: () => false,
    setBackButton: () => undefined,
    requestWriteAccess: () => Promise.resolve(null),
    openLink: (url) => {
      window.open(url, '_blank', 'noopener');
    },
    downloadFile: () => false,
    onViewportChanged: () => () => undefined,
    onThemeChanged: () => () => undefined,
  };
}

/** Wraps the real `window.Telegram.WebApp`; without one (a plain browser) every capability is off. */
export function createTg(
  raw: TelegramWebApp | null | undefined = typeof window === 'undefined'
    ? null
    : window.Telegram?.WebApp,
): Tg {
  if (!raw) return nullTg();
  const supports = (feature: Feature): boolean =>
    versionAtLeast(raw.version, FEATURE_MIN_VERSION[feature]);
  const main = new ButtonBinding(raw.MainButton);
  const secondary = new ButtonBinding(supports('secondaryButton') ? raw.SecondaryButton : undefined);
  let backHandler: (() => void) | null = null;
  return {
    available: true,
    get version() {
      return raw.version;
    },
    get platform() {
      return raw.platform;
    },
    get initData() {
      return raw.initData;
    },
    get startParam() {
      return raw.initDataUnsafe?.start_param ?? null;
    },
    get colorScheme() {
      return raw.colorScheme === 'dark' ? 'dark' : 'light';
    },
    get themeParams() {
      return raw.themeParams ?? {};
    },
    get stableHeight() {
      return raw.viewportStableHeight || window.innerHeight;
    },
    supports,
    ready: () => raw.ready(),
    expand: () => raw.expand(),
    close: () => raw.close(),
    disableVerticalSwipes() {
      if (!supports('verticalSwipes') || !raw.disableVerticalSwipes) return false;
      raw.disableVerticalSwipes();
      return true;
    },
    closingConfirmation(on) {
      if (!supports('closingConfirmation')) return;
      if (on) raw.enableClosingConfirmation?.();
      else raw.disableClosingConfirmation?.();
    },
    haptic(kind) {
      if (supports('haptics')) raw.HapticFeedback?.impactOccurred(kind);
    },
    hapticNotify(kind) {
      if (supports('haptics')) raw.HapticFeedback?.notificationOccurred(kind);
    },
    setMainButton: (spec) => main.set(spec),
    setSecondaryButton: (spec) => secondary.set(spec),
    setBackButton(visible, onClick) {
      if (backHandler) raw.BackButton.offClick(backHandler);
      backHandler = onClick;
      raw.BackButton.onClick(onClick);
      if (visible) raw.BackButton.show();
      else raw.BackButton.hide();
    },
    requestWriteAccess() {
      if (!supports('writeAccess') || !raw.requestWriteAccess) return Promise.resolve(null);
      return new Promise((resolve) => raw.requestWriteAccess!((granted) => resolve(granted)));
    },
    openLink: (url) => raw.openLink(url),
    downloadFile(url, fileName) {
      if (!supports('downloadFile') || !raw.downloadFile) return false;
      raw.downloadFile({ url, file_name: fileName });
      return true;
    },
    onViewportChanged(callback) {
      const handler = (): void => callback(raw.viewportStableHeight || window.innerHeight);
      raw.onEvent('viewportChanged', handler);
      return () => raw.offEvent('viewportChanged', handler);
    },
    onThemeChanged(callback) {
      raw.onEvent('themeChanged', callback);
      return () => raw.offEvent('themeChanged', callback);
    },
  };
}
```

`apps/miniapp/src/tg/theme.ts`:

```ts
import type { ThemeParams } from './types';
import type { Tg } from './webapp';

/** Spec §6.7: Telegram's colours with a fixed palette per scheme when a key is missing. */
export const FALLBACK_THEME = {
  light: {
    bg: '#ffffff',
    text: '#000000',
    hint: '#707579',
    link: '#2481cc',
    button: '#2481cc',
    buttonText: '#ffffff',
    secondaryBg: '#f1f1f4',
    destructive: '#d14e4e',
  },
  dark: {
    bg: '#18222d',
    text: '#ffffff',
    hint: '#8b9aa8',
    link: '#6ab2f2',
    button: '#2ea6ff',
    buttonText: '#ffffff',
    secondaryBg: '#131b23',
    destructive: '#ef5b5b',
  },
} as const;

export function themeVariables(
  params: ThemeParams,
  scheme: 'light' | 'dark',
): Record<string, string> {
  const fallback = FALLBACK_THEME[scheme];
  return {
    '--bg': params.bg_color ?? fallback.bg,
    '--text': params.text_color ?? fallback.text,
    '--hint': params.hint_color ?? fallback.hint,
    '--link': params.link_color ?? fallback.link,
    '--button': params.button_color ?? fallback.button,
    '--button-text': params.button_text_color ?? fallback.buttonText,
    '--secondary-bg': params.secondary_bg_color ?? fallback.secondaryBg,
    '--destructive': params.destructive_text_color ?? fallback.destructive,
  };
}

/** Writes the theme and the stable viewport height as CSS custom properties on the root. */
export function applyTheme(tg: Tg, root: HTMLElement = document.documentElement): void {
  for (const [name, value] of Object.entries(themeVariables(tg.themeParams, tg.colorScheme))) {
    root.style.setProperty(name, value);
  }
  root.dataset.theme = tg.colorScheme;
  root.style.setProperty('--stable-height', `${tg.stableHeight}px`);
}
```

`apps/miniapp/src/styles.css`:

```css
@import 'chessground/assets/chessground.base.css';
@import 'chessground/assets/chessground.brown.css';
@import 'chessground/assets/chessground.cburnett.css';

:root {
  --bg: #ffffff;
  --text: #000000;
  --hint: #707579;
  --link: #2481cc;
  --button: #2481cc;
  --button-text: #ffffff;
  --secondary-bg: #f1f1f4;
  --destructive: #d14e4e;
  --stable-height: 100vh;
  --radius: 12px;
  color-scheme: light dark;
}

* {
  box-sizing: border-box;
}

html,
body {
  margin: 0;
  padding: 0;
  background: var(--bg);
  color: var(--text);
  font:
    16px/1.4 -apple-system,
    system-ui,
    'Segoe UI',
    Roboto,
    sans-serif;
  -webkit-text-size-adjust: 100%;
  overscroll-behavior: none;
}

body {
  min-width: 320px;
  overflow-x: hidden;
}

button {
  font: inherit;
}

.screen {
  padding: 12px 12px 24px;
  max-width: 640px;
  margin: 0 auto;
}

.title {
  font-size: 20px;
  font-weight: 600;
  margin: 4px 0 12px;
}

.subtitle {
  color: var(--hint);
  font-size: 14px;
  margin: 0 0 12px;
}

.hint {
  color: var(--hint);
  font-size: 14px;
}

.section {
  margin: 16px 0 8px;
  font-size: 13px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--hint);
}

.list {
  background: var(--secondary-bg);
  border-radius: var(--radius);
  overflow: hidden;
}

.row {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 12px 14px;
  border: 0;
  border-bottom: 1px solid color-mix(in srgb, var(--hint) 20%, transparent);
  background: transparent;
  color: inherit;
  text-align: left;
}

.row:last-child {
  border-bottom: 0;
}

.row .grow {
  flex: 1;
  min-width: 0;
}

.row .primary {
  display: block;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.row .secondary {
  display: block;
  font-size: 13px;
  color: var(--hint);
}

.badge {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--button);
  color: var(--button-text);
  white-space: nowrap;
}

.badge.muted {
  background: color-mix(in srgb, var(--hint) 30%, transparent);
  color: var(--text);
}

.tabs {
  display: flex;
  gap: 6px;
  margin: 0 0 12px;
}

.tab {
  flex: 1;
  padding: 8px 0;
  border: 0;
  border-radius: 999px;
  background: var(--secondary-bg);
  color: var(--text);
}

.tab[aria-selected='true'] {
  background: var(--button);
  color: var(--button-text);
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 10px 14px;
  border: 0;
  border-radius: var(--radius);
  background: var(--button);
  color: var(--button-text);
  font-weight: 600;
}

.btn.secondary {
  background: var(--secondary-bg);
  color: var(--text);
}

.btn.danger {
  background: var(--secondary-bg);
  color: var(--destructive);
}

.btn.block {
  display: flex;
  width: 100%;
  margin: 12px 0;
}

.btn:disabled {
  opacity: 0.5;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 12px 0;
}

.field {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
}

.field select,
.field input[type='number'] {
  font: inherit;
  padding: 6px 8px;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--hint) 40%, transparent);
  background: var(--bg);
  color: var(--text);
  max-width: 50%;
}

.switch {
  position: relative;
  width: 44px;
  height: 26px;
  border-radius: 13px;
  border: 0;
  background: color-mix(in srgb, var(--hint) 40%, transparent);
  flex: none;
}

.switch[aria-checked='true'] {
  background: var(--button);
}

.switch::after {
  content: '';
  position: absolute;
  top: 3px;
  left: 3px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #fff;
  transition: left 0.15s;
}

.switch[aria-checked='true']::after {
  left: 21px;
}

.segmented {
  display: inline-flex;
  border-radius: 999px;
  background: var(--secondary-bg);
  padding: 2px;
}

.segmented button {
  border: 0;
  background: transparent;
  color: var(--text);
  padding: 6px 12px;
  border-radius: 999px;
}

.segmented button[aria-pressed='true'] {
  background: var(--button);
  color: var(--button-text);
}

.toast {
  position: fixed;
  left: 50%;
  bottom: 24px;
  transform: translateX(-50%);
  background: color-mix(in srgb, var(--text) 85%, transparent);
  color: var(--bg);
  padding: 10px 16px;
  border-radius: 999px;
  font-size: 14px;
  z-index: 20;
  max-width: calc(100vw - 32px);
}

.dialog-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: flex-end;
  justify-content: center;
  z-index: 30;
}

.dialog {
  width: 100%;
  max-width: 640px;
  background: var(--bg);
  border-radius: var(--radius) var(--radius) 0 0;
  padding: 16px 16px 24px;
}

.dialog p {
  margin: 0 0 16px;
}

.centered {
  min-height: 60vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: 12px;
}

/* Game screen (Task 5) */
.game {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 0 24px;
}

.board-wrap {
  position: relative;
  width: min(100vw, calc(var(--stable-height) - 200px));
  max-width: 640px;
  min-width: 280px;
  aspect-ratio: 1;
  margin: 0 auto;
}

.board-wrap .cg-wrap {
  width: 100%;
  height: 100%;
}

.player-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 12px;
}

.player-bar .name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.player-bar .rating {
  color: var(--hint);
  font-size: 14px;
  margin-left: 6px;
}

.clock {
  font-variant-numeric: tabular-nums;
  padding: 4px 10px;
  border-radius: 8px;
  background: var(--secondary-bg);
  min-width: 72px;
  text-align: center;
}

.clock.active {
  background: var(--button);
  color: var(--button-text);
}

.clock.urgent {
  background: var(--destructive);
  color: #fff;
}

.move-list {
  display: flex;
  gap: 4px;
  overflow-x: auto;
  padding: 4px 12px;
  scrollbar-width: none;
  font-variant-numeric: tabular-nums;
}

.move-list button {
  border: 0;
  background: transparent;
  color: inherit;
  padding: 4px 6px;
  border-radius: 6px;
  white-space: nowrap;
}

.move-list button[aria-current='true'] {
  background: var(--secondary-bg);
  font-weight: 600;
}

.move-list .number {
  color: var(--hint);
  padding: 4px 0 4px 6px;
}

.replay-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
}

.replay-controls input[type='range'] {
  flex: 1;
}

.banner {
  margin: 0 12px;
  padding: 10px 14px;
  border-radius: var(--radius);
  background: var(--secondary-bg);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.banner .grow {
  flex: 1;
}

.banner.result {
  font-weight: 600;
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 0 12px;
}

.toolbar .btn {
  padding: 8px 12px;
  font-weight: 500;
}

.promotion {
  position: absolute;
  width: 12.5%;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.35);
  border-radius: 6px;
  z-index: 10;
}

.promotion button {
  width: 100%;
  aspect-ratio: 1;
  border: 0;
  background: transparent;
  background-size: cover;
}

.inline-main {
  position: sticky;
  bottom: 0;
  padding: 8px 12px 12px;
  background: var(--bg);
  display: flex;
  gap: 8px;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run --project miniapp`
Expected: PASS — 12 tests.

- [ ] **Step 7: Build once and run the whole suite and the static checks**

Run: `pnpm --filter @group-chess/miniapp build && pnpm test && pnpm typecheck && pnpm lint && pnpm format:check`
Expected: the build writes `apps/miniapp/dist/index.html` plus one JS and one CSS asset; everything else exits 0.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(miniapp): scaffold the Mini App with the Telegram wrapper, theme, catalog and licence"
```

---

### Task 2: API client, launch flow, session state and the live game stream

**Files:**
- Create: `apps/miniapp/src/api/client.ts`, `apps/miniapp/src/api/launch.ts`, `apps/miniapp/src/api/stream.ts`, `apps/miniapp/src/state/session.ts`, `apps/miniapp/test/support/fakeFetch.ts`, `apps/miniapp/test/support/fakeEventSource.ts`
- Test: `apps/miniapp/test/client.test.ts`, `apps/miniapp/test/launch.test.ts`, `apps/miniapp/test/stream.test.ts`

**Interfaces:**
- Consumes: shared `ApiErrorBodySchema`, `ErrorCode`, `LaunchResponseSchema`, `GameDtoSchema`, `decodeStartParam`, `PREFS_DEFAULTS`; Task 1 `Tg` (only for `initData`).
- Produces: `class ApiError extends Error { status; code: ErrorCode | 'network'; isNetwork }`, `interface ApiClient { token; setToken(token); request(method, path, { body?, schema?, auth? }); get(path, schema); post(path, body, schema?); put(path, body, schema?); del(path, schema?); url(path, query?) }`, `createApiClient({ baseUrl?, fetch?, onUnauthorized? })`; `launch(client, initData): Promise<LaunchOutcome>` with `LaunchOutcome = { kind: 'ok'; response } | { kind: 'expired' } | { kind: 'failed'; error }`; signals `session`, `prefs`, `serverOffsetMs`, `applyLaunch(response, startParam)`, `serverNow()`; `class GameStream { start(); stop(); connected }` with `StreamOptions = { url; refresh; onState; onFailure?; createEventSource?; failureTimeoutMs?; doc?; win? }`, `type EventSourceLike`; test doubles `fakeFetch(routes)` and `FakeEventSource`.

- [ ] **Step 1: Write the failing tests**

`apps/miniapp/test/support/fakeFetch.ts`:

```ts
export type FakeResponse = { status: number; body?: unknown };
export type FakeRoute = (input: { method: string; path: string; headers: Headers; body: unknown }) => FakeResponse;

/** A `fetch` double: records every call and answers from a handler; `body: null` means no JSON body. */
export function fakeFetch(handler: FakeRoute): {
  fetch: typeof fetch;
  calls: { method: string; path: string; headers: Headers; body: unknown }[];
} {
  const calls: { method: string; path: string; headers: Headers; body: unknown }[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
    const call = { method: init?.method ?? 'GET', path, headers, body };
    calls.push(call);
    const answer = handler(call);
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
      status: answer.status,
      headers: answer.body === undefined ? {} : { 'content-type': 'application/json' },
    });
  };
  return { fetch: fetchImpl as typeof fetch, calls };
}
```

`apps/miniapp/test/support/fakeEventSource.ts`:

```ts
import type { EventSourceLike } from '../../src/api/stream';

type Listener = (event: MessageEvent | Event) => void;

/** Stands in for the browser's EventSource; tests drive `open`, `state`, `ping` and `error`. */
export class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = [];
  readyState = 0;
  closed = false;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  static reset(): void {
    FakeEventSource.instances = [];
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  open(): void {
    this.readyState = 1;
    this.emit('open', new Event('open'));
  }

  send(type: 'state' | 'ping', data: unknown, id?: string): void {
    this.emit(type, new MessageEvent(type, { data: typeof data === 'string' ? data : JSON.stringify(data), lastEventId: id }));
  }

  fail(fatal = false): void {
    if (fatal) this.readyState = 2;
    this.emit('error', new Event('error'));
  }

  private emit(type: string, event: MessageEvent | Event): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
}
```

`apps/miniapp/test/client.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ApiError, createApiClient } from '../src/api/client';
import { fakeFetch } from './support/fakeFetch';

const Hello = z.object({ hello: z.string() });

describe('createApiClient', () => {
  it('sends the bearer token, JSON bodies and parses responses with the schema', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: { hello: 'world', extra: 1 } }));
    const client = createApiClient({ fetch });
    client.setToken('tok');
    const out = await client.post('/api/echo', { a: 1 }, Hello);
    expect(out).toEqual({ hello: 'world' }); // the schema strips unknown keys
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/api/echo', body: { a: 1 } });
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer tok');
    expect(calls[0]?.headers.get('content-type')).toBe('application/json');
  });

  it('turns an error body into an ApiError with its code and status', async () => {
    const { fetch } = fakeFetch(() => ({
      status: 409,
      body: { error: { code: 'stale_state', message: 'the position has changed' } },
    }));
    const client = createApiClient({ fetch });
    await expect(client.get('/api/games/x', Hello)).rejects.toMatchObject({
      name: 'ApiError',
      status: 409,
      code: 'stale_state',
      message: 'the position has changed',
    });
  });

  it('treats a non-JSON failure as internal', async () => {
    const { fetch } = fakeFetch(() => ({ status: 502 }));
    await expect(createApiClient({ fetch }).get('/api/x', Hello)).rejects.toMatchObject({
      status: 502,
      code: 'internal',
    });
  });

  it('retries once with a fresh token after a 401', async () => {
    let attempts = 0;
    const { fetch, calls } = fakeFetch(({ headers }) => {
      attempts += 1;
      return headers.get('authorization') === 'Bearer fresh'
        ? { status: 200, body: { hello: 'again' } }
        : { status: 401, body: { error: { code: 'unauthorized', message: 'expired' } } };
    });
    const client = createApiClient({ fetch, onUnauthorized: async () => 'fresh' });
    client.setToken('stale');
    expect(await client.get('/api/me/groups', Hello)).toEqual({ hello: 'again' });
    expect(attempts).toBe(2);
    expect(calls[1]?.headers.get('authorization')).toBe('Bearer fresh');
    expect(client.token).toBe('fresh');
  });

  it('gives up when the relaunch yields no token', async () => {
    const { fetch, calls } = fakeFetch(() => ({
      status: 401,
      body: { error: { code: 'unauthorized', message: 'expired' } },
    }));
    const client = createApiClient({ fetch, onUnauthorized: async () => null });
    client.setToken('stale');
    await expect(client.get('/api/me/groups', Hello)).rejects.toMatchObject({ status: 401 });
    expect(calls).toHaveLength(1);
  });

  it('wraps a dead network as a network ApiError', async () => {
    const client = createApiClient({
      fetch: (async () => {
        throw new TypeError('Failed to fetch');
      }) as typeof fetch,
    });
    const error = await client.get('/api/x', Hello).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).isNetwork).toBe(true);
    expect((error as ApiError).status).toBe(0);
  });

  it('builds urls with a query for EventSource and downloads', () => {
    const client = createApiClient({ baseUrl: 'https://chess.test' });
    expect(client.url('/api/games/abc/events', { token: 'a b' })).toBe(
      'https://chess.test/api/games/abc/events?token=a+b',
    );
    expect(createApiClient({}).url('/api/x')).toBe('/api/x');
  });
});
```

`apps/miniapp/test/launch.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createApiClient } from '../src/api/client';
import { launch } from '../src/api/launch';
import { applyLaunch, prefs, serverNow, session } from '../src/state/session';
import { fakeFetch } from './support/fakeFetch';

const response = {
  token: 'jwt',
  user: { id: '7', name: 'Alice', username: 'alice' },
  prefs: {
    confirmMoves: false,
    closeAfterMove: true,
    notifications: true,
    boardTheme: null,
    pieceSet: null,
  },
  askWriteAccess: true,
  route: { kind: 'groups', groups: { groups: [] } },
  serverTime: new Date(Date.now() + 5_000).toISOString(),
  bot: { username: 'TestChessBot', miniAppShortName: 'chess' },
};

describe('launch', () => {
  it('posts the init data, stores the token and applies the session', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: response }));
    const client = createApiClient({ fetch });
    const outcome = await launch(client, 'user=x&hash=y');
    expect(outcome.kind).toBe('ok');
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/api/launch', body: { initData: 'user=x&hash=y' } });
    expect(calls[0]?.headers.get('authorization')).toBeNull();
    expect(client.token).toBe('jwt');
    if (outcome.kind !== 'ok') throw new Error('unreachable');
    applyLaunch(outcome.response, 'g_AbCdEfGhIj');
    expect(session.value).toMatchObject({
      user: { id: '7', name: 'Alice' },
      launchedFrom: { kind: 'game', gameId: 'AbCdEfGhIj' },
    });
    expect(prefs.value.confirmMoves).toBe(false);
    expect(Math.abs(serverNow().getTime() - Date.now() - 5_000)).toBeLessThan(1_000);
  });

  it('reports an expired launch on 401 and a failure otherwise', async () => {
    const unauthorized = fakeFetch(() => ({
      status: 401,
      body: { error: { code: 'unauthorized', message: 'stale' } },
    }));
    expect((await launch(createApiClient({ fetch: unauthorized.fetch }), 'x')).kind).toBe('expired');
    const broken = fakeFetch(() => ({ status: 500, body: { error: { code: 'internal', message: 'x' } } }));
    const outcome = await launch(createApiClient({ fetch: broken.fetch }), 'x');
    expect(outcome.kind).toBe('failed');
  });
});
```

`apps/miniapp/test/stream.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GameDto } from '@group-chess/shared';
import { GameStream } from '../src/api/stream';
import { FakeEventSource } from './support/fakeEventSource';

const dto = (version: number): GameDto => ({
  id: 'AbCdEfGhIj',
  group: { id: 'GrOuPiDxYz', title: 'G' },
  status: 'active',
  white: { id: '1', name: 'A', username: null, rating: 1500, provisional: true, ratingAfter: null, provisionalAfter: null },
  black: { id: '2', name: 'B', username: null, rating: 1500, provisional: true, ratingAfter: null, provisionalAfter: null },
  timePerMove: 86400,
  rated: true,
  fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  plyCount: 0,
  version,
  moves: [],
  deadlineAt: null,
  serverTime: new Date().toISOString(),
  drawOffer: null,
  claims: { threefold: false, fiftyMove: false },
  viewerRole: 'spectator',
  result: null,
  endReason: null,
  voided: false,
  startedAt: new Date().toISOString(),
  finishedAt: null,
});

let visibility: 'visible' | 'hidden' = 'visible';

function streamWith(overrides: Partial<ConstructorParameters<typeof GameStream>[0]> = {}) {
  const states: number[] = [];
  const refresh = vi.fn(async () => dto(9));
  const failures = vi.fn();
  const stream = new GameStream({
    url: '/api/games/AbCdEfGhIj/events?token=t',
    refresh,
    onState: (state) => states.push(state.version),
    onFailure: failures,
    createEventSource: (url) => new FakeEventSource(url),
    ...overrides,
  });
  return { stream, states, refresh, failures };
}

beforeEach(() => {
  FakeEventSource.reset();
  vi.useFakeTimers();
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('GameStream', () => {
  it('delivers state events, ignores pings and rejects malformed data', () => {
    const { stream, states } = streamWith();
    stream.start();
    const source = FakeEventSource.instances[0]!;
    expect(source.url).toBe('/api/games/AbCdEfGhIj/events?token=t');
    source.open();
    source.send('state', dto(3), '3');
    source.send('ping', '');
    source.send('state', '{not json', '4');
    source.send('state', { nonsense: true }, '5');
    expect(states).toEqual([3]);
    expect(stream.connected).toBe(true);
  });

  it('refreshes the state and reopens the stream when the page becomes visible or online again', async () => {
    const { stream, states, refresh } = streamWith();
    stream.start();
    const first = FakeEventSource.instances[0]!;
    first.open();
    first.close();
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(states).toEqual([9]);
    expect(FakeEventSource.instances).toHaveLength(2);

    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it('does nothing when the page merely becomes hidden', async () => {
    const { stream, refresh } = streamWith();
    stream.start();
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('reopens with backoff after the browser gave up on the connection', async () => {
    const { stream } = streamWith();
    stream.start();
    FakeEventSource.instances[0]!.fail(true);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(FakeEventSource.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeEventSource.instances).toHaveLength(2);
    FakeEventSource.instances[1]!.fail(true);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(FakeEventSource.instances).toHaveLength(3);
  });

  it('reports a failure once when no connection opens within the timeout', async () => {
    const { stream, failures } = streamWith({ failureTimeoutMs: 30_000 });
    stream.start();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(failures).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(failures).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(failures).toHaveBeenCalledTimes(1);
  });

  it('stops listening and closes the source on stop', async () => {
    const { stream, refresh } = streamWith();
    stream.start();
    stream.stop();
    expect(FakeEventSource.instances[0]!.closed).toBe(true);
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).not.toHaveBeenCalled();
    expect(stream.connected).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run --project miniapp`
Expected: FAIL — cannot resolve `../src/api/client`, `../src/api/launch`, `../src/api/stream`, `../src/state/session`.

- [ ] **Step 3: Write the client, the launch flow, the session and the stream**

`apps/miniapp/src/api/client.ts`:

```ts
import { ApiErrorBodySchema, type ErrorCode } from '@group-chess/shared';
import type { ZodType } from 'zod';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | 'network',
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get isNetwork(): boolean {
    return this.code === 'network';
  }
}

export type ApiClientOptions = {
  /** Origin prefix; empty means same origin. */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Runs once per request on a 401; resolves a fresh token (a relaunch) or null to give up. */
  onUnauthorized?: () => Promise<string | null>;
};

export type RequestOptions<T> = { body?: unknown; schema?: ZodType<T>; auth?: boolean };

export interface ApiClient {
  readonly token: string | null;
  setToken(token: string | null): void;
  request<T = unknown>(method: string, path: string, options?: RequestOptions<T>): Promise<T>;
  get<T>(path: string, schema: ZodType<T>): Promise<T>;
  post<T = unknown>(path: string, body: unknown, schema?: ZodType<T>): Promise<T>;
  put<T = unknown>(path: string, body: unknown, schema?: ZodType<T>): Promise<T>;
  del<T = unknown>(path: string, schema?: ZodType<T>): Promise<T>;
  url(path: string, query?: Record<string, string>): string;
}

/** Spec §6.1 step 6 and §9: bearer token in memory, spec error bodies, one relaunch on 401. */
export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const baseUrl = (options.baseUrl ?? '').replace(/\/$/, '');
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  let token: string | null = null;

  const url = (path: string, query?: Record<string, string>): string => {
    const params = query ? new URLSearchParams(query).toString() : '';
    return `${baseUrl}${path}${params ? `?${params}` : ''}`;
  };

  async function once(
    method: string,
    path: string,
    body: unknown,
    auth: boolean,
  ): Promise<{ response: Response; json: unknown }> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (auth && token) headers.authorization = `Bearer ${token}`;
    let response: Response;
    try {
      response = await fetchImpl(url(path), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new ApiError(0, 'network', error instanceof Error ? error.message : 'network error');
    }
    const text = await response.text();
    let json: unknown = undefined;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    return { response, json };
  }

  const client: ApiClient = {
    get token() {
      return token;
    },
    setToken(next) {
      token = next;
    },
    async request<T>(method: string, path: string, requestOptions: RequestOptions<T> = {}) {
      const auth = requestOptions.auth ?? true;
      let { response, json } = await once(method, path, requestOptions.body, auth);
      if (response.status === 401 && auth && options.onUnauthorized) {
        const fresh = await options.onUnauthorized();
        if (fresh) {
          token = fresh;
          ({ response, json } = await once(method, path, requestOptions.body, auth));
        }
      }
      if (!response.ok) {
        const parsed = ApiErrorBodySchema.safeParse(json);
        if (parsed.success) {
          throw new ApiError(response.status, parsed.data.error.code, parsed.data.error.message);
        }
        throw new ApiError(response.status, 'internal', `HTTP ${response.status}`);
      }
      return (requestOptions.schema ? requestOptions.schema.parse(json) : json) as T;
    },
    get: (path, schema) => client.request('GET', path, { schema }),
    post: (path, body, schema) => client.request('POST', path, { body, schema }),
    put: (path, body, schema) => client.request('PUT', path, { body, schema }),
    del: (path, schema) => client.request('DELETE', path, { schema }),
    url,
  };
  return client;
}
```

`apps/miniapp/src/api/launch.ts`:

```ts
import { LaunchResponseSchema, type LaunchResponse } from '@group-chess/shared';
import { ApiError, type ApiClient } from './client';

export type LaunchOutcome =
  | { kind: 'ok'; response: LaunchResponse }
  | { kind: 'expired' }
  | { kind: 'failed'; error: ApiError };

/** Spec §6.1 step 3: one request from launch to a painted screen; a 401 here means "reopen". */
export async function launch(client: ApiClient, initData: string): Promise<LaunchOutcome> {
  try {
    const response = await client.request('POST', '/api/launch', {
      body: { initData },
      schema: LaunchResponseSchema,
      auth: false,
    });
    client.setToken(response.token);
    return { kind: 'ok', response };
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return { kind: 'expired' };
    if (error instanceof ApiError) return { kind: 'failed', error };
    return { kind: 'failed', error: new ApiError(0, 'network', String(error)) };
  }
}
```

`apps/miniapp/src/state/session.ts`:

```ts
import {
  decodeStartParam,
  PREFS_DEFAULTS,
  type LaunchResponse,
  type Prefs,
  type StartParam,
} from '@group-chess/shared';
import { signal } from '@preact/signals';

export type Session = {
  user: LaunchResponse['user'];
  bot: LaunchResponse['bot'];
  /** What the direct link opened; null for a profile launch. */
  launchedFrom: StartParam | null;
};

export const session = signal<Session | null>(null);
export const prefs = signal<Prefs>(PREFS_DEFAULTS);
/** `serverTime − Date.now()` at the last response; clocks tick from the server's view of time. */
export const serverOffsetMs = signal(0);

export function noteServerTime(iso: string): void {
  const parsed = Date.parse(iso);
  if (Number.isFinite(parsed)) serverOffsetMs.value = parsed - Date.now();
}

export function serverNow(): Date {
  return new Date(Date.now() + serverOffsetMs.value);
}

export function applyLaunch(response: LaunchResponse, startParam: string | null): void {
  session.value = {
    user: response.user,
    bot: response.bot,
    launchedFrom: decodeStartParam(startParam),
  };
  prefs.value = response.prefs;
  noteServerTime(response.serverTime);
}
```

`apps/miniapp/src/api/stream.ts`:

```ts
import { GameDtoSchema, type GameDto } from '@group-chess/shared';

export type EventSourceLike = {
  readonly readyState: number;
  close(): void;
  addEventListener(type: string, listener: (event: MessageEvent | Event) => void): void;
};

type DocumentLike = Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;
type WindowLike = Pick<Window, 'addEventListener' | 'removeEventListener'>;

export type StreamOptions = {
  url: string;
  /** `GET /api/games/:id`; runs on every resume so a missed event cannot leave stale state. */
  refresh: () => Promise<GameDto>;
  onState: (dto: GameDto) => void;
  /** Called once when no connection opened within `failureTimeoutMs` (telemetry `sse_failed`). */
  onFailure?: () => void;
  createEventSource?: (url: string) => EventSourceLike;
  failureTimeoutMs?: number;
  doc?: DocumentLike;
  win?: WindowLike;
};

const CLOSED = 2;
const BACKOFF_START_MS = 2_000;
const BACKOFF_MAX_MS = 30_000;

/** Spec §6.4: state snapshots over SSE, reconnect on visibility and network changes, refresh each time. */
export class GameStream {
  private source: EventSourceLike | null = null;
  private opened = false;
  private failed = false;
  private stopped = true;
  private backoffMs = BACKOFF_START_MS;
  private reopenTimer: ReturnType<typeof setTimeout> | null = null;
  private failureTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly doc: DocumentLike;
  private readonly win: WindowLike;

  constructor(private readonly options: StreamOptions) {
    this.doc = options.doc ?? document;
    this.win = options.win ?? window;
  }

  get connected(): boolean {
    return this.opened && this.source !== null && this.source.readyState !== CLOSED;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.doc.addEventListener('visibilitychange', this.onVisibility);
    this.win.addEventListener('online', this.onOnline);
    this.failureTimer = setTimeout(() => {
      if (!this.opened && !this.failed) {
        this.failed = true;
        this.options.onFailure?.();
      }
    }, this.options.failureTimeoutMs ?? 30_000);
    this.open();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.doc.removeEventListener('visibilitychange', this.onVisibility);
    this.win.removeEventListener('online', this.onOnline);
    if (this.reopenTimer) clearTimeout(this.reopenTimer);
    if (this.failureTimer) clearTimeout(this.failureTimer);
    this.reopenTimer = null;
    this.failureTimer = null;
    this.source?.close();
    this.source = null;
    this.opened = false;
  }

  private open(): void {
    this.source?.close();
    this.opened = false;
    const create = this.options.createEventSource ?? ((url: string) => new EventSource(url));
    const source = create(this.options.url);
    this.source = source;
    source.addEventListener('open', () => {
      this.opened = true;
      this.backoffMs = BACKOFF_START_MS;
    });
    source.addEventListener('state', (event) => {
      if (!('data' in event) || typeof event.data !== 'string') return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      const dto = GameDtoSchema.safeParse(parsed);
      if (dto.success) this.options.onState(dto.data);
    });
    source.addEventListener('error', () => {
      // The browser retries on its own unless it gave up (readyState CLOSED); then we do.
      if (source.readyState === CLOSED && !this.stopped && this.source === source) {
        this.scheduleReopen();
      }
    });
  }

  private scheduleReopen(): void {
    if (this.reopenTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
    this.reopenTimer = setTimeout(() => {
      this.reopenTimer = null;
      if (!this.stopped) this.open();
    }, delay);
  }

  private readonly onVisibility = (): void => {
    if (this.doc.visibilityState === 'visible') void this.resume();
  };

  private readonly onOnline = (): void => {
    void this.resume();
  };

  /** One GET so a missed event during background cannot leave stale state, then a live stream again. */
  private async resume(): Promise<void> {
    if (this.stopped) return;
    try {
      this.options.onState(await this.options.refresh());
    } catch {
      // The stream, once it reopens, sends the state anyway.
    }
    if (this.stopped) return;
    if (!this.source || this.source.readyState === CLOSED) {
      if (this.reopenTimer) clearTimeout(this.reopenTimer);
      this.reopenTimer = null;
      this.open();
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run --project miniapp`
Expected: PASS — 27 tests (12 from Task 1, client 7, launch 2, stream 6).

- [ ] **Step 5: Run the whole suite and the static checks**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm format:check`
Expected: all exit 0.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(miniapp): add the API client, launch flow, session state and the live game stream"
```

---

### Task 3: The move state machine, the game store, clocks and notices

**Files:**
- Create: `apps/miniapp/src/state/moveMachine.ts`, `apps/miniapp/src/state/clock.ts`, `apps/miniapp/src/state/game.ts`, `apps/miniapp/test/support/gameFixtures.ts`
- Test: `apps/miniapp/test/moveMachine.test.ts`, `apps/miniapp/test/clock.test.ts`, `apps/miniapp/test/gameStore.test.ts`

**Interfaces:**
- Consumes: shared `GameDto`, `Colour`, `ViewerRole`, `INITIAL_FEN`, `sideToMove`, `legalDests`, `formatClock`, `t`; chess.js `Chess` (for the check flag).
- Produces: `type PendingMove = { uci; expectedPly; clientMoveId }`, `type MoveState = idle | pendingConfirm | sending | retry`, `type MoveEvent`, `type MoveEffect = send | restore | reload | closingConfirmation | telemetryRetry`, `reduceMove(state, event, { confirmMoves }): { state; effects }`, `retryDelayMs(attempt)`, `newClientMoveId(random?)`; `remainingMs(deadlineAt, now)`, `clockLabel(remaining, timePerMove, ticking)`, `isUrgent(remaining, timePerMove)`; `type Position = { ply; fen; lastMove: [string, string] | null; check: boolean }`, `type Notice = 'draw_offered' | 'draw_declined' | 'opponent_moved' | 'finished'`, `diffNotices(prev, next)`, `positionAt(dto, ply)`, `class GameStore { dto; viewingPly; flipped; position; isLatest; orientation; sideToMove; canMove; dests; apply(next): boolean; viewPly(ply); flip() }`; test fixture `gameDto(overrides)`.

- [ ] **Step 1: Write the failing tests**

`apps/miniapp/test/support/gameFixtures.ts`:

```ts
import { INITIAL_FEN, type GameDto, type MoveDto } from '@group-chess/shared';

export const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
export const AFTER_E4_E5 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2';
/** 1. f3 e5 2. g4 Qh4#: the fool's mate, four plies. */
export const FOOLS_MATE: MoveDto[] = [
  { ply: 1, uci: 'f2f3', san: 'f3', fenAfter: 'rnbqkbnr/pppppppp/8/8/8/5P2/PPPPP1PP/RNBQKBNR b KQkq - 0 1', playedAt: '2026-09-20T10:00:00.000Z' },
  { ply: 2, uci: 'e7e5', san: 'e5', fenAfter: 'rnbqkbnr/pppp1ppp/8/4p3/8/5P2/PPPPP1PP/RNBQKBNR w KQkq e6 0 2', playedAt: '2026-09-20T10:01:00.000Z' },
  { ply: 3, uci: 'g2g4', san: 'g4', fenAfter: 'rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq g3 0 2', playedAt: '2026-09-20T10:02:00.000Z' },
  { ply: 4, uci: 'd8h4', san: 'Qh4#', fenAfter: 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3', playedAt: '2026-09-20T10:03:00.000Z' },
];

const player = (id: string, name: string) => ({
  id,
  name,
  username: null,
  rating: 1500,
  provisional: true,
  ratingAfter: null,
  provisionalAfter: null,
});

export function gameDto(overrides: Partial<GameDto> = {}): GameDto {
  return {
    id: 'AbCdEfGhIj',
    group: { id: 'GrOuPiDxYz', title: 'Chess Club' },
    status: 'active',
    white: player('1', 'Alice'),
    black: player('2', 'Bob'),
    timePerMove: 86400,
    rated: true,
    fen: INITIAL_FEN,
    plyCount: 0,
    version: 0,
    moves: [],
    deadlineAt: '2026-09-21T10:00:00.000Z',
    serverTime: '2026-09-20T10:00:00.000Z',
    drawOffer: null,
    claims: { threefold: false, fiftyMove: false },
    viewerRole: 'white',
    result: null,
    endReason: null,
    voided: false,
    startedAt: '2026-09-20T10:00:00.000Z',
    finishedAt: null,
    ...overrides,
  };
}

/** A game after the given number of fool's-mate plies, consistent fen, plyCount and version. */
export function afterPlies(plies: number, overrides: Partial<GameDto> = {}): GameDto {
  const moves = FOOLS_MATE.slice(0, plies);
  const last = moves.at(-1);
  return gameDto({
    moves,
    plyCount: plies,
    version: plies,
    fen: last ? last.fenAfter : INITIAL_FEN,
    ...overrides,
  });
}
```

`apps/miniapp/test/moveMachine.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  newClientMoveId,
  reduceMove,
  retryDelayMs,
  type MoveEvent,
  type MoveState,
} from '../src/state/moveMachine';

const drop: MoveEvent = { type: 'drop', uci: 'e2e4', expectedPly: 0, clientMoveId: 'm-0000000001' };
const run = (events: MoveEvent[], confirmMoves: boolean, from: MoveState = { kind: 'idle' }) => {
  let state = from;
  const effects: string[] = [];
  for (const event of events) {
    const out = reduceMove(state, event, { confirmMoves });
    state = out.state;
    effects.push(...out.effects.map((effect) => effect.type + ('on' in effect ? `:${effect.on}` : '')));
  }
  return { state, effects };
};

describe('reduceMove', () => {
  it('sends immediately when confirm moves is off', () => {
    const { state, effects } = run([drop], false);
    expect(state).toEqual({ kind: 'sending', move: { uci: 'e2e4', expectedPly: 0, clientMoveId: 'm-0000000001' }, attempt: 1 });
    expect(effects).toEqual(['send']);
  });

  it('waits for confirmation when confirm moves is on, then sends exactly once', () => {
    const pending = run([drop], true);
    expect(pending.state.kind).toBe('pendingConfirm');
    expect(pending.effects).toEqual(['closingConfirmation:true']);
    const confirmed = run([{ type: 'confirm' }], true, pending.state);
    expect(confirmed.state).toMatchObject({ kind: 'sending', attempt: 1 });
    expect(confirmed.effects).toEqual(['closingConfirmation:false', 'send']);
    expect(run([{ type: 'confirm' }], true, confirmed.state).effects).toEqual([]);
  });

  it('cancel restores the position and turns closing confirmation off', () => {
    const pending = run([drop], true).state;
    const { state, effects } = run([{ type: 'cancel' }], true, pending);
    expect(state).toEqual({ kind: 'idle' });
    expect(effects).toEqual(['restore', 'closingConfirmation:false']);
  });

  it('returns to idle and restores the position on a stale rejection', () => {
    const sending = run([drop], false).state;
    const { state, effects } = run([{ type: 'rejected' }], false, sending);
    expect(state).toEqual({ kind: 'idle' });
    expect(effects).toEqual(['restore', 'reload']);
  });

  it('keeps the client move id and backs off across network retries', () => {
    const sending = run([drop], false).state;
    const first = run([{ type: 'networkError', now: 1_000 }], false, sending);
    expect(first.state).toEqual({ kind: 'retry', move: { uci: 'e2e4', expectedPly: 0, clientMoveId: 'm-0000000001' }, attempt: 1, nextAt: 2_000 });
    expect(first.effects).toEqual(['telemetryRetry']);
    const early = run([{ type: 'tick', now: 1_999 }], false, first.state);
    expect(early.state.kind).toBe('retry');
    expect(early.effects).toEqual([]);
    const second = run([{ type: 'tick', now: 2_000 }], false, first.state);
    expect(second.state).toMatchObject({ kind: 'sending', attempt: 2, move: { clientMoveId: 'm-0000000001' } });
    expect(second.effects).toEqual(['send']);
    const third = run([{ type: 'networkError', now: 5_000 }], false, second.state);
    expect(third.state).toMatchObject({ kind: 'retry', attempt: 2, nextAt: 7_000 });
    expect(third.effects).toEqual([]);
    const manual = run([{ type: 'retryNow' }], false, third.state);
    expect(manual.state).toMatchObject({ kind: 'sending', attempt: 3 });
    expect(manual.effects).toEqual(['send']);
  });

  it('caps the retry delay at thirty seconds', () => {
    expect(retryDelayMs(1)).toBe(1_000);
    expect(retryDelayMs(2)).toBe(2_000);
    expect(retryDelayMs(5)).toBe(16_000);
    expect(retryDelayMs(6)).toBe(30_000);
    expect(retryDelayMs(20)).toBe(30_000);
  });

  it('ignores a drop while a move is in flight and a stray answer while idle', () => {
    const sending = run([drop], false).state;
    const ignored = run([{ ...drop, uci: 'd2d4' }], false, sending);
    expect(ignored.state).toBe(sending);
    expect(ignored.effects).toEqual([]);
    expect(run([{ type: 'sent' }], false).state).toEqual({ kind: 'idle' });
  });

  it('makes client move ids that satisfy the API pattern', () => {
    const id = newClientMoveId();
    expect(id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(newClientMoveId()).not.toBe(id);
    expect(newClientMoveId(() => 0)).toMatch(/^[A-Za-z0-9_-]{16}$/);
  });
});
```

`apps/miniapp/test/clock.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { clockLabel, isUrgent, remainingMs } from '../src/state/clock';

const now = new Date('2026-09-20T10:00:00.000Z');

describe('clock', () => {
  it('measures the remaining time against the server clock and never goes negative', () => {
    expect(remainingMs('2026-09-20T11:30:00.000Z', now)).toBe(90 * 60_000);
    expect(remainingMs('2026-09-20T09:00:00.000Z', now)).toBe(0);
    expect(remainingMs(null, now)).toBeNull();
  });

  it('labels the ticking side, the waiting side and games without a clock', () => {
    expect(clockLabel(90 * 60_000, 86400, true)).toBe('1:30:00');
    expect(clockLabel(0, 86400, true)).toBe('0:00');
    expect(clockLabel(null, 86400, false)).toBe('1d 0:00');
    expect(clockLabel(null, 3600, false)).toBe('1:00:00');
    expect(clockLabel(null, null, true)).toBe('No clock');
  });

  it('flags the last tenth of the budget or the last hour as urgent', () => {
    expect(isUrgent(2 * 3_600_000, 86400)).toBe(true);
    expect(isUrgent(10 * 3_600_000, 86400)).toBe(false);
    expect(isUrgent(30 * 60_000, 3600)).toBe(true);
    expect(isUrgent(null, 86400)).toBe(false);
  });
});
```

`apps/miniapp/test/gameStore.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { diffNotices, GameStore, positionAt } from '../src/state/game';
import { afterPlies, gameDto } from './support/gameFixtures';

describe('positionAt', () => {
  it('walks the move list with last move and check', () => {
    const game = afterPlies(4, { status: 'finished', result: '0-1', endReason: 'checkmate' });
    expect(positionAt(game, 0)).toMatchObject({ ply: 0, lastMove: null, check: false });
    expect(positionAt(game, 1)).toMatchObject({ ply: 1, lastMove: ['f2', 'f3'], check: false });
    expect(positionAt(game, 4)).toMatchObject({ ply: 4, lastMove: ['d8', 'h4'], check: true });
    expect(positionAt(game, 4).fen).toBe(game.fen);
  });
});

describe('GameStore', () => {
  it('lets only the player to move move, and only at the latest position', () => {
    const white = new GameStore(afterPlies(2, { viewerRole: 'white' }));
    expect(white.canMove.value).toBe(true);
    expect(white.dests.value.get('g1')).toEqual(['h3']); // f3 holds White's own pawn
    white.viewPly(1);
    expect(white.isLatest.value).toBe(false);
    expect(white.canMove.value).toBe(false);
    expect(white.dests.value.size).toBe(0);
    white.viewPly(null);
    expect(white.canMove.value).toBe(true);

    expect(new GameStore(afterPlies(2, { viewerRole: 'black' })).canMove.value).toBe(false);
    expect(new GameStore(afterPlies(2, { viewerRole: 'spectator' })).canMove.value).toBe(false);
    expect(
      new GameStore(afterPlies(4, { viewerRole: 'white', status: 'finished', result: '0-1', endReason: 'checkmate' })).canMove.value,
    ).toBe(false);
  });

  it('orients the board to the viewer and lets spectators flip', () => {
    expect(new GameStore(gameDto({ viewerRole: 'black' })).orientation.value).toBe('black');
    const spectator = new GameStore(gameDto({ viewerRole: 'spectator' }));
    expect(spectator.orientation.value).toBe('white');
    spectator.flip();
    expect(spectator.orientation.value).toBe('black');
  });

  it('applies newer states only and jumps to the latest position when the game moves on', () => {
    const store = new GameStore(afterPlies(1));
    store.viewPly(0);
    expect(store.apply(afterPlies(0))).toBe(false);
    expect(store.dto.value.plyCount).toBe(1);
    expect(store.apply(afterPlies(2))).toBe(true);
    expect(store.viewingPly.value).toBeNull();
    expect(store.position.value.ply).toBe(2);
  });

  it('keeps an earlier position on screen while the viewer is reading the game', () => {
    const store = new GameStore(afterPlies(3, { viewerRole: 'spectator' }));
    store.viewPly(1);
    store.apply(afterPlies(3, { version: 7, drawOffer: { by: 'white', atPly: 3 } }));
    expect(store.viewingPly.value).toBe(1);
  });
});

describe('diffNotices', () => {
  it('derives offers, declines, opponent moves and the end from consecutive states', () => {
    const base = afterPlies(2, { viewerRole: 'white' });
    expect(diffNotices(base, afterPlies(2, { viewerRole: 'white', version: 3, drawOffer: { by: 'black', atPly: 2 } }))).toEqual(['draw_offered']);
    expect(diffNotices(afterPlies(2, { viewerRole: 'white', drawOffer: { by: 'white', atPly: 2 } }), afterPlies(2, { viewerRole: 'white', version: 3 }))).toEqual(['draw_declined']);
    expect(diffNotices(afterPlies(1, { viewerRole: 'white' }), afterPlies(2, { viewerRole: 'white' }))).toEqual(['opponent_moved']);
    expect(diffNotices(afterPlies(2, { viewerRole: 'white' }), afterPlies(3, { viewerRole: 'white' }))).toEqual([]);
    expect(diffNotices(afterPlies(3, { viewerRole: 'black' }), afterPlies(4, { viewerRole: 'black', status: 'finished', result: '0-1', endReason: 'checkmate' }))).toEqual(['finished']);
    expect(diffNotices(base, base)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run --project miniapp`
Expected: FAIL — cannot resolve `../src/state/moveMachine`, `../src/state/clock`, `../src/state/game`.

- [ ] **Step 3: Write the machine, the clock helpers and the store**

`apps/miniapp/src/state/moveMachine.ts`:

```ts
export type PendingMove = { uci: string; expectedPly: number; clientMoveId: string };

export type MoveState =
  | { kind: 'idle' }
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

export type MoveEffect =
  | { type: 'send'; move: PendingMove }
  | { type: 'restore' }
  | { type: 'reload' }
  | { type: 'closingConfirmation'; on: boolean }
  | { type: 'telemetryRetry' };

const RETRY_MAX_MS = 30_000;

/** 1 s, 2 s, 4 s … capped at 30 s (spec §6.3). */
export function retryDelayMs(attempt: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, attempt - 1), RETRY_MAX_MS);
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Sixteen characters from `[a-z0-9]`, well inside the API's `^[A-Za-z0-9_-]{8,64}$`. */
export function newClientMoveId(random: () => number = Math.random): string {
  let id = '';
  for (let i = 0; i < 16; i += 1) id += ALPHABET[Math.floor(random() * ALPHABET.length) % ALPHABET.length];
  return id;
}

/** The move state machine of spec §6.3 as a pure reducer; the screen runs the effects. */
export function reduceMove(
  state: MoveState,
  event: MoveEvent,
  options: { confirmMoves: boolean },
): { state: MoveState; effects: MoveEffect[] } {
  const same = { state, effects: [] as MoveEffect[] };
  switch (state.kind) {
    case 'idle': {
      if (event.type !== 'drop') return same;
      const move: PendingMove = {
        uci: event.uci,
        expectedPly: event.expectedPly,
        clientMoveId: event.clientMoveId ?? newClientMoveId(),
      };
      if (options.confirmMoves) {
        return {
          state: { kind: 'pendingConfirm', move },
          effects: [{ type: 'closingConfirmation', on: true }],
        };
      }
      return { state: { kind: 'sending', move, attempt: 1 }, effects: [{ type: 'send', move }] };
    }
    case 'pendingConfirm': {
      if (event.type === 'confirm') {
        return {
          state: { kind: 'sending', move: state.move, attempt: 1 },
          effects: [{ type: 'closingConfirmation', on: false }, { type: 'send', move: state.move }],
        };
      }
      if (event.type === 'cancel') {
        return {
          state: { kind: 'idle' },
          effects: [{ type: 'restore' }, { type: 'closingConfirmation', on: false }],
        };
      }
      return same;
    }
    case 'sending': {
      if (event.type === 'sent') return { state: { kind: 'idle' }, effects: [] };
      if (event.type === 'rejected') {
        return { state: { kind: 'idle' }, effects: [{ type: 'restore' }, { type: 'reload' }] };
      }
      if (event.type === 'networkError') {
        return {
          state: {
            kind: 'retry',
            move: state.move,
            attempt: state.attempt,
            nextAt: event.now + retryDelayMs(state.attempt),
          },
          effects: state.attempt === 1 ? [{ type: 'telemetryRetry' }] : [],
        };
      }
      return same;
    }
    case 'retry': {
      const due = event.type === 'retryNow' || (event.type === 'tick' && event.now >= state.nextAt);
      if (!due) return same;
      return {
        state: { kind: 'sending', move: state.move, attempt: state.attempt + 1 },
        effects: [{ type: 'send', move: state.move }],
      };
    }
  }
}
```

`apps/miniapp/src/state/clock.ts`:

```ts
import { formatClock, t, type TimePerMove } from '@group-chess/shared';

/** Milliseconds until the deadline as seen from the server's clock; never negative. */
export function remainingMs(deadlineAt: string | null, now: Date): number | null {
  if (!deadlineAt) return null;
  return Math.max(0, Date.parse(deadlineAt) - now.getTime());
}

/** The side to move counts down; the waiting side shows the full budget it will get (PRD §7.4). */
export function clockLabel(
  remaining: number | null,
  timePerMove: TimePerMove,
  ticking: boolean,
): string {
  if (timePerMove === null) return t('app.game.no_clock');
  if (ticking && remaining !== null) return formatClock(remaining);
  return formatClock(timePerMove * 1000);
}

export function isUrgent(remaining: number | null, timePerMove: TimePerMove): boolean {
  if (remaining === null || timePerMove === null) return false;
  return remaining <= Math.max(timePerMove * 100, 3_600_000);
}
```

`apps/miniapp/src/state/game.ts`:

```ts
import { INITIAL_FEN, legalDests, sideToMove, type Colour, type GameDto } from '@group-chess/shared';
import { computed, signal, type ReadonlySignal, type Signal } from '@preact/signals';
import { Chess } from 'chess.js';

export type Position = {
  ply: number;
  fen: string;
  lastMove: [string, string] | null;
  check: boolean;
};

export type Notice = 'draw_offered' | 'draw_declined' | 'opponent_moved' | 'finished';

function inCheck(fen: string): boolean {
  try {
    return new Chess(fen).inCheck();
  } catch {
    return false;
  }
}

/** The position after `ply` plies; ply 0 is the initial position. */
export function positionAt(dto: GameDto, ply: number): Position {
  if (ply <= 0) return { ply: 0, fen: INITIAL_FEN, lastMove: null, check: false };
  const move = dto.moves[ply - 1];
  const fen = move ? move.fenAfter : dto.fen;
  return {
    ply: move ? move.ply : dto.plyCount,
    fen,
    lastMove: move ? [move.uci.slice(0, 2), move.uci.slice(2, 4)] : null,
    check: inCheck(fen),
  };
}

/** Spec §6.4: banners come from the diff between consecutive states, never from separate events. */
export function diffNotices(prev: GameDto, next: GameDto): Notice[] {
  const notices: Notice[] = [];
  const viewer = next.viewerRole;
  if (prev.status === 'active' && next.status === 'finished') {
    notices.push('finished');
    return notices;
  }
  if (next.drawOffer && !prev.drawOffer && next.drawOffer.by !== viewer) notices.push('draw_offered');
  if (
    prev.drawOffer &&
    prev.drawOffer.by === viewer &&
    !next.drawOffer &&
    next.plyCount === prev.plyCount &&
    next.status === 'active'
  ) {
    notices.push('draw_declined');
  }
  if (
    next.plyCount > prev.plyCount &&
    next.status === 'active' &&
    (viewer === 'white' || viewer === 'black') &&
    sideToMove(next.fen) === viewer
  ) {
    notices.push('opponent_moved');
  }
  return notices;
}

export class GameStore {
  readonly dto: Signal<GameDto>;
  /** null shows the latest position; a number shows an earlier one view-only (spec §6.3). */
  readonly viewingPly: Signal<number | null> = signal(null);
  readonly flipped: Signal<boolean> = signal(false);
  readonly position: ReadonlySignal<Position>;
  readonly isLatest: ReadonlySignal<boolean>;
  readonly orientation: ReadonlySignal<Colour>;
  readonly sideToMove: ReadonlySignal<Colour>;
  readonly canMove: ReadonlySignal<boolean>;
  readonly dests: ReadonlySignal<Map<string, string[]>>;

  constructor(initial: GameDto) {
    this.dto = signal(initial);
    this.isLatest = computed(() => this.viewingPly.value === null);
    this.position = computed(() =>
      positionAt(this.dto.value, this.viewingPly.value ?? this.dto.value.plyCount),
    );
    this.orientation = computed(() => {
      const own: Colour = this.dto.value.viewerRole === 'black' ? 'black' : 'white';
      return this.flipped.value ? (own === 'white' ? 'black' : 'white') : own;
    });
    this.sideToMove = computed(() => sideToMove(this.position.value.fen));
    this.canMove = computed(() => {
      const dto = this.dto.value;
      return (
        dto.status === 'active' &&
        this.isLatest.value &&
        (dto.viewerRole === 'white' || dto.viewerRole === 'black') &&
        sideToMove(dto.fen) === dto.viewerRole
      );
    });
    this.dests = computed(() =>
      this.canMove.value ? legalDests(this.dto.value.fen) : new Map<string, string[]>(),
    );
  }

  /** Applies a newer snapshot; an older or equal version is ignored. Returns whether it applied. */
  apply(next: GameDto): boolean {
    const current = this.dto.value;
    if (next.version < current.version) return false;
    if (next.version === current.version && next.plyCount === current.plyCount && next.status === current.status) {
      this.dto.value = next;
      return false;
    }
    const viewing = this.viewingPly.value;
    this.dto.value = next;
    // A player reading an old position is brought back when the game moves on; spectators stay.
    if (viewing !== null && next.plyCount > current.plyCount && next.viewerRole !== 'spectator') {
      this.viewingPly.value = null;
    }
    return true;
  }

  viewPly(ply: number | null): void {
    const max = this.dto.value.plyCount;
    this.viewingPly.value = ply === null || ply >= max ? null : Math.max(0, ply);
  }

  flip(): void {
    this.flipped.value = !this.flipped.value;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run --project miniapp`
Expected: PASS — 43 tests (27 before, move machine 8, clock 3, store 5).

- [ ] **Step 5: Run the whole suite and the static checks**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm format:check`
Expected: all exit 0.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(miniapp): add the move state machine, the game store, clocks and notices"
```

---

### Task 4: Router, app shell, boot sequence and the non-board screens

**Files:**
- Create: `apps/miniapp/src/router.ts`, `apps/miniapp/src/boot.ts`, `apps/miniapp/src/ui/context.ts`, `apps/miniapp/src/ui/hooks.ts`, `apps/miniapp/src/ui/toast.tsx`, `apps/miniapp/src/ui/dialog.tsx`, `apps/miniapp/src/ui/controls.tsx`, `apps/miniapp/src/ui/format.ts`, `apps/miniapp/src/ui/rows.tsx`, `apps/miniapp/src/ui/App.tsx`, `apps/miniapp/src/ui/screens/Status.tsx`, `apps/miniapp/src/ui/screens/Groups.tsx`, `apps/miniapp/src/ui/screens/Lobby.tsx`, `apps/miniapp/src/ui/screens/NewGame.tsx`, `apps/miniapp/src/ui/screens/Player.tsx`, `apps/miniapp/src/ui/screens/Settings.tsx`, `apps/miniapp/src/ui/screens/GroupSettings.tsx`, `apps/miniapp/src/ui/screens/Game.tsx` (placeholder, replaced in Task 5), `apps/miniapp/test/support/render.tsx`
- Modify: `apps/miniapp/src/main.tsx` (the real boot)
- Test: `apps/miniapp/test/router.test.ts`, `apps/miniapp/test/boot.test.ts`, `apps/miniapp/test/lobby.test.tsx`, `apps/miniapp/test/newGame.test.tsx`, `apps/miniapp/test/settings.test.tsx`, `apps/miniapp/test/groupSettings.test.tsx`

**Interfaces:**
- Consumes: Tasks 1–3; shared DTO schemas, `t`, label helpers, `TIME_PER_MOVE_OPTIONS`, `GROUP_SETTINGS_DEFAULTS`.
- Produces: `type Route`, `class Router { stack; current; reset(route); push(route); replace(route); back(): boolean }`; `type Prefetched`, `routeFor(launchRoute, prefetched)`, `boot({ tg, client, router, prefetched })`, `relaunch(...)`; `AppContext`/`useApp()`, `AppProvider`; `useResource(key, load, initial?)`; `toast(message)`, `<Toasts/>`; `confirmDialog(message, options?)`, `<Dialogs/>`; controls `Switch`, `Select`, `Segmented`; `playerLabel`, `summaryTitle`, `summaryStatus`; rows `GameRow`, `ChallengeRow`, `PlayerRow`; screens; test support `renderApp(ui, overrides?)` returning `{ root, app, fake: window.__tg, calls }`.

- [ ] **Step 1: Write the failing tests**

`apps/miniapp/test/support/render.tsx`:

```tsx
import { render, type ComponentChildren } from 'preact';
import { createApiClient, type ApiClient } from '../../src/api/client';
import { Router } from '../../src/router';
import { prefs, session } from '../../src/state/session';
import { createTg, type Tg } from '../../src/tg/webapp';
import { AppProvider, type AppContextValue } from '../../src/ui/context';
import { Dialogs } from '../../src/ui/dialog';
import { Toasts } from '../../src/ui/toast';
import { fakeFetch, type FakeRoute } from './fakeFetch';
import { installFakeWebApp } from './fakeWebApp';

export type Rendered = {
  root: HTMLElement;
  app: AppContextValue;
  calls: ReturnType<typeof fakeFetch>['calls'];
  tg: Tg;
  flush(): Promise<void>;
  click(selector: string): Promise<void>;
  text(): string;
};

let lastRoot: HTMLElement | null = null;

/** Mounts `ui` with a fake Telegram (8.0), a fake fetch and a fresh router; the session is preset. */
export function renderApp(
  ui: (app: AppContextValue) => ComponentChildren,
  route: FakeRoute,
  options: { version?: string; closeWhenEmpty?: boolean; client?: ApiClient } = {},
): Rendered {
  installFakeWebApp({ version: options.version ?? '8.0', initData: 'user=x&hash=y' });
  const tg = createTg(window.Telegram!.WebApp);
  const { fetch, calls } = fakeFetch(route);
  const client = options.client ?? createApiClient({ fetch });
  client.setToken('jwt');
  session.value = {
    user: { id: '1', name: 'Alice', username: 'alice' },
    bot: { username: 'TestChessBot', miniAppShortName: 'chess' },
    launchedFrom: null,
  };
  prefs.value = {
    confirmMoves: true,
    closeAfterMove: true,
    notifications: true,
    boardTheme: null,
    pieceSet: null,
  };
  const router = new Router(tg, { closeWhenEmpty: options.closeWhenEmpty ?? false });
  const app: AppContextValue = { tg, client, router, prefetched: {} };
  if (lastRoot) render(null, lastRoot); // unmount the previous tree: its streams and timers stop
  document.body.innerHTML = '';
  const root = document.createElement('div');
  lastRoot = root;
  document.body.appendChild(root);
  render(
    <AppProvider value={app}>
      {ui(app)}
      <Toasts />
      <Dialogs />
    </AppProvider>,
    root,
  );
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return {
    root,
    app,
    calls,
    tg,
    flush,
    click: async (selector) => {
      const element = root.querySelector<HTMLElement>(selector) ?? document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`no element for ${selector}`);
      element.click();
      await flush();
    },
    text: () => root.textContent ?? '',
  };
}
```

`apps/miniapp/test/router.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Router } from '../src/router';
import { createTg } from '../src/tg/webapp';
import { installFakeWebApp } from './support/fakeWebApp';

const setup = (closeWhenEmpty: boolean) => {
  installFakeWebApp({ version: '8.0', initData: 'user=x&hash=y' });
  const tg = createTg(window.Telegram!.WebApp);
  return { router: new Router(tg, { closeWhenEmpty }), record: window.__tg! };
};

describe('Router', () => {
  it('pushes, replaces and pops routes and shows the back button below the root', () => {
    const { router, record } = setup(false);
    router.reset({ name: 'groups' });
    expect(router.current.value).toEqual({ name: 'groups' });
    expect(record.backButton.visible).toBe(false);
    router.push({ name: 'lobby', groupId: 'GrOuPiDxYz' });
    expect(record.backButton.visible).toBe(true);
    router.replace({ name: 'lobby', groupId: 'GrOuPiDxYz', tab: 'players' });
    expect(router.stack.value).toHaveLength(2);
    expect(router.back()).toBe(true);
    expect(router.current.value).toEqual({ name: 'groups' });
    expect(record.backButton.visible).toBe(false);
    expect(router.back()).toBe(false);
    expect(record.closed).toBe(false);
  });

  it('closes the app from the root when it was opened from a game link', () => {
    const { router, record } = setup(true);
    router.reset({ name: 'game', gameId: 'AbCdEfGhIj' });
    expect(record.backButton.visible).toBe(true);
    record.clickBack();
    expect(record.closed).toBe(true);
  });

  it('pops one level on the Telegram back button', () => {
    const { router, record } = setup(false);
    router.reset({ name: 'groups' });
    router.push({ name: 'settings' });
    record.clickBack();
    expect(router.current.value).toEqual({ name: 'groups' });
  });
});
```

`apps/miniapp/test/boot.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createApiClient } from '../src/api/client';
import { boot } from '../src/boot';
import { Router } from '../src/router';
import { prefs, session } from '../src/state/session';
import { createTg } from '../src/tg/webapp';
import type { Prefetched } from '../src/ui/context';
import { fakeFetch } from './support/fakeFetch';
import { installFakeWebApp } from './support/fakeWebApp';
import { gameDto } from './support/gameFixtures';

const launchBody = (route: unknown, askWriteAccess = false) => ({
  token: 'jwt',
  user: { id: '1', name: 'Alice', username: 'alice' },
  prefs: { confirmMoves: true, closeAfterMove: true, notifications: true, boardTheme: null, pieceSet: null },
  askWriteAccess,
  route,
  serverTime: new Date().toISOString(),
  bot: { username: 'TestChessBot', miniAppShortName: 'chess' },
});

function setup(version: string, startParam: string | undefined, handler: Parameters<typeof fakeFetch>[0]) {
  installFakeWebApp({ version, initData: 'user=x&hash=y', startParam, writeAccess: true });
  const tg = createTg(window.Telegram!.WebApp);
  const { fetch, calls } = fakeFetch(handler);
  const client = createApiClient({ fetch });
  const router = new Router(tg, { closeWhenEmpty: false });
  const prefetched: Prefetched = {};
  return { tg, client, router, prefetched, calls, record: window.__tg! };
}

describe('boot', () => {
  it('launches once, lands on the resolved route with its data and asks for write access afterwards', async () => {
    const game = gameDto();
    const { tg, client, router, prefetched, calls, record } = setup('8.0', 'g_AbCdEfGhIj', ({ path }) =>
      path === '/api/launch'
        ? { status: 200, body: launchBody({ kind: 'game', game }, true) }
        : { status: 200, body: { prefs: prefs.value, dmAllowed: true } },
    );
    await boot({ tg, client, router, prefetched });
    expect(router.current.value).toEqual({ name: 'game', gameId: 'AbCdEfGhIj' });
    expect(prefetched.game?.id).toBe('AbCdEfGhIj');
    expect(session.value?.launchedFrom).toEqual({ kind: 'game', gameId: 'AbCdEfGhIj' });
    expect(record.calls.filter((c) => c === 'ready' || c === 'expand' || c === 'disableVerticalSwipes')).toEqual([
      'ready',
      'expand',
      'disableVerticalSwipes',
    ]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(record.calls).toContain('requestWriteAccess');
    expect(calls.map((c) => [c.method, c.path])).toEqual([
      ['POST', '/api/launch'],
      ['PUT', '/api/me/prefs'],
    ]);
    expect(calls[1]?.body).toEqual({ writeAccess: { allowed: true } });
  });

  it('skips the write-access prompt on old clients and lands on the lobby or groups', async () => {
    const lobby = {
      group: { id: 'GrOuPiDxYz', title: 'Club' },
      isAdmin: false,
      settings: { defaultTimePerMove: 86400, ratedDefault: true, allowOpenChallenges: true },
      active: [],
      finished: { items: [], nextCursor: null },
      challenges: [],
      players: [],
    };
    const { tg, client, router, prefetched, calls, record } = setup('6.0', 'l_GrOuPiDxYz', () => ({
      status: 200,
      body: launchBody({ kind: 'lobby', lobby }, true),
    }));
    await boot({ tg, client, router, prefetched });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(router.current.value).toEqual({ name: 'lobby', groupId: 'GrOuPiDxYz' });
    expect(record.calls).not.toContain('requestWriteAccess');
    expect(record.calls).not.toContain('disableVerticalSwipes');
    expect(calls).toHaveLength(1);
  });

  it('shows the reopen screen when the launch is rejected and the error screen when it fails', async () => {
    const expired = setup('8.0', undefined, () => ({
      status: 401,
      body: { error: { code: 'unauthorized', message: 'stale' } },
    }));
    await boot(expired);
    expect(expired.router.current.value).toEqual({ name: 'reopen' });

    const broken = setup('8.0', undefined, ({ path }) =>
      path === '/api/launch' ? { status: 503 } : { status: 200, body: { ok: true } },
    );
    await boot(broken);
    expect(broken.router.current.value).toEqual({ name: 'error' });
  });

  it('routes a locked launch to the locked screen', async () => {
    const locked = setup('8.0', 'l_GrOuPiDxYz', () => ({
      status: 200,
      body: launchBody({ kind: 'locked', group: { id: 'GrOuPiDxYz', title: 'Club' } }),
    }));
    await boot(locked);
    expect(locked.router.current.value).toEqual({ name: 'locked', group: { id: 'GrOuPiDxYz', title: 'Club' } });
  });
});
```

`apps/miniapp/test/lobby.test.tsx`:

```tsx
import type { LobbyDto } from '@group-chess/shared';
import { describe, expect, it } from 'vitest';
import { Lobby } from '../src/ui/screens/Lobby';
import { gameDto } from './support/gameFixtures';
import { renderApp } from './support/render';

const ref = (id: string, name: string) => ({ id, name, username: null, rating: 1500, provisional: true });
const summary = (id: string, yourTurn: boolean, status: 'active' | 'finished' = 'active') => ({
  id,
  white: ref('1', 'Alice'),
  black: ref('2', 'Bob'),
  status,
  timePerMove: 86400 as const,
  rated: true,
  plyCount: 3,
  sideToMove: 'black' as const,
  yourTurn,
  deadlineAt: null,
  lastMoveAt: null,
  startedAt: '2026-09-20T10:00:00.000Z',
  finishedAt: status === 'finished' ? '2026-09-20T12:00:00.000Z' : null,
  result: status === 'finished' ? ('1-0' as const) : null,
  endReason: status === 'finished' ? ('resignation' as const) : null,
  voided: false,
});

const lobby: LobbyDto = {
  group: { id: 'GrOuPiDxYz', title: 'Chess Club' },
  isAdmin: true,
  settings: { defaultTimePerMove: 86400, ratedDefault: true, allowOpenChallenges: true },
  active: [summary('GameAaaaaa', false), summary('GameBbbbbb', true)],
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
  players: [{ ...ref('2', 'Bob'), gamesPlayed: 9, record: { wins: 5, draws: 1, losses: 3 } }],
};

describe('Lobby', () => {
  it('renders the lobby from the launch data with your-move games first and admin entry points', async () => {
    const r = renderApp(
      (app) => {
        app.prefetched.lobby = lobby;
        return <Lobby groupId="GrOuPiDxYz" />;
      },
      () => ({ status: 200, body: lobby }),
    );
    await r.flush();
    expect(r.calls).toHaveLength(0);
    const rows = [...r.root.querySelectorAll('[data-game]')].map((el) => el.getAttribute('data-game'));
    expect(rows).toEqual(['GameBbbbbb', 'GameAaaaaa']);
    expect(r.text()).toContain('Your move');
    expect(r.text()).toContain('Bob challenges Alice');
    expect(r.text()).toContain('Group settings');
    await r.click('[data-tab="finished"]');
    expect([...r.root.querySelectorAll('[data-game]')].map((el) => el.getAttribute('data-game'))).toEqual(['GameCccccc']);
    expect(r.text()).toContain('1-0');
    await r.click('[data-tab="players"]');
    expect(r.text()).toContain('5 W · 1 D · 3 L');
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
    const r = renderApp(() => <Lobby groupId="GrOuPiDxYz" />, () => ({ status: 200, body: lobby }));
    await r.flush();
    await r.click('[data-game="GameAaaaaa"]');
    expect(r.app.router.current.value).toEqual({ name: 'game', gameId: 'GameAaaaaa' });
    r.app.router.back();
    await r.click('[data-action="new-game"]');
    expect(r.app.router.current.value).toMatchObject({ name: 'newGame', groupId: 'GrOuPiDxYz' });
  });
});
```

`apps/miniapp/test/newGame.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import { NewGame } from '../src/ui/screens/NewGame';
import { renderApp } from './support/render';

const players = { players: [{ id: '2', name: 'Bob', username: 'bob', rating: 1520, provisional: false }] };
const challenge = {
  id: 'ChalAaaaaa',
  challenger: { id: '1', name: 'Alice', username: 'alice', rating: 1500, provisional: true },
  opponent: null,
  timePerMove: 28800,
  challengerColour: 'white',
  rated: false,
  status: 'pending',
  createdAt: '2026-09-20T10:00:00.000Z',
  expiresAt: '2026-09-21T10:00:00.000Z',
  viewer: { canAccept: false, canDecline: false, canCancel: true },
};

describe('NewGame', () => {
  it('posts the challenge with the chosen opponent, time, colour and rated flag', async () => {
    const r = renderApp(
      () => <NewGame groupId="GrOuPiDxYz" />,
      ({ method }) => (method === 'POST' ? { status: 200, body: challenge } : { status: 200, body: players }),
    );
    await r.flush();
    expect(r.text()).toContain('Bob');
    await r.click('[data-opponent="2"]');
    await r.click('[data-time="28800"]');
    await r.click('[data-colour="white"]');
    await r.click('[data-rated]');
    window.__tg!.clickMain();
    await r.flush();
    const post = r.calls.find((c) => c.method === 'POST');
    expect(post?.path).toBe('/api/groups/GrOuPiDxYz/challenges');
    expect(post?.body).toEqual({ opponentId: '2', timePerMove: 28800, colour: 'white', rated: false });
    expect(r.app.router.current.value).toEqual({ name: 'lobby', groupId: 'GrOuPiDxYz' });
  });

  it('sends an open challenge with a null opponent and the group defaults', async () => {
    const r = renderApp(
      () => <NewGame groupId="GrOuPiDxYz" defaults={{ defaultTimePerMove: 259200, ratedDefault: true, allowOpenChallenges: true }} />,
      ({ method }) => (method === 'POST' ? { status: 200, body: challenge } : { status: 200, body: players }),
    );
    await r.flush();
    await r.click('[data-opponent="open"]');
    window.__tg!.clickMain();
    await r.flush();
    expect(r.calls.find((c) => c.method === 'POST')?.body).toEqual({
      opponentId: null,
      timePerMove: 259200,
      colour: 'random',
      rated: true,
    });
  });

  it('explains an empty picker', async () => {
    const r = renderApp(() => <NewGame groupId="GrOuPiDxYz" />, () => ({ status: 200, body: { players: [] } }));
    await r.flush();
    expect(r.text()).toContain('Reply to their message with /play');
  });
});
```

`apps/miniapp/test/settings.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import { prefs } from '../src/state/session';
import { Settings } from '../src/ui/screens/Settings';
import { renderApp } from './support/render';

describe('Settings', () => {
  it('saves a toggled preference and keeps the returned prefs', async () => {
    const r = renderApp(
      () => <Settings />,
      ({ body }) => ({
        status: 200,
        body: { prefs: { ...prefs.value, ...(body as { prefs: object }).prefs }, dmAllowed: false },
      }),
    );
    await r.click('[data-pref="confirmMoves"]');
    expect(r.calls[0]).toMatchObject({ method: 'PUT', path: '/api/me/prefs', body: { prefs: { confirmMoves: false } } });
    expect(prefs.value.confirmMoves).toBe(false);
    expect(r.root.querySelector('[data-pref="confirmMoves"]')?.getAttribute('aria-checked')).toBe('false');
  });

  it('deletes my data after confirmation and closes the app', async () => {
    const r = renderApp(() => <Settings />, () => ({ status: 200, body: { ok: true } }));
    await r.click('[data-action="delete"]');
    expect(r.calls).toHaveLength(0);
    await r.click('[data-dialog="cancel"]');
    expect(r.calls).toHaveLength(0);
    await r.click('[data-action="delete"]');
    await r.click('[data-dialog="confirm"]');
    expect(r.calls[0]).toMatchObject({ method: 'DELETE', path: '/api/me' });
    expect(window.__tg!.closed).toBe(true);
  });
});
```

`apps/miniapp/test/groupSettings.test.tsx`:

```tsx
import type { GroupSettingsDto, LobbyDto } from '@group-chess/shared';
import { describe, expect, it } from 'vitest';
import { GroupSettings } from '../src/ui/screens/GroupSettings';
import { renderApp } from './support/render';

const dto: GroupSettingsDto = {
  group: { id: 'GrOuPiDxYz', title: 'Chess Club' },
  settings: {
    defaultTimePerMove: 86400,
    ratedDefault: true,
    allowOpenChallenges: true,
    maxActiveGamesPerUser: 5,
    leaderboardMinGames: 5,
    cardTopicMode: 'origin',
    fixedTopicId: null,
  },
  blocked: [{ id: '3', name: 'Carol', username: null, rating: 1500, provisional: true }],
  botIsAdmin: true,
  isForum: true,
};
const lobby: LobbyDto = {
  group: dto.group,
  isAdmin: true,
  settings: { defaultTimePerMove: 86400, ratedDefault: true, allowOpenChallenges: true },
  active: [],
  finished: { items: [], nextCursor: null },
  challenges: [],
  players: [{ id: '2', name: 'Bob', username: null, rating: 1500, provisional: true, gamesPlayed: 1, record: { wins: 1, draws: 0, losses: 0 } }],
};

describe('GroupSettings', () => {
  const route = ({ path, method }: { path: string; method: string }) => {
    if (method === 'PUT') return { status: 200, body: dto };
    if (path.endsWith('/settings')) return { status: 200, body: dto };
    if (path.endsWith('/blocks/3') || path.endsWith('/blocks')) return { status: 200, body: { ok: true } };
    return { status: 200, body: lobby };
  };

  it('saves only the changed fields and refuses a fixed topic without an id', async () => {
    const r = renderApp(() => <GroupSettings groupId="GrOuPiDxYz" />, route);
    await r.flush();
    await r.click('[data-setting="ratedDefault"]');
    await r.click('[data-topic="fixed"]');
    expect(window.__tg!.mainButton.enabled).toBe(false);
    const input = r.root.querySelector<HTMLInputElement>('[data-setting="fixedTopicId"]')!;
    input.value = '42';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await r.flush();
    expect(window.__tg!.mainButton.enabled).toBe(true);
    window.__tg!.clickMain();
    await r.flush();
    const put = r.calls.find((c) => c.method === 'PUT');
    expect(put?.path).toBe('/api/groups/GrOuPiDxYz/settings');
    expect(put?.body).toEqual({ ratedDefault: false, cardTopicMode: 'fixed', fixedTopicId: 42 });
  });

  it('unblocks and blocks players', async () => {
    const r = renderApp(() => <GroupSettings groupId="GrOuPiDxYz" />, route);
    await r.flush();
    expect(r.text()).toContain('Carol');
    await r.click('[data-unblock="3"]');
    expect(r.calls.find((c) => c.method === 'DELETE')?.path).toBe('/api/groups/GrOuPiDxYz/blocks/3');
    await r.click('[data-block="2"]');
    await r.click('[data-dialog="confirm"]');
    const post = r.calls.find((c) => c.method === 'POST');
    expect(post).toMatchObject({ path: '/api/groups/GrOuPiDxYz/blocks', body: { userId: '2' } });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run --project miniapp`
Expected: FAIL — the new test files cannot resolve `../src/router`, `../src/boot`, `../src/ui/…`.

- [ ] **Step 3: Write the router, the boot sequence, the shell and the screens**

`apps/miniapp/src/router.ts`:

```ts
import type { GroupRef, LobbyDto } from '@group-chess/shared';
import { computed, signal, type ReadonlySignal, type Signal } from '@preact/signals';
import type { Tg } from './tg/webapp';

export type LobbyTab = 'active' | 'finished' | 'players';

export type Route =
  | { name: 'loading' }
  | { name: 'error' }
  | { name: 'reopen' }
  | { name: 'locked'; group: GroupRef }
  | { name: 'groups' }
  | { name: 'lobby'; groupId: string; tab?: LobbyTab }
  | { name: 'newGame'; groupId: string; defaults?: LobbyDto['settings'] }
  | { name: 'game'; gameId: string }
  | { name: 'player'; groupId: string; userId: string }
  | { name: 'settings' }
  | { name: 'groupSettings'; groupId: string };

/**
 * An in-memory route stack (Telegram owns the URL fragment) bound to the BackButton (spec §6.1
 * step 5): the button shows below the root, or at the root when the app should close from there.
 */
export class Router {
  readonly stack: Signal<Route[]> = signal([]);
  readonly current: ReadonlySignal<Route>;

  constructor(
    private readonly tg: Tg,
    private readonly options: { closeWhenEmpty: boolean },
  ) {
    this.current = computed(() => this.stack.value.at(-1) ?? { name: 'loading' });
    this.sync();
  }

  reset(route: Route): void {
    this.stack.value = [route];
    this.sync();
  }

  push(route: Route): void {
    this.stack.value = [...this.stack.value, route];
    this.sync();
  }

  replace(route: Route): void {
    this.stack.value = [...this.stack.value.slice(0, -1), route];
    this.sync();
  }

  /** Pops one level; false at the root, where the caller (or the BackButton) may close the app. */
  back(): boolean {
    if (this.stack.value.length <= 1) return false;
    this.stack.value = this.stack.value.slice(0, -1);
    this.sync();
    return true;
  }

  private sync(): void {
    const depth = this.stack.value.length;
    const visible = depth > 1 || (depth === 1 && this.options.closeWhenEmpty);
    this.tg.setBackButton(visible, () => {
      if (!this.back() && this.options.closeWhenEmpty) this.tg.close();
    });
  }
}
```

`apps/miniapp/src/ui/context.ts`:

```ts
import type { GameDto, GroupSettingsDto, LobbyDto, MeGroupsDto } from '@group-chess/shared';
import { createContext } from 'preact';
import { useContext } from 'preact/hooks';
import type { ApiClient } from '../api/client';
import type { Router } from '../router';
import type { Tg } from '../tg/webapp';

/** Data that arrived with the launch response, consumed once by the first screen (spec §6.1). */
export type Prefetched = {
  game?: GameDto;
  lobby?: LobbyDto;
  settings?: GroupSettingsDto;
  groups?: MeGroupsDto;
};

export type AppContextValue = {
  tg: Tg;
  client: ApiClient;
  router: Router;
  prefetched: Prefetched;
};

export const AppContext = createContext<AppContextValue | null>(null);
export const AppProvider = AppContext.Provider;

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error('AppProvider is missing');
  return value;
}
```

`apps/miniapp/src/boot.ts`:

```ts
import type { LaunchRoute } from '@group-chess/shared';
import { launch } from './api/launch';
import type { Route } from './router';
import { applyLaunch } from './state/session';
import { applyTheme } from './tg/theme';
import type { AppContextValue, Prefetched } from './ui/context';

/** Maps the launch route to a screen and parks its data for that screen's first render. */
export function routeFor(route: LaunchRoute, prefetched: Prefetched): Route {
  switch (route.kind) {
    case 'game':
      prefetched.game = route.game;
      return { name: 'game', gameId: route.game.id };
    case 'lobby':
      prefetched.lobby = route.lobby;
      return { name: 'lobby', groupId: route.lobby.group.id };
    case 'settings':
      prefetched.settings = route.settings;
      return { name: 'groupSettings', groupId: route.settings.group.id };
    case 'groups':
      prefetched.groups = route.groups;
      return { name: 'groups' };
    case 'locked':
      return { name: 'locked', group: route.group };
  }
}

/** Spec §6.1 steps 1–4: prepare the client, launch once, land, then ask for write access. */
export async function boot(app: AppContextValue): Promise<void> {
  const { tg, client, router, prefetched } = app;
  applyTheme(tg);
  tg.ready();
  tg.expand();
  tg.disableVerticalSwipes();
  tg.onThemeChanged(() => applyTheme(tg));
  tg.onViewportChanged(() => applyTheme(tg));

  const outcome = await launch(client, tg.initData);
  if (outcome.kind === 'expired') {
    router.reset({ name: 'reopen' });
    return;
  }
  if (outcome.kind === 'failed') {
    router.reset({ name: 'error' });
    return;
  }
  applyLaunch(outcome.response, tg.startParam);
  router.reset(routeFor(outcome.response.route, prefetched));

  if (outcome.response.askWriteAccess && tg.supports('writeAccess')) {
    setTimeout(() => {
      void tg.requestWriteAccess().then(async (granted) => {
        if (granted === null) return;
        await client.put('/api/me/prefs', { writeAccess: { allowed: granted } }).catch(() => undefined);
      });
    }, 0);
  }
}

/** The 401 path of spec §6.1 step 6: one relaunch with the original initData, or the reopen screen. */
export async function relaunch(app: AppContextValue): Promise<string | null> {
  const outcome = await launch(app.client, app.tg.initData);
  if (outcome.kind === 'ok') return outcome.response.token;
  app.router.reset({ name: 'reopen' });
  return null;
}
```

`apps/miniapp/src/ui/hooks.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { ApiError } from '../api/client';
import type { ButtonSpec } from '../tg/webapp';
import { useApp } from './context';

export type Resource<T> = {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  reload(): Promise<void>;
  set(data: T): void;
};

/** Loads once per `key`; `initial` (launch data) skips the first request. */
export function useResource<T>(key: string, load: () => Promise<T>, initial?: T): Resource<T> {
  const [data, setData] = useState<T | null>(initial ?? null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(initial === undefined);
  const loadRef = useRef(load);
  loadRef.current = load;
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await loadRef.current());
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : new ApiError(0, 'network', String(caught)));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (initial === undefined) void reload();
  }, [key]);
  return { data, error, loading, reload, set: setData };
}

/**
 * Binds Telegram's MainButton to `spec`; returns true when the client has no such button and the
 * screen must render one in the page instead.
 */
export function useMainButton(spec: ButtonSpec | null): boolean {
  const { tg } = useApp();
  const [inPage, setInPage] = useState(false);
  useEffect(() => {
    const bound = tg.setMainButton(spec);
    setInPage(spec !== null && !bound);
    return () => {
      tg.setMainButton(null);
    };
  }, [tg, spec?.text, spec?.enabled, spec?.progress, spec?.onClick]);
  return inPage;
}
```

`apps/miniapp/src/ui/toast.tsx`:

```tsx
import { signal } from '@preact/signals';

const toasts = signal<{ id: number; text: string }[]>([]);
let next = 1;

export function toast(text: string, ms = 2_000): void {
  const id = next++;
  toasts.value = [...toasts.value, { id, text }];
  setTimeout(() => {
    toasts.value = toasts.value.filter((entry) => entry.id !== id);
  }, ms);
}

export function Toasts() {
  const last = toasts.value.at(-1);
  return last ? <div class="toast" role="status">{last.text}</div> : null;
}
```

`apps/miniapp/src/ui/dialog.tsx`:

```tsx
import { t } from '@group-chess/shared';
import { signal } from '@preact/signals';

type Pending = {
  message: string;
  confirmLabel: string;
  danger: boolean;
  resolve: (answer: boolean) => void;
};

const pending = signal<Pending | null>(null);

/** A bottom sheet with Cancel and one confirm action; resolves the answer. */
export function confirmDialog(
  message: string,
  options: { confirmLabel?: string; danger?: boolean } = {},
): Promise<boolean> {
  pending.value?.resolve(false);
  return new Promise((resolve) => {
    pending.value = {
      message,
      confirmLabel: options.confirmLabel ?? t('app.game.confirm'),
      danger: options.danger ?? false,
      resolve,
    };
  });
}

export function Dialogs() {
  const current = pending.value;
  if (!current) return null;
  const answer = (value: boolean) => {
    pending.value = null;
    current.resolve(value);
  };
  return (
    <div class="dialog-backdrop" onClick={() => answer(false)}>
      <div class="dialog" role="dialog" onClick={(event) => event.stopPropagation()}>
        <p>{current.message}</p>
        <div class="actions">
          <button class="btn secondary" data-dialog="cancel" onClick={() => answer(false)}>
            {t('app.game.cancel')}
          </button>
          <button class={`btn ${current.danger ? 'danger' : ''}`} data-dialog="confirm" onClick={() => answer(true)}>
            {current.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
```

`apps/miniapp/src/ui/controls.tsx`:

```tsx
import type { JSX } from 'preact';

type DataAttributes = Record<`data-${string}`, string | number | boolean | undefined>;

export function Switch(
  props: { checked: boolean; onChange: (checked: boolean) => void; label?: string } & DataAttributes,
) {
  const { checked, onChange, label, ...rest } = props;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked ? 'true' : 'false'}
      aria-label={label}
      class="switch"
      onClick={() => onChange(!checked)}
      {...rest}
    />
  );
}

export type Option<V extends string> = { value: V; label: string } & DataAttributes;

export function Segmented<V extends string>(props: {
  options: Option<V>[];
  value: V;
  onChange: (value: V) => void;
}) {
  return (
    <div class="segmented" role="group">
      {props.options.map(({ value, label, ...data }) => (
        <button
          type="button"
          key={value}
          aria-pressed={props.value === value ? 'true' : 'false'}
          onClick={() => props.onChange(value)}
          {...data}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function Select<V extends string>(
  props: { options: { value: V; label: string }[]; value: V; onChange: (value: V) => void } & DataAttributes,
) {
  const { options, value, onChange, ...rest } = props;
  const handle = (event: JSX.TargetedEvent<HTMLSelectElement>) =>
    onChange(event.currentTarget.value as V);
  return (
    <select value={value} onChange={handle} {...rest}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function Field(props: { label: string; children: preact.ComponentChildren }) {
  return (
    <label class="field">
      <span>{props.label}</span>
      {props.children}
    </label>
  );
}
```

`apps/miniapp/src/ui/format.ts`:

```ts
import {
  endReasonLabel,
  ratedLabel,
  ratingLabel,
  resultLabel,
  t,
  timePerMoveLabel,
  type GameSummary,
  type PlayerRef,
  type TimePerMove,
} from '@group-chess/shared';

export function playerLabel(player: PlayerRef): string {
  return `${player.name} ${ratingLabel(player.rating, player.provisional)}`;
}

export function termsLabel(timePerMove: TimePerMove, rated: boolean): string {
  return t('app.lobby.terms', { timePerMove: timePerMoveLabel(timePerMove), rated: ratedLabel(rated) });
}

export function summaryTitle(summary: GameSummary): string {
  return `${summary.white.name} vs ${summary.black.name}`;
}

/** The second line of a game row. */
export function summaryStatus(summary: GameSummary): string {
  if (summary.status === 'finished') {
    const result = summary.result ? resultLabel(summary.result) : '';
    const reason = summary.endReason ? endReasonLabel(summary.endReason) : '';
    return [result, reason].filter(Boolean).join(' · ');
  }
  const mover = summary.sideToMove === 'white' ? summary.white.name : summary.black.name;
  return `${t('app.lobby.to_move', { name: mover })} · ${termsLabel(summary.timePerMove, summary.rated)}`;
}
```

`apps/miniapp/src/ui/rows.tsx`:

```tsx
import { t, type ChallengeDto, type GameSummary, type LeaderboardEntry } from '@group-chess/shared';
import { playerLabel, summaryStatus, summaryTitle, termsLabel } from './format';

export function GameRow(props: { game: GameSummary; onOpen: (id: string) => void }) {
  const { game } = props;
  return (
    <button class="row" data-game={game.id} onClick={() => props.onOpen(game.id)}>
      <span class="grow">
        <span class="primary">{summaryTitle(game)}</span>
        <span class="secondary">{summaryStatus(game)}</span>
      </span>
      {game.yourTurn && game.status === 'active' ? <span class="badge">{t('app.lobby.your_move')}</span> : null}
      {game.voided ? <span class="badge muted">{t('app.lobby.void_badge')}</span> : null}
    </button>
  );
}

export function ChallengeRow(props: {
  challenge: ChallengeDto;
  onAccept: (id: string) => void;
  onDecline: (id: string) => void;
  onCancel: (id: string) => void;
}) {
  const { challenge } = props;
  const line = challenge.opponent
    ? t('app.lobby.challenge.direct', { challenger: challenge.challenger.name, opponent: challenge.opponent.name })
    : t('app.lobby.challenge.open', { challenger: challenge.challenger.name });
  return (
    <div class="row">
      <span class="grow">
        <span class="primary">{line}</span>
        <span class="secondary">{termsLabel(challenge.timePerMove, challenge.rated)}</span>
      </span>
      {challenge.viewer.canAccept ? (
        <button class="btn" data-accept={challenge.id} onClick={() => props.onAccept(challenge.id)}>
          {t('button.accept')}
        </button>
      ) : null}
      {challenge.viewer.canDecline ? (
        <button class="btn secondary" data-decline={challenge.id} onClick={() => props.onDecline(challenge.id)}>
          {t('button.decline')}
        </button>
      ) : null}
      {challenge.viewer.canCancel ? (
        <button class="btn secondary" data-cancel={challenge.id} onClick={() => props.onCancel(challenge.id)}>
          {t('button.cancel')}
        </button>
      ) : null}
    </div>
  );
}

export function PlayerRow(props: { entry: LeaderboardEntry; rank?: number; onOpen: (id: string) => void }) {
  const { entry } = props;
  return (
    <button class="row" data-player={entry.id} onClick={() => props.onOpen(entry.id)}>
      {props.rank !== undefined ? <span class="hint">{props.rank}</span> : null}
      <span class="grow">
        <span class="primary">{playerLabel(entry)}</span>
        <span class="secondary">{t('app.player.record', entry.record)}</span>
      </span>
      <span class="hint">{t('app.player.games', { count: entry.gamesPlayed })}</span>
    </button>
  );
}
```

`apps/miniapp/src/ui/screens/Status.tsx`:

```tsx
import { t, type GroupRef } from '@group-chess/shared';
import { useApp } from '../context';

export function Loading() {
  return <div class="screen centered hint">{t('app.common.loading')}</div>;
}

export function ErrorScreen(props: { onRetry?: () => void }) {
  return (
    <div class="screen centered">
      <p>{t('app.common.error')}</p>
      {props.onRetry ? (
        <button class="btn" onClick={props.onRetry}>
          {t('app.common.retry')}
        </button>
      ) : null}
    </div>
  );
}

export function Reopen() {
  const { tg } = useApp();
  return (
    <div class="screen centered">
      <h1 class="title">{t('app.reopen.title')}</h1>
      <p class="hint">{t('app.reopen.body')}</p>
      <button class="btn" onClick={() => tg.close()}>
        {t('app.common.close')}
      </button>
    </div>
  );
}

export function Locked(props: { group: GroupRef }) {
  const { tg } = useApp();
  return (
    <div class="screen centered">
      <h1 class="title">{t('app.locked.title')}</h1>
      <p>{props.group.title}</p>
      <p class="hint">{t('locked.hint')}</p>
      <button class="btn" onClick={() => tg.close()}>
        {t('app.common.close')}
      </button>
    </div>
  );
}
```

`apps/miniapp/src/ui/screens/Groups.tsx`:

```tsx
import { MeGroupsDtoSchema, t } from '@group-chess/shared';
import { useApp } from '../context';
import { useResource } from '../hooks';
import { ErrorScreen, Loading } from './Status';

export function Groups() {
  const { client, router, prefetched } = useApp();
  const initial = prefetched.groups;
  delete prefetched.groups;
  const groups = useResource('groups', () => client.get('/api/me/groups', MeGroupsDtoSchema), initial);
  if (groups.error) return <ErrorScreen onRetry={() => void groups.reload()} />;
  if (!groups.data) return <Loading />;
  return (
    <div class="screen">
      <h1 class="title">{t('app.groups.title')}</h1>
      {groups.data.groups.length === 0 ? <p class="hint">{t('app.groups.empty')}</p> : null}
      <div class="list">
        {groups.data.groups.map((group) => (
          <button
            key={group.id}
            class="row"
            data-group={group.id}
            onClick={() => router.push({ name: 'lobby', groupId: group.id })}
          >
            <span class="grow">
              <span class="primary">{group.title}</span>
              <span class="secondary">
                {t('app.groups.summary', { active: group.activeGames, yourMove: group.yourMove })}
              </span>
            </span>
            {group.yourMove > 0 ? <span class="badge">{group.yourMove}</span> : null}
          </button>
        ))}
      </div>
      <button class="btn secondary block" data-action="settings" onClick={() => router.push({ name: 'settings' })}>
        {t('app.settings.title')}
      </button>
    </div>
  );
}
```

`apps/miniapp/src/ui/screens/Lobby.tsx`:

```tsx
import {
  FinishedPageDtoSchema,
  GameDtoSchema,
  LobbyDtoSchema,
  t,
  type GameSummary,
  type LobbyDto,
} from '@group-chess/shared';
import { useState } from 'preact/hooks';
import { ApiError } from '../../api/client';
import type { LobbyTab } from '../../router';
import { useApp } from '../context';
import { useResource } from '../hooks';
import { ChallengeRow, GameRow, PlayerRow } from '../rows';
import { toast } from '../toast';
import { ErrorScreen, Loading } from './Status';

const TABS: LobbyTab[] = ['active', 'finished', 'players'];

function byYourMoveFirst(games: GameSummary[]): GameSummary[] {
  return [...games].sort((a, b) => Number(b.yourTurn) - Number(a.yourTurn));
}

export function Lobby(props: { groupId: string; tab?: LobbyTab }) {
  const { client, router, prefetched } = useApp();
  const initial = prefetched.lobby?.group.id === props.groupId ? prefetched.lobby : undefined;
  if (initial) delete prefetched.lobby;
  const lobby = useResource<LobbyDto>(
    `lobby:${props.groupId}`,
    () => client.get(`/api/groups/${props.groupId}`, LobbyDtoSchema),
    initial,
  );
  const [tab, setTab] = useState<LobbyTab>(props.tab ?? 'active');
  const [loadingMore, setLoadingMore] = useState(false);

  if (lobby.error) return <ErrorScreen onRetry={() => void lobby.reload()} />;
  const data = lobby.data;
  if (!data) return <Loading />;

  const openGame = (gameId: string) => router.push({ name: 'game', gameId });
  const act = async (path: string, after: () => void | Promise<void>) => {
    try {
      await client.post(path, {});
      await after();
    } catch (error) {
      if (error instanceof ApiError && error.code !== 'network') await lobby.reload();
      else toast(t('app.common.offline'));
    }
  };
  const accept = async (id: string) => {
    try {
      const game = await client.post(`/api/challenges/${id}/accept`, {}, GameDtoSchema);
      prefetched.game = game;
      router.push({ name: 'game', gameId: game.id });
    } catch (error) {
      if (error instanceof ApiError && error.code === 'stale_state') toast(t('alert.accepted_first'));
      await lobby.reload();
    }
  };
  const more = async () => {
    if (!data.finished.nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await client.get(
        `/api/groups/${props.groupId}/finished?cursor=${encodeURIComponent(data.finished.nextCursor)}`,
        FinishedPageDtoSchema,
      );
      lobby.set({ ...data, finished: { items: [...data.finished.items, ...page.items], nextCursor: page.nextCursor } });
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div class="screen">
      <h1 class="title">{data.group.title}</h1>
      <div class="actions">
        <button
          class="btn"
          data-action="new-game"
          onClick={() => router.push({ name: 'newGame', groupId: props.groupId, defaults: data.settings })}
        >
          {t('app.lobby.new_game')}
        </button>
        {data.isAdmin ? (
          <button
            class="btn secondary"
            data-action="group-settings"
            onClick={() => router.push({ name: 'groupSettings', groupId: props.groupId })}
          >
            {t('app.lobby.settings')}
          </button>
        ) : null}
      </div>
      {data.challenges.length > 0 ? (
        <>
          <div class="section">{t('app.lobby.challenges')}</div>
          <div class="list">
            {data.challenges.map((challenge) => (
              <ChallengeRow
                key={challenge.id}
                challenge={challenge}
                onAccept={(id) => void accept(id)}
                onDecline={(id) => void act(`/api/challenges/${id}/decline`, lobby.reload)}
                onCancel={(id) => void act(`/api/challenges/${id}/cancel`, lobby.reload)}
              />
            ))}
          </div>
        </>
      ) : null}
      <div class="tabs" role="tablist">
        {TABS.map((name) => (
          <button
            key={name}
            role="tab"
            class="tab"
            data-tab={name}
            aria-selected={tab === name ? 'true' : 'false'}
            onClick={() => setTab(name)}
          >
            {t(`app.lobby.tab.${name}`)}
          </button>
        ))}
      </div>
      {tab === 'active' ? (
        <div class="list">
          {data.active.length === 0 ? <p class="row hint">{t('app.lobby.no_active')}</p> : null}
          {byYourMoveFirst(data.active).map((game) => (
            <GameRow key={game.id} game={game} onOpen={openGame} />
          ))}
        </div>
      ) : null}
      {tab === 'finished' ? (
        <>
          <div class="list">
            {data.finished.items.length === 0 ? <p class="row hint">{t('app.lobby.no_finished')}</p> : null}
            {data.finished.items.map((game) => (
              <GameRow key={game.id} game={game} onOpen={openGame} />
            ))}
          </div>
          {data.finished.nextCursor ? (
            <button class="btn secondary block" disabled={loadingMore} onClick={() => void more()}>
              {t('app.common.more')}
            </button>
          ) : null}
        </>
      ) : null}
      {tab === 'players' ? (
        <div class="list">
          {data.players.length === 0 ? <p class="row hint">{t('app.lobby.no_players')}</p> : null}
          {data.players.map((entry, index) => (
            <PlayerRow
              key={entry.id}
              entry={entry}
              rank={index + 1}
              onOpen={(userId) => router.push({ name: 'player', groupId: props.groupId, userId })}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
```

`apps/miniapp/src/ui/screens/NewGame.tsx`:

```tsx
import {
  ChallengeDtoSchema,
  GROUP_SETTINGS_DEFAULTS,
  PlayersPickerDtoSchema,
  t,
  TIME_PER_MOVE_OPTIONS,
  timePerMoveLabel,
  type ChallengeRequest,
  type ColourChoice,
  type LobbyDto,
  type TimePerMove,
} from '@group-chess/shared';
import { useMemo, useState } from 'preact/hooks';
import { ApiError } from '../../api/client';
import { useApp } from '../context';
import { Segmented, Switch } from '../controls';
import { playerLabel } from '../format';
import { useMainButton, useResource } from '../hooks';
import { toast } from '../toast';
import { ErrorScreen, Loading } from './Status';

const TIME_VALUES: TimePerMove[] = [...TIME_PER_MOVE_OPTIONS, null];

export function NewGame(props: { groupId: string; defaults?: LobbyDto['settings'] }) {
  const { client, router } = useApp();
  const defaults = props.defaults ?? GROUP_SETTINGS_DEFAULTS;
  const players = useResource(`players:${props.groupId}`, () =>
    client.get(`/api/groups/${props.groupId}/players`, PlayersPickerDtoSchema),
  );
  const [opponentId, setOpponentId] = useState<string | null | undefined>(undefined);
  const [timePerMove, setTimePerMove] = useState<TimePerMove>(defaults.defaultTimePerMove);
  const [colour, setColour] = useState<ColourChoice>('random');
  const [rated, setRated] = useState(defaults.ratedDefault);
  const [sending, setSending] = useState(false);

  const ready = opponentId !== undefined && !sending;
  const submit = useMemo(
    () => async () => {
      if (opponentId === undefined) return;
      setSending(true);
      const body: ChallengeRequest = { opponentId, timePerMove, colour, rated };
      try {
        await client.post(`/api/groups/${props.groupId}/challenges`, body, ChallengeDtoSchema);
        toast(t('app.new.sent'));
        router.replace({ name: 'lobby', groupId: props.groupId });
      } catch (error) {
        toast(error instanceof ApiError && error.code === 'network' ? t('app.common.offline') : t('app.common.error'));
      } finally {
        setSending(false);
      }
    },
    [client, router, props.groupId, opponentId, timePerMove, colour, rated],
  );
  const inPage = useMainButton({ text: t('app.new.send'), onClick: () => void submit(), enabled: ready, progress: sending });

  if (players.error) return <ErrorScreen onRetry={() => void players.reload()} />;
  if (!players.data) return <Loading />;

  return (
    <div class="screen">
      <h1 class="title">{t('app.new.title')}</h1>
      <div class="section">{t('app.new.opponent')}</div>
      <div class="list">
        {players.data.players.map((player) => (
          <button
            key={player.id}
            class="row"
            data-opponent={player.id}
            aria-pressed={opponentId === player.id ? 'true' : 'false'}
            onClick={() => setOpponentId(player.id)}
          >
            <span class="grow primary">{playerLabel(player)}</span>
            {opponentId === player.id ? <span class="badge">✓</span> : null}
          </button>
        ))}
        {defaults.allowOpenChallenges ? (
          <button
            class="row"
            data-opponent="open"
            aria-pressed={opponentId === null ? 'true' : 'false'}
            onClick={() => setOpponentId(null)}
          >
            <span class="grow primary">{t('app.new.open_challenge')}</span>
            {opponentId === null ? <span class="badge">✓</span> : null}
          </button>
        ) : null}
      </div>
      {players.data.players.length === 0 ? <p class="hint">{t('app.new.no_players')}</p> : null}
      <div class="section">{t('app.new.time')}</div>
      <div class="list">
        {TIME_VALUES.map((value) => (
          <button
            key={String(value)}
            class="row"
            data-time={value === null ? 'none' : value}
            aria-pressed={timePerMove === value ? 'true' : 'false'}
            onClick={() => setTimePerMove(value)}
          >
            <span class="grow primary">{timePerMoveLabel(value)}</span>
            {timePerMove === value ? <span class="badge">✓</span> : null}
          </button>
        ))}
      </div>
      <div class="section">{t('app.new.colour')}</div>
      <Segmented
        value={colour}
        onChange={setColour}
        options={[
          { value: 'white', label: t('colour.white'), 'data-colour': 'white' },
          { value: 'random', label: t('colour.random'), 'data-colour': 'random' },
          { value: 'black', label: t('colour.black'), 'data-colour': 'black' },
        ]}
      />
      <div class="list" style={{ marginTop: 16 }}>
        <div class="field">
          <span>{t('app.new.rated')}</span>
          <Switch checked={rated} onChange={setRated} data-rated="" label={t('app.new.rated')} />
        </div>
      </div>
      {inPage ? (
        <div class="inline-main">
          <button class="btn block" disabled={!ready} onClick={() => void submit()}>
            {t('app.new.send')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
```

`apps/miniapp/src/ui/screens/Player.tsx`:

```tsx
import { PlayerPageDtoSchema, t } from '@group-chess/shared';
import { useApp } from '../context';
import { playerLabel } from '../format';
import { useResource } from '../hooks';
import { GameRow } from '../rows';
import { ErrorScreen, Loading } from './Status';

export function Player(props: { groupId: string; userId: string }) {
  const { client, router } = useApp();
  const page = useResource(`player:${props.groupId}:${props.userId}`, () =>
    client.get(`/api/groups/${props.groupId}/players/${props.userId}`, PlayerPageDtoSchema),
  );
  if (page.error) return <ErrorScreen onRetry={() => void page.reload()} />;
  if (!page.data) return <Loading />;
  const { player, headToHead, recentGames } = page.data;
  return (
    <div class="screen">
      <h1 class="title">{playerLabel(player)}</h1>
      <p class="subtitle">
        {t('app.player.record', player.record)} · {t('app.player.games', { count: player.gamesPlayed })}
      </p>
      <p class="hint">{t('app.player.head_to_head', headToHead)}</p>
      <div class="section">{t('app.player.recent')}</div>
      <div class="list">
        {recentGames.map((game) => (
          <GameRow key={game.id} game={game} onOpen={(gameId) => router.push({ name: 'game', gameId })} />
        ))}
      </div>
    </div>
  );
}
```

`apps/miniapp/src/ui/screens/Settings.tsx`:

```tsx
import { PrefsSchema, t, type Prefs } from '@group-chess/shared';
import { z } from 'zod';
import { prefs } from '../../state/session';
import { useApp } from '../context';
import { Switch } from '../controls';
import { confirmDialog } from '../dialog';
import { toast } from '../toast';

const PrefsResponseSchema = z.object({ prefs: PrefsSchema, dmAllowed: z.boolean() });
const TOGGLES: { key: keyof Pick<Prefs, 'confirmMoves' | 'closeAfterMove' | 'notifications'>; label: string }[] = [
  { key: 'confirmMoves', label: 'app.settings.confirm_moves' },
  { key: 'closeAfterMove', label: 'app.settings.close_after_move' },
  { key: 'notifications', label: 'app.settings.notifications' },
];

export function Settings() {
  const { client, tg } = useApp();
  const current = prefs.value;
  const update = async (patch: Partial<Prefs>) => {
    const previous = prefs.value;
    prefs.value = { ...previous, ...patch };
    try {
      const response = await client.put('/api/me/prefs', { prefs: patch }, PrefsResponseSchema);
      prefs.value = response.prefs;
    } catch {
      prefs.value = previous;
      toast(t('app.common.error'));
    }
  };
  const remove = async () => {
    if (!(await confirmDialog(t('app.settings.delete_confirm'), { confirmLabel: t('app.settings.delete'), danger: true }))) return;
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
      <div class="list">
        {TOGGLES.map(({ key, label }) => (
          <div class="field" key={key}>
            <span>{t(label as 'app.settings.confirm_moves')}</span>
            <Switch
              checked={current[key]}
              onChange={(value) => void update({ [key]: value })}
              data-pref={key}
              label={t(label as 'app.settings.confirm_moves')}
            />
          </div>
        ))}
      </div>
      <button class="btn danger block" data-action="delete" onClick={() => void remove()}>
        {t('app.settings.delete')}
      </button>
      <p class="hint">{t('app.settings.about')}</p>
    </div>
  );
}
```

`apps/miniapp/src/ui/screens/GroupSettings.tsx`:

```tsx
import {
  GroupSettingsDtoSchema,
  LobbyDtoSchema,
  t,
  TIME_PER_MOVE_OPTIONS,
  timePerMoveLabel,
  type GameSummary,
  type GroupSettings as Settings,
  type TimePerMove,
} from '@group-chess/shared';
import { useMemo, useState } from 'preact/hooks';
import { useApp } from '../context';
import { Field, Segmented, Select, Switch } from '../controls';
import { confirmDialog } from '../dialog';
import { playerLabel, summaryTitle } from '../format';
import { useMainButton, useResource } from '../hooks';
import { toast } from '../toast';
import { ErrorScreen, Loading } from './Status';

function changed(base: Settings, draft: Settings): Partial<Settings> {
  const patch: Partial<Settings> = {};
  for (const key of Object.keys(draft) as (keyof Settings)[]) {
    if (draft[key] !== base[key]) (patch as Record<string, unknown>)[key] = draft[key];
  }
  return patch;
}

export function GroupSettings(props: { groupId: string }) {
  const { client, prefetched } = useApp();
  const initial = prefetched.settings?.group.id === props.groupId ? prefetched.settings : undefined;
  if (initial) delete prefetched.settings;
  const settings = useResource(
    `gsettings:${props.groupId}`,
    () => client.get(`/api/groups/${props.groupId}/settings`, GroupSettingsDtoSchema),
    initial,
  );
  const lobby = useResource(`lobby:${props.groupId}`, () =>
    client.get(`/api/groups/${props.groupId}`, LobbyDtoSchema),
  );
  const [draft, setDraft] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const base = settings.data?.settings ?? null;
  const current = draft ?? base;
  const patch = base && current ? changed(base, current) : {};
  const valid = current ? current.cardTopicMode === 'origin' || (current.fixedTopicId ?? 0) > 0 : false;
  const dirty = Object.keys(patch).length > 0;

  const save = useMemo(
    () => async () => {
      if (!dirty || !valid) return;
      setSaving(true);
      try {
        const updated = await client.put(`/api/groups/${props.groupId}/settings`, patch, GroupSettingsDtoSchema);
        settings.set(updated);
        setDraft(null);
        toast(t('app.common.saved'));
      } catch {
        toast(t('app.common.error'));
      } finally {
        setSaving(false);
      }
    },
    [client, props.groupId, patch, dirty, valid, settings],
  );
  const inPage = useMainButton(
    dirty ? { text: t('app.common.save'), onClick: () => void save(), enabled: valid && !saving, progress: saving } : null,
  );

  if (settings.error) return <ErrorScreen onRetry={() => void settings.reload()} />;
  if (!settings.data || !current) return <Loading />;
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setDraft({ ...current, [key]: value });

  const unblock = async (userId: string) => {
    await client.del(`/api/groups/${props.groupId}/blocks/${userId}`);
    await settings.reload();
  };
  const block = async (userId: string, name: string) => {
    if (!(await confirmDialog(`${t('app.gsettings.block')}: ${name}?`, { danger: true }))) return;
    await client.post(`/api/groups/${props.groupId}/blocks`, { userId });
    await settings.reload();
  };
  const voidGame = async (game: GameSummary) => {
    if (!(await confirmDialog(t('app.game.void_confirm'), { confirmLabel: t('app.game.void'), danger: true }))) return;
    await client.post(`/api/games/${game.id}/void`, {});
    toast(t('app.game.voided'));
    await lobby.reload();
  };
  const blockedIds = new Set(settings.data.blocked.map((player) => player.id));
  const candidates = (lobby.data?.players ?? []).filter((player) => !blockedIds.has(player.id));
  const games = [...(lobby.data?.active ?? []), ...(lobby.data?.finished.items ?? [])].filter((game) => !game.voided);

  return (
    <div class="screen">
      <h1 class="title">{t('app.gsettings.title')}</h1>
      <p class="subtitle">{settings.data.group.title}</p>
      <div class="list">
        <Field label={t('app.gsettings.default_time')}>
          <Select
            data-setting="defaultTimePerMove"
            value={String(current.defaultTimePerMove)}
            onChange={(value) => set('defaultTimePerMove', (value === 'null' ? null : Number(value)) as TimePerMove)}
            options={[...TIME_PER_MOVE_OPTIONS, null].map((value) => ({
              value: String(value),
              label: timePerMoveLabel(value),
            }))}
          />
        </Field>
        <div class="field">
          <span>{t('app.gsettings.rated_default')}</span>
          <Switch checked={current.ratedDefault} onChange={(value) => set('ratedDefault', value)} data-setting="ratedDefault" />
        </div>
        <div class="field">
          <span>{t('app.gsettings.open')}</span>
          <Switch checked={current.allowOpenChallenges} onChange={(value) => set('allowOpenChallenges', value)} data-setting="allowOpenChallenges" />
        </div>
        <Field label={t('app.gsettings.max_active')}>
          <input
            type="number"
            min={1}
            max={20}
            data-setting="maxActiveGamesPerUser"
            value={current.maxActiveGamesPerUser}
            onInput={(event) => set('maxActiveGamesPerUser', Number(event.currentTarget.value))}
          />
        </Field>
        <Field label={t('app.gsettings.min_games')}>
          <input
            type="number"
            min={0}
            max={100}
            data-setting="leaderboardMinGames"
            value={current.leaderboardMinGames}
            onInput={(event) => set('leaderboardMinGames', Number(event.currentTarget.value))}
          />
        </Field>
        {settings.data.isForum ? (
          <>
            <div class="field">
              <span>{t('app.gsettings.topic')}</span>
              <Segmented
                value={current.cardTopicMode}
                onChange={(value) => set('cardTopicMode', value)}
                options={[
                  { value: 'origin', label: t('app.gsettings.topic.origin'), 'data-topic': 'origin' },
                  { value: 'fixed', label: t('app.gsettings.topic.fixed'), 'data-topic': 'fixed' },
                ]}
              />
            </div>
            {current.cardTopicMode === 'fixed' ? (
              <Field label={t('app.gsettings.topic_id')}>
                <input
                  type="number"
                  min={1}
                  data-setting="fixedTopicId"
                  value={current.fixedTopicId ?? ''}
                  onInput={(event) => set('fixedTopicId', Number(event.currentTarget.value) || null)}
                />
              </Field>
            ) : null}
          </>
        ) : null}
      </div>
      {inPage && dirty ? (
        <button class="btn block" disabled={!valid || saving} onClick={() => void save()}>
          {t('app.common.save')}
        </button>
      ) : null}
      <div class="section">{t('app.gsettings.blocked')}</div>
      <div class="list">
        {settings.data.blocked.length === 0 ? <p class="row hint">{t('app.gsettings.none_blocked')}</p> : null}
        {settings.data.blocked.map((player) => (
          <div class="row" key={player.id}>
            <span class="grow primary">{playerLabel(player)}</span>
            <button class="btn secondary" data-unblock={player.id} onClick={() => void unblock(player.id)}>
              {t('app.gsettings.unblock')}
            </button>
          </div>
        ))}
      </div>
      <div class="section">{t('app.gsettings.block')}</div>
      <div class="list">
        {candidates.map((player) => (
          <div class="row" key={player.id}>
            <span class="grow primary">{playerLabel(player)}</span>
            <button class="btn danger" data-block={player.id} onClick={() => void block(player.id, player.name)}>
              {t('app.gsettings.block')}
            </button>
          </div>
        ))}
      </div>
      <div class="section">{t('app.gsettings.void')}</div>
      <div class="list">
        {games.map((game) => (
          <div class="row" key={game.id}>
            <span class="grow primary">{summaryTitle(game)}</span>
            <button class="btn danger" data-void={game.id} onClick={() => void voidGame(game)}>
              {t('app.game.void')}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
```

`apps/miniapp/src/ui/screens/Game.tsx` (placeholder until Task 5):

```tsx
import { Loading } from './Status';

export function Game(_props: { gameId: string }) {
  return <Loading />;
}
```

`apps/miniapp/src/ui/App.tsx`:

```tsx
import { useApp } from './context';
import { Dialogs } from './dialog';
import { Game } from './screens/Game';
import { GroupSettings } from './screens/GroupSettings';
import { Groups } from './screens/Groups';
import { Lobby } from './screens/Lobby';
import { NewGame } from './screens/NewGame';
import { Player } from './screens/Player';
import { Settings } from './screens/Settings';
import { ErrorScreen, Loading, Locked, Reopen } from './screens/Status';
import { Toasts } from './toast';

function Screen() {
  const { router } = useApp();
  const route = router.current.value;
  switch (route.name) {
    case 'loading':
      return <Loading />;
    case 'error':
      return <ErrorScreen onRetry={() => window.location.reload()} />;
    case 'reopen':
      return <Reopen />;
    case 'locked':
      return <Locked group={route.group} />;
    case 'groups':
      return <Groups />;
    case 'lobby':
      return <Lobby key={route.groupId} groupId={route.groupId} tab={route.tab} />;
    case 'newGame':
      return <NewGame key={route.groupId} groupId={route.groupId} defaults={route.defaults} />;
    case 'game':
      return <Game key={route.gameId} gameId={route.gameId} />;
    case 'player':
      return <Player key={`${route.groupId}:${route.userId}`} groupId={route.groupId} userId={route.userId} />;
    case 'settings':
      return <Settings />;
    case 'groupSettings':
      return <GroupSettings key={route.groupId} groupId={route.groupId} />;
  }
}

export function App() {
  return (
    <>
      <Screen />
      <Toasts />
      <Dialogs />
    </>
  );
}
```

Replace `apps/miniapp/src/main.tsx` with:

```tsx
import { decodeStartParam } from '@group-chess/shared';
import { render } from 'preact';
import { createApiClient } from './api/client';
import { boot, relaunch } from './boot';
import { Router } from './router';
import { createTg } from './tg/webapp';
import { App } from './ui/App';
import { AppProvider, type AppContextValue } from './ui/context';
import './styles.css';

const tg = createTg();
const router = new Router(tg, { closeWhenEmpty: decodeStartParam(tg.startParam)?.kind === 'game' });
const app: AppContextValue = {
  tg,
  router,
  prefetched: {},
  client: createApiClient({ onUnauthorized: () => relaunch(app) }),
};

render(
  <AppProvider value={app}>
    <App />
  </AppProvider>,
  document.getElementById('app')!,
);

void boot(app);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run --project miniapp`
Expected: PASS — 59 tests (43 before, router 3, boot 4, lobby 3, new game 3, settings 2, group settings 2).

- [ ] **Step 5: Build, run the whole suite and the static checks**

Run: `pnpm --filter @group-chess/miniapp build && pnpm test && pnpm typecheck && pnpm lint && pnpm format:check`
Expected: all exit 0.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(miniapp): add the router, boot sequence, app shell and the lobby, new game, player and settings screens"
```

---

### Task 5: The board adapter and the game screen (live board, replay, controls)

**Files:**
- Create: `apps/miniapp/src/board/adapter.ts`, `apps/miniapp/src/board/promotion.ts`, `apps/miniapp/src/ui/game/Board.tsx`, `apps/miniapp/src/ui/game/useClock.ts`, `apps/miniapp/src/ui/game/result.ts`, `apps/miniapp/src/ui/game/PlayerBar.tsx`, `apps/miniapp/src/ui/game/MoveList.tsx`, `apps/miniapp/src/ui/game/GameView.tsx`, `apps/miniapp/test/support/stubAdapter.ts`
- Modify: `apps/miniapp/src/ui/screens/Game.tsx` (the real screen)
- Test: `apps/miniapp/test/board.test.ts`, `apps/miniapp/test/game.test.tsx`

**Interfaces:**
- Consumes: Tasks 1–4; chessground `Chessground`, `Api`, `Config`, `Key`; shared `GameDtoSchema`, labels; chess.js for the promotion check.
- Produces: `type BoardPosition = { fen; lastMove; check; orientation; turnColour }`, `type Movable = { colour: Colour | 'none'; dests }`, `type MoveHandler`, `boardConfig(position, movable, viewOnly, onMove): Config`, `interface BoardAdapter { setPosition; setMovable; setViewOnly; onMove; flip; cancelMove; destroy }`, `createBoardAdapter(element, position, options?)`; `isPromotion(fen, orig, dest)`, `promotionPieces(colour)`, `promotionOverlayStyle(dest, orientation)`; `resultForViewer(dto)`, `ratingChangeFor(dto)`; `useClock(store)`; components `Board`, `PlayerBar`, `MoveList`, `GameView`; the real `Game` screen; test double `stubAdapter()`.

- [ ] **Step 1: Write the failing tests**

`apps/miniapp/test/support/stubAdapter.ts`:

```ts
import type { BoardAdapter, BoardPosition, Movable, MoveHandler } from '../../src/board/adapter';

export type StubAdapter = BoardAdapter & {
  positions: BoardPosition[];
  movables: Movable[];
  viewOnly: boolean | null;
  restored: number;
  drop(orig: string, dest: string, captured?: boolean): void;
};

/** What the game screen sees instead of chessground; tests drive drops through `drop`. */
export function stubAdapter(): StubAdapter {
  let handler: MoveHandler | null = null;
  const stub: StubAdapter = {
    positions: [],
    movables: [],
    viewOnly: null,
    restored: 0,
    setPosition: (position) => {
      stub.positions.push(position);
    },
    setMovable: (movable) => {
      stub.movables.push(movable);
    },
    setViewOnly: (value) => {
      stub.viewOnly = value;
    },
    onMove: (callback) => {
      handler = callback;
    },
    flip: () => undefined,
    cancelMove: () => {
      stub.restored += 1;
    },
    destroy: () => undefined,
    drop: (orig, dest, captured = false) => handler?.(orig, dest, { captured }),
  };
  return stub;
}
```

`apps/miniapp/test/board.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { boardConfig } from '../src/board/adapter';
import { isPromotion, promotionOverlayStyle, promotionPieces } from '../src/board/promotion';
import { resultForViewer, ratingChangeFor } from '../src/ui/game/result';
import { AFTER_E4, afterPlies, gameDto } from './support/gameFixtures';

describe('boardConfig', () => {
  it('maps a position and the movable set onto chessground options', () => {
    const dests = new Map([['e2', ['e3', 'e4']]]);
    const config = boardConfig(
      { fen: AFTER_E4, lastMove: ['e2', 'e4'], check: false, orientation: 'black', turnColour: 'black' },
      { colour: 'black', dests },
      false,
      () => undefined,
    );
    expect(config).toMatchObject({
      fen: AFTER_E4,
      orientation: 'black',
      turnColor: 'black',
      lastMove: ['e2', 'e4'],
      check: false,
      viewOnly: false,
      coordinates: true,
      movable: { free: false, color: 'black', showDests: true },
      premovable: { enabled: false },
      drawable: { enabled: false },
      selectable: { enabled: true },
      blockTouchScroll: true,
    });
    expect(config.movable?.dests?.get('e2')).toEqual(['e3', 'e4']);
  });

  it('lifts nothing for spectators and out of turn', () => {
    const config = boardConfig(
      { fen: AFTER_E4, lastMove: null, check: true, orientation: 'white', turnColour: 'black' },
      { colour: 'none', dests: new Map() },
      true,
      () => undefined,
    );
    expect(config.movable?.color).toBeUndefined();
    expect(config.viewOnly).toBe(true);
    expect(config.check).toBe(true);
  });
});

describe('promotion', () => {
  const WHITE_PAWN_E7 = '4k3/4P3/8/8/8/8/8/4K3 w - - 0 1';
  const BLACK_PAWN_D2 = '4k3/8/8/8/8/8/3p4/4K3 b - - 0 1';

  it('recognises a pawn reaching the last rank for either colour', () => {
    expect(isPromotion(WHITE_PAWN_E7, 'e7', 'e8')).toBe(true);
    expect(isPromotion(BLACK_PAWN_D2, 'd2', 'd1')).toBe(true);
    expect(isPromotion(AFTER_E4, 'e2', 'e4')).toBe(false);
    expect(isPromotion(WHITE_PAWN_E7, 'e1', 'e2')).toBe(false);
  });

  it('lists queen, rook, bishop and knight and positions the chooser over the target square', () => {
    expect(promotionPieces()).toEqual(['q', 'r', 'b', 'n']);
    expect(promotionOverlayStyle('e8', 'white')).toEqual({ left: '50%', top: '0%' });
    expect(promotionOverlayStyle('e8', 'black')).toEqual({ left: '37.5%', top: '87.5%' });
    expect(promotionOverlayStyle('d1', 'black')).toEqual({ left: '50%', top: '0%' });
  });
});

describe('result labels', () => {
  it('describes the result from the viewer’s side with the reason and the rating change', () => {
    const finished = afterPlies(4, {
      status: 'finished',
      result: '0-1',
      endReason: 'checkmate',
      viewerRole: 'black',
      black: { ...gameDto().black, rating: 1500, provisional: true, ratingAfter: 1662, provisionalAfter: true },
    });
    expect(resultForViewer(finished)).toBe('You won');
    expect(resultForViewer({ ...finished, viewerRole: 'white' })).toBe('You lost');
    expect(resultForViewer({ ...finished, viewerRole: 'spectator' })).toBe('Black won');
    expect(resultForViewer({ ...finished, result: '1/2-1/2', endReason: 'draw_agreement' })).toBe('Draw');
    expect(resultForViewer({ ...finished, result: '*', endReason: 'abort' })).toBe('Aborted');
    expect(ratingChangeFor(finished)).toBe('1500? → 1662?');
    expect(ratingChangeFor({ ...finished, viewerRole: 'spectator' })).toBeNull();
    expect(ratingChangeFor({ ...finished, rated: false })).toBeNull();
  });
});
```

`apps/miniapp/test/game.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prefs, session } from '../src/state/session';
import { Game } from '../src/ui/screens/Game';
import { FakeEventSource } from './support/fakeEventSource';
import type { FakeRoute } from './support/fakeFetch';
import { afterPlies, gameDto } from './support/gameFixtures';
import { renderApp } from './support/render';
import { stubAdapter, type StubAdapter } from './support/stubAdapter';

let adapter: StubAdapter;
vi.mock('../src/board/adapter', async () => {
  const actual = await vi.importActual<typeof import('../src/board/adapter')>('../src/board/adapter');
  return { ...actual, createBoardAdapter: () => adapter };
});

const GAME = 'AbCdEfGhIj';
const okRoute =
  (initial: ReturnType<typeof gameDto>, onMove?: FakeRoute): FakeRoute =>
  (call) => {
    if (call.method === 'POST' && call.path === `/api/games/${GAME}/moves` && onMove) return onMove(call);
    if (call.method === 'POST' && call.path === `/api/games/${GAME}/moves`) return { status: 200, body: afterPlies(1) };
    if (call.method === 'GET' && call.path === `/api/games/${GAME}`) return { status: 200, body: initial };
    if (call.method === 'POST' && /\/(draw\/\w+|resign|abort)$/.test(call.path)) return { status: 200, body: initial };
    return { status: 200, body: { ok: true } };
  };

const wantPrefs = { confirmMoves: false, closeAfterMove: false };

function mount(initial: ReturnType<typeof gameDto>, route: FakeRoute = okRoute(initial), version = '8.0') {
  const r = renderApp(
    (app) => {
      app.prefetched.game = initial;
      return <Game gameId={GAME} />;
    },
    route,
    { version },
  );
  // renderApp resets the preferences; the screen reads them when a move is dropped.
  prefs.value = { ...prefs.value, ...wantPrefs };
  return r;
}

beforeEach(() => {
  adapter = stubAdapter();
  FakeEventSource.reset();
  vi.stubGlobal('EventSource', FakeEventSource);
  wantPrefs.confirmMoves = false;
  wantPrefs.closeAfterMove = false;
});
afterEach(async () => {
  // Preact flushes effects on animation frames; run the faked ones before real timers return,
  // otherwise its effect queue stays scheduled forever and later tests never run their effects.
  if (vi.isFakeTimers()) await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Game', () => {
  it('renders the players, clocks and moves from the launch data and opens the stream', async () => {
    const r = mount(afterPlies(2, { viewerRole: 'black' }));
    await r.flush();
    expect(r.calls).toHaveLength(0);
    expect(FakeEventSource.instances[0]?.url).toBe(`/api/games/${GAME}/events?token=jwt`);
    expect(r.text()).toContain('Alice');
    expect(r.text()).toContain('Bob');
    expect(r.text()).toContain('1d 0:00');
    expect(r.root.querySelectorAll('.move-list [data-ply]')).toHaveLength(2);
    expect(adapter.positions.at(-1)).toMatchObject({ orientation: 'black', lastMove: ['e7', 'e5'] });
    expect(adapter.movables.at(-1)).toMatchObject({ colour: 'none' });
  });

  it('sends a move at once when confirmation is off and applies the response', async () => {
    const r = mount(gameDto());
    await r.flush();
    expect(adapter.movables.at(-1)?.colour).toBe('white');
    adapter.drop('e2', 'e4');
    await r.flush();
    const post = r.calls.find((c) => c.method === 'POST');
    expect(post?.path).toBe(`/api/games/${GAME}/moves`);
    expect(post?.body).toMatchObject({ uci: 'e2e4', expectedPly: 0 });
    expect((post?.body as { clientMoveId: string }).clientMoveId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(r.root.querySelectorAll('.move-list [data-ply]')).toHaveLength(1);
    expect(window.__tg!.haptics).toContain('impact:light');
    expect(window.__tg!.mainButton.visible).toBe(false);
  });

  it('asks for confirmation when the setting is on: cancel restores, confirm sends exactly once', async () => {
    wantPrefs.confirmMoves = true;
    const r = mount(gameDto());
    await r.flush();
    adapter.drop('e2', 'e4');
    await r.flush();
    expect(window.__tg!.mainButton).toMatchObject({ text: 'Confirm', visible: true });
    expect(window.__tg!.secondaryButton).toMatchObject({ text: 'Cancel', visible: true });
    expect(window.__tg!.closingConfirmation).toBe(true);
    const before = adapter.positions.length;
    window.__tg!.clickSecondary();
    await r.flush();
    expect(adapter.positions.length).toBeGreaterThan(before);
    expect(r.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect(window.__tg!.closingConfirmation).toBe(false);
    adapter.drop('e2', 'e4');
    await r.flush();
    window.__tg!.clickMain();
    window.__tg!.clickMain();
    await r.flush();
    expect(r.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('renders an in-page cancel below 7.10', async () => {
    wantPrefs.confirmMoves = true;
    const r = mount(gameDto(), okRoute(gameDto()), '7.0');
    await r.flush();
    adapter.drop('e2', 'e4');
    await r.flush();
    expect(r.root.querySelector('[data-action="cancel-move"]')).not.toBeNull();
    await r.click('[data-action="cancel-move"]');
    expect(r.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('snaps back silently on a stale rejection and reloads the state', async () => {
    const r = mount(
      gameDto(),
      okRoute(afterPlies(1, { viewerRole: 'white' }), () => ({
        status: 409,
        body: { error: { code: 'stale_state', message: 'the position has changed' } },
      })),
    );
    await r.flush();
    const before = adapter.positions.length;
    adapter.drop('e2', 'e4');
    await r.flush();
    expect(adapter.positions.length).toBeGreaterThan(before);
    expect(r.calls.map((c) => [c.method, c.path])).toEqual([
      ['POST', `/api/games/${GAME}/moves`],
      ['GET', `/api/games/${GAME}`],
    ]);
    expect(r.text()).not.toContain('position has changed');
    expect(document.querySelector('.toast')).toBeNull();
  });

  it('retries with the same client move id after a network failure', async () => {
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
    await vi.advanceTimersByTimeAsync(100); // effects run on the next (faked) frame
    expect(window.__tg!.mainButton).toMatchObject({ text: 'Retry', visible: true });
    const first = r.calls.find((c) => c.method === 'POST')?.body as { clientMoveId: string };
    await vi.advanceTimersByTimeAsync(1_000);
    const posts = r.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/moves'));
    expect(posts).toHaveLength(2);
    expect((posts[1]?.body as { clientMoveId: string }).clientMoveId).toBe(first.clientMoveId);
    expect(r.calls.some((c) => c.path === '/api/telemetry')).toBe(true);
    await vi.advanceTimersByTimeAsync(100); // effects run on the next (faked) frame
    expect(window.__tg!.mainButton.visible).toBe(false);
  });

  it('closes after a move when launched from a game link and the setting is on', async () => {
    vi.useFakeTimers();
    wantPrefs.closeAfterMove = true;
    const r = mount(gameDto());
    session.value = { ...session.value!, launchedFrom: { kind: 'game', gameId: GAME } };
    await vi.advanceTimersByTimeAsync(100); // effects run on the next (faked) frame
    adapter.drop('e2', 'e4');
    await vi.advanceTimersByTimeAsync(100); // effects run on the next (faked) frame
    expect(window.__tg!.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(300);
    expect(window.__tg!.closed).toBe(true);
    void r;
  });

  it('shows the promotion chooser and sends the chosen piece', async () => {
    const r = mount(gameDto({ fen: '4k3/4P3/8/8/8/8/8/4K3 w - - 0 1', plyCount: 6, version: 6 }));
    await r.flush();
    adapter.drop('e7', 'e8');
    await r.flush();
    expect(r.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect(r.root.querySelector('.promotion')).not.toBeNull();
    await r.click('[data-promote="n"]');
    expect(r.calls.find((c) => c.method === 'POST')?.body).toMatchObject({ uci: 'e7e8n', expectedPly: 6 });
  });

  it('offers, accepts and declines draws and shows the opponent’s offer', async () => {
    const r = mount(afterPlies(2, { viewerRole: 'white' }));
    await r.flush();
    await r.click('[data-action="offer-draw"]');
    expect(r.calls.at(-1)?.path).toBe(`/api/games/${GAME}/draw/offer`);
    FakeEventSource.instances[0]!.send('state', afterPlies(2, { viewerRole: 'white', version: 3, drawOffer: { by: 'black', atPly: 2 } }), '3');
    await r.flush();
    expect(r.text()).toContain('Bob offers a draw');
    await r.click('[data-action="accept-draw"]');
    expect(r.calls.at(-1)?.path).toBe(`/api/games/${GAME}/draw/accept`);
    await r.click('[data-action="decline-draw"]');
    expect(r.calls.at(-1)?.path).toBe(`/api/games/${GAME}/draw/decline`);
  });

  it('shows the result, rematch, analysis and PGN for a finished game, with the PGN link fallback', async () => {
    const finished = afterPlies(4, {
      viewerRole: 'black',
      status: 'finished',
      result: '0-1',
      endReason: 'checkmate',
      lichessUrl: 'https://lichess.org/abcd1234',
      black: { ...gameDto().black, ratingAfter: 1662, provisionalAfter: true },
    });
    const r = mount(finished, okRoute(finished), '7.0');
    await r.flush();
    expect(r.text()).toContain('You won');
    expect(r.text()).toContain('You won · Checkmate');
    expect(r.text()).toContain('1500? → 1662?');
    expect(FakeEventSource.instances).toHaveLength(0);
    await r.click('[data-action="analyse"]');
    expect(window.__tg!.links).toContain('https://lichess.org/abcd1234');
    await r.click('[data-action="pgn"]');
    expect(window.__tg!.links.at(-1)).toContain(`/api/games/${GAME}/pgn?token=jwt`);
    expect(window.__tg!.downloads).toEqual([]);
    await r.click('[data-action="rematch"]');
    expect(r.calls.at(-1)?.path).toBe(`/api/games/${GAME}/rematch`);
    await r.click('[data-ply="2"]');
    expect(adapter.positions.at(-1)?.lastMove).toEqual(['e7', 'e5']);
    await r.click('[data-action="latest"]');
    expect(adapter.positions.at(-1)?.lastMove).toEqual(['d8', 'h4']);
  });

  it('lets spectators flip and share the viewed position', async () => {
    const r = mount(afterPlies(3, { viewerRole: 'spectator' }));
    await r.flush();
    expect(adapter.viewOnly).toBe(true);
    await r.click('[data-action="flip"]');
    expect(adapter.positions.at(-1)?.orientation).toBe('black');
    await r.click('[data-ply="1"]');
    await r.click('[data-action="share"]');
    expect(r.calls.at(-1)).toMatchObject({ method: 'POST', path: `/api/games/${GAME}/share`, body: { ply: 1 } });
    expect(document.querySelector('.toast')?.textContent).toBe('Shared to the group');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run --project miniapp`
Expected: FAIL — cannot resolve `../src/board/adapter`, `../src/board/promotion`, `../src/ui/game/result`; the game tests fail on the placeholder screen.

- [ ] **Step 3: Write the adapter, the promotion helpers and the game screen**

`apps/miniapp/src/board/adapter.ts`:

```ts
import type { Colour } from '@group-chess/shared';
import { Chessground } from 'chessground';
import type { Api } from 'chessground/api';
import type { Config } from 'chessground/config';
import type { Dests, Key } from 'chessground/types';

export type BoardPosition = {
  fen: string;
  lastMove: [string, string] | null;
  check: boolean;
  orientation: Colour;
  turnColour: Colour;
};

export type Movable = { colour: Colour | 'none'; dests: Map<string, string[]> };

export type MoveHandler = (orig: string, dest: string, meta: { captured: boolean }) => void;

/** Spec §6.3: the seam around chessground; nothing else imports it. */
export interface BoardAdapter {
  setPosition(position: BoardPosition): void;
  setMovable(movable: Movable): void;
  setViewOnly(viewOnly: boolean): void;
  onMove(handler: MoveHandler): void;
  flip(): void;
  /** Snaps a lifted or dropped piece back; the next `setPosition` restores the board. */
  cancelMove(): void;
  destroy(): void;
}

function toDests(dests: Map<string, string[]>): Dests {
  const out: Dests = new Map();
  for (const [from, targets] of dests) out.set(from as Key, targets as Key[]);
  return out;
}

/** The full chessground configuration for a position; pure, so it can be unit-tested. */
export function boardConfig(
  position: BoardPosition,
  movable: Movable,
  viewOnly: boolean,
  onMove: MoveHandler,
): Config {
  return {
    fen: position.fen,
    orientation: position.orientation,
    turnColor: position.turnColour,
    lastMove: position.lastMove ? (position.lastMove as [Key, Key]) : undefined,
    check: position.check,
    coordinates: true,
    viewOnly,
    disableContextMenu: true,
    blockTouchScroll: true,
    highlight: { lastMove: true, check: true },
    animation: { enabled: true, duration: 150 },
    movable: {
      free: false,
      // chessground lifts nothing when the colour is undefined; 'none' is our explicit name for it.
      color: movable.colour === 'none' ? undefined : movable.colour,
      dests: toDests(movable.dests),
      showDests: true,
      events: {
        after: (orig, dest, metadata) => onMove(orig, dest, { captured: metadata.captured !== undefined }),
      },
    },
    premovable: { enabled: false },
    predroppable: { enabled: false },
    draggable: { enabled: true, showGhost: true },
    selectable: { enabled: true },
    drawable: { enabled: false },
  };
}

class ChessgroundAdapter implements BoardAdapter {
  private readonly api: Api;
  private handler: MoveHandler = () => undefined;
  private position: BoardPosition;
  private movable: Movable = { colour: 'none', dests: new Map() };
  private viewOnly: boolean;

  constructor(element: HTMLElement, position: BoardPosition, viewOnly: boolean) {
    this.position = position;
    this.viewOnly = viewOnly;
    this.api = Chessground(element, this.config());
  }

  private config(): Config {
    return boardConfig(this.position, this.movable, this.viewOnly, (orig, dest, meta) =>
      this.handler(orig, dest, meta),
    );
  }

  setPosition(position: BoardPosition): void {
    this.position = position;
    // chessground drops `movable.dests` after a user move; a restored position brings them back.
    this.api.set({
      fen: position.fen,
      orientation: position.orientation,
      turnColor: position.turnColour,
      lastMove: position.lastMove ? (position.lastMove as [Key, Key]) : undefined,
      check: position.check,
      movable: {
        color: this.movable.colour === 'none' ? undefined : this.movable.colour,
        dests: toDests(this.movable.dests),
      },
    });
  }

  setMovable(movable: Movable): void {
    this.movable = movable;
    this.api.set({
      movable: { color: movable.colour === 'none' ? undefined : movable.colour, dests: toDests(movable.dests) },
    });
  }

  setViewOnly(viewOnly: boolean): void {
    this.viewOnly = viewOnly;
    this.api.set({ viewOnly });
  }

  onMove(handler: MoveHandler): void {
    this.handler = handler;
  }

  flip(): void {
    this.api.toggleOrientation();
  }

  cancelMove(): void {
    this.api.cancelMove();
  }

  destroy(): void {
    this.api.destroy();
  }
}

export function createBoardAdapter(
  element: HTMLElement,
  position: BoardPosition,
  options: { viewOnly?: boolean } = {},
): BoardAdapter {
  return new ChessgroundAdapter(element, position, options.viewOnly ?? false);
}
```

`apps/miniapp/src/board/promotion.ts`:

```ts
import type { Colour } from '@group-chess/shared';
import { Chess } from 'chess.js';

export type PromotionPiece = 'q' | 'r' | 'b' | 'n';

const FILES = 'abcdefgh';

/** A pawn moving to the last rank must name its piece (spec §7.2: promotion is mandatory). */
export function isPromotion(fen: string, orig: string, dest: string): boolean {
  let piece: { type: string; color: string } | undefined;
  try {
    piece = new Chess(fen).get(orig as 'a1') ?? undefined;
  } catch {
    return false;
  }
  if (!piece || piece.type !== 'p') return false;
  const rank = dest[1];
  return (piece.color === 'w' && rank === '8') || (piece.color === 'b' && rank === '1');
}

export function promotionPieces(): PromotionPiece[] {
  return ['q', 'r', 'b', 'n'];
}

/** Where the chooser sits: over the target square, growing towards the middle of the board. */
export function promotionOverlayStyle(dest: string, orientation: Colour): { left: string; top: string } {
  const file = FILES.indexOf(dest[0] ?? 'a');
  const rank = Number(dest[1] ?? '1');
  const column = orientation === 'white' ? file : 7 - file;
  const row = orientation === 'white' ? 8 - rank : rank - 1;
  return { left: `${column * 12.5}%`, top: `${row * 12.5}%` };
}
```

`apps/miniapp/src/ui/game/result.ts`:

```ts
import { endReasonLabel, ratingLabel, t, type GameDto } from '@group-chess/shared';

/** The result banner text from the viewer's side (PRD §8.2). */
export function resultForViewer(dto: GameDto): string {
  if (!dto.result || dto.result === '*') return t('app.game.result.aborted');
  if (dto.result === '1/2-1/2') return t('app.game.result.draw');
  const winner = dto.result === '1-0' ? 'white' : 'black';
  if (dto.viewerRole === 'spectator') return t(`app.game.result.${winner}`);
  return t(dto.viewerRole === winner ? 'app.game.result.win' : 'app.game.result.loss');
}

export function reasonForViewer(dto: GameDto): string | null {
  return dto.endReason ? endReasonLabel(dto.endReason) : null;
}

/** `1500? → 1662?` for the viewer of a finished rated game; null otherwise. */
export function ratingChangeFor(dto: GameDto): string | null {
  if (dto.status !== 'finished' || !dto.rated || dto.voided) return null;
  if (dto.viewerRole !== 'white' && dto.viewerRole !== 'black') return null;
  const player = dto[dto.viewerRole];
  if (player.ratingAfter === null || player.provisionalAfter === null) return null;
  return `${ratingLabel(player.rating, player.provisional)} → ${ratingLabel(player.ratingAfter, player.provisionalAfter)}`;
}
```

`apps/miniapp/src/ui/game/useClock.ts`:

```ts
import { useEffect, useState } from 'preact/hooks';
import { serverNow } from '../../state/session';
import type { GameStore } from '../../state/game';

/** A once-a-second `now` on the server's clock while the game is running (spec §6.4). */
export function useClock(store: GameStore): Date {
  const [now, setNow] = useState(() => serverNow());
  const active = store.dto.value.status === 'active';
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(serverNow()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}
```

`apps/miniapp/src/ui/game/PlayerBar.tsx`:

```tsx
import { ratingLabel, type Colour, type GameDto } from '@group-chess/shared';
import { clockLabel, isUrgent, remainingMs } from '../../state/clock';

export function PlayerBar(props: { dto: GameDto; colour: Colour; now: Date }) {
  const { dto, colour } = props;
  const player = dto[colour];
  const toMove = dto.status === 'active' && (dto.fen.split(' ')[1] === 'b' ? 'black' : 'white') === colour;
  const remaining = toMove ? remainingMs(dto.deadlineAt, props.now) : null;
  const rating = ratingLabel(player.rating, player.provisional);
  const after =
    dto.status === 'finished' && player.ratingAfter !== null && player.provisionalAfter !== null
      ? ` → ${ratingLabel(player.ratingAfter, player.provisionalAfter)}`
      : '';
  return (
    <div class="player-bar" data-colour={colour}>
      <span class="name">
        {player.name}
        <span class="rating">
          {rating}
          {after}
        </span>
      </span>
      {dto.status === 'active' ? (
        <span class={`clock ${toMove ? 'active' : ''} ${toMove && isUrgent(remaining, dto.timePerMove) ? 'urgent' : ''}`}>
          {clockLabel(remaining, dto.timePerMove, toMove)}
        </span>
      ) : null}
    </div>
  );
}
```

`apps/miniapp/src/ui/game/MoveList.tsx`:

```tsx
import { t } from '@group-chess/shared';
import type { GameStore } from '../../state/game';

export function MoveList(props: { store: GameStore }) {
  const { store } = props;
  const moves = store.dto.value.moves;
  const viewing = store.position.value.ply;
  if (moves.length === 0) return <p class="move-list hint">{t('app.game.no_moves')}</p>;
  return (
    <div class="move-list">
      {moves.map((move) => (
        <>
          {move.ply % 2 === 1 ? <span class="number">{Math.ceil(move.ply / 2)}.</span> : null}
          <button
            key={move.ply}
            data-ply={move.ply}
            aria-current={viewing === move.ply ? 'true' : 'false'}
            onClick={() => store.viewPly(move.ply)}
          >
            {move.san}
          </button>
        </>
      ))}
      {!store.isLatest.value ? (
        <button class="badge" data-action="latest" onClick={() => store.viewPly(null)}>
          {t('app.game.latest')}
        </button>
      ) : null}
    </div>
  );
}
```

`apps/miniapp/src/ui/game/Board.tsx`:

```tsx
import { effect } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import { createBoardAdapter, type BoardAdapter, type MoveHandler } from '../../board/adapter';
import type { GameStore } from '../../state/game';

/** Mounts the adapter once and pushes position, movable set and view-only flag from the store. */
export function Board(props: {
  store: GameStore;
  onMove: MoveHandler;
  onReady: (adapter: BoardAdapter) => void;
  children?: preact.ComponentChildren;
}) {
  const element = useRef<HTMLDivElement>(null);
  const onMoveRef = useRef(props.onMove);
  onMoveRef.current = props.onMove;
  const { store } = props;
  useEffect(() => {
    const spectator = store.dto.value.viewerRole === 'spectator';
    const adapter = createBoardAdapter(
      element.current!,
      { ...store.position.value, orientation: store.orientation.value, turnColour: store.sideToMove.value },
      { viewOnly: spectator },
    );
    adapter.onMove((orig, dest, meta) => onMoveRef.current(orig, dest, meta));
    props.onReady(adapter);
    const disposers = [
      effect(() =>
        adapter.setPosition({
          ...store.position.value,
          orientation: store.orientation.value,
          turnColour: store.sideToMove.value,
        }),
      ),
      effect(() =>
        adapter.setMovable({
          colour: store.canMove.value ? (store.dto.value.viewerRole as 'white' | 'black') : 'none',
          dests: store.dests.value,
        }),
      ),
      effect(() => adapter.setViewOnly(store.dto.value.viewerRole === 'spectator')),
    ];
    return () => {
      for (const dispose of disposers) dispose();
      adapter.destroy();
    };
  }, [store]);
  return (
    <div class="board-wrap">
      <div ref={element} />
      {props.children}
    </div>
  );
}
```

`apps/miniapp/src/ui/game/GameView.tsx`:

```tsx
import { GameDtoSchema, t, type Colour, type GameDto } from '@group-chess/shared';
import { h } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ApiError } from '../../api/client';
import { GameStream } from '../../api/stream';
import type { BoardAdapter } from '../../board/adapter';
import { isPromotion, promotionOverlayStyle, promotionPieces, type PromotionPiece } from '../../board/promotion';
import { diffNotices, GameStore, type Notice } from '../../state/game';
import { reduceMove, type MoveEffect, type MoveEvent, type MoveState } from '../../state/moveMachine';
import { noteServerTime, prefs, session } from '../../state/session';
import { useApp } from '../context';
import { confirmDialog } from '../dialog';
import { toast } from '../toast';
import { Board } from './Board';
import { MoveList } from './MoveList';
import { PlayerBar } from './PlayerBar';
import { ratingChangeFor, reasonForViewer, resultForViewer } from './result';
import { useClock } from './useClock';

const PIECE_CLASS: Record<PromotionPiece, string> = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight' };

export function GameView(props: { initial: GameDto; onReload: () => Promise<GameDto> }) {
  const { client, tg, router } = useApp();
  const store = useMemo(() => new GameStore(props.initial), [props.initial.id]);
  const adapterRef = useRef<BoardAdapter | null>(null);
  const moveRef = useRef<MoveState>({ kind: 'idle' });
  const [moveState, setMoveState] = useState<MoveState>({ kind: 'idle' });
  const [promotion, setPromotion] = useState<{ orig: string; dest: string } | null>(null);
  const [inPageCancel, setInPageCancel] = useState(false);
  const now = useClock(store);
  const dto = store.dto.value;
  const gameId = dto.id;
  const isPlayer = dto.viewerRole === 'white' || dto.viewerRole === 'black';

  const notify = useCallback(
    (notice: Notice) => {
      if (notice === 'opponent_moved' || notice === 'draw_offered') tg.haptic('light');
      if (notice === 'draw_declined') toast(t('app.game.draw_declined'));
      if (notice === 'finished') tg.hapticNotify('success');
    },
    [tg],
  );
  const applyState = useCallback(
    (next: GameDto) => {
      const previous = store.dto.value;
      noteServerTime(next.serverTime);
      if (store.apply(next)) for (const notice of diffNotices(previous, next)) notify(notice);
    },
    [store, notify],
  );

  // Live updates for running games (spec §6.4); finished games are static.
  useEffect(() => {
    if (dto.status !== 'active') return;
    const stream = new GameStream({
      url: client.url(`/api/games/${gameId}/events`, { token: client.token ?? '' }),
      refresh: () => client.get(`/api/games/${gameId}`, GameDtoSchema),
      onState: applyState,
      onFailure: () => void client.post('/api/telemetry', { events: [{ kind: 'sse_failed' }] }).catch(() => undefined),
    });
    stream.start();
    return () => stream.stop();
  }, [client, gameId, dto.status, applyState]);

  const restore = useCallback(() => {
    adapterRef.current?.cancelMove();
    const position = store.position.value;
    adapterRef.current?.setPosition({ ...position, orientation: store.orientation.value, turnColour: store.sideToMove.value });
  }, [store]);

  const dispatch = useCallback(
    (event: MoveEvent) => {
      const { state, effects } = reduceMove(moveRef.current, event, { confirmMoves: prefs.value.confirmMoves });
      moveRef.current = state;
      setMoveState(state);
      for (const effect of effects) runEffect(effect);
    },
    [],
  );

  const runEffect = (effect: MoveEffect): void => {
    switch (effect.type) {
      case 'send': {
        void client
          .post(`/api/games/${gameId}/moves`, effect.move, GameDtoSchema)
          .then((next) => {
            applyState(next);
            dispatch({ type: 'sent' });
            tg.haptic('light');
            afterSent();
          })
          .catch((error: unknown) => {
            if (error instanceof ApiError && error.isNetwork) dispatch({ type: 'networkError', now: Date.now() });
            else dispatch({ type: 'rejected' });
          });
        return;
      }
      case 'restore':
        restore();
        return;
      case 'reload':
        void props.onReload().then(applyState).catch(() => undefined);
        return;
      case 'closingConfirmation':
        tg.closingConfirmation(effect.on);
        return;
      case 'telemetryRetry':
        void client.post('/api/telemetry', { events: [{ kind: 'move_retry' }] }).catch(() => undefined);
        return;
    }
  };

  const afterSent = (): void => {
    if (prefs.value.closeAfterMove && session.value?.launchedFrom?.kind === 'game') {
      toast(t('app.game.sent'), 300);
      setTimeout(() => tg.close(), 300);
    }
  };

  // Retry timer: wake the machine when the backoff elapses.
  useEffect(() => {
    if (moveState.kind !== 'retry') return;
    const timer = setTimeout(() => dispatch({ type: 'tick', now: Date.now() }), Math.max(0, moveState.nextAt - Date.now()));
    return () => clearTimeout(timer);
  }, [moveState, dispatch]);

  // Telegram buttons per machine state (spec §6.3).
  useEffect(() => {
    switch (moveState.kind) {
      case 'pendingConfirm': {
        tg.setMainButton({ text: t('app.game.confirm'), onClick: () => dispatch({ type: 'confirm' }) });
        const bound = tg.setSecondaryButton({ text: t('app.game.cancel'), onClick: () => dispatch({ type: 'cancel' }) });
        setInPageCancel(!bound);
        return;
      }
      case 'sending':
        tg.setMainButton({ text: t('app.game.sending'), onClick: () => undefined, progress: true });
        tg.setSecondaryButton(null);
        setInPageCancel(false);
        return;
      case 'retry':
        tg.setMainButton({ text: t('app.game.retry'), onClick: () => dispatch({ type: 'retryNow' }) });
        tg.setSecondaryButton(null);
        setInPageCancel(false);
        return;
      case 'idle':
        tg.setMainButton(null);
        tg.setSecondaryButton(null);
        setInPageCancel(false);
        return;
    }
  }, [moveState.kind, tg, dispatch]);
  useEffect(
    () => () => {
      tg.setMainButton(null);
      tg.setSecondaryButton(null);
      tg.closingConfirmation(false);
    },
    [tg],
  );

  const onDrop = (orig: string, dest: string, meta: { captured: boolean }): void => {
    if (moveRef.current.kind !== 'idle') {
      restore();
      return;
    }
    tg.haptic(meta.captured ? 'medium' : 'light');
    if (isPromotion(store.dto.value.fen, orig, dest)) {
      setPromotion({ orig, dest });
      return;
    }
    dispatch({ type: 'drop', uci: `${orig}${dest}`, expectedPly: store.dto.value.plyCount });
  };
  const promote = (piece: PromotionPiece | null): void => {
    const pending = promotion;
    setPromotion(null);
    if (!pending) return;
    if (!piece) {
      restore();
      return;
    }
    dispatch({ type: 'drop', uci: `${pending.orig}${pending.dest}${piece}`, expectedPly: store.dto.value.plyCount });
  };

  const action = async (path: string, body: unknown = {}): Promise<void> => {
    try {
      applyState(await client.post(`/api/games/${gameId}/${path}`, body, GameDtoSchema));
    } catch (error) {
      if (error instanceof ApiError && error.isNetwork) toast(t('app.common.offline'));
      else void props.onReload().then(applyState).catch(() => undefined);
    }
  };
  const share = async (): Promise<void> => {
    try {
      await client.post(`/api/games/${gameId}/share`, { ply: store.position.value.ply });
      toast(t('app.game.shared'));
    } catch (error) {
      toast(error instanceof ApiError && error.code === 'rate_limited' ? t('app.game.share_limit') : t('app.common.error'));
    }
  };
  const resign = async (): Promise<void> => {
    if (await confirmDialog(t('app.game.resign_confirm'), { confirmLabel: t('app.game.resign'), danger: true })) await action('resign');
  };
  const abort = async (): Promise<void> => {
    if (await confirmDialog(t('app.game.abort_confirm'), { confirmLabel: t('app.game.abort'), danger: true })) await action('abort');
  };
  const rematch = async (): Promise<void> => {
    try {
      await client.post(`/api/games/${gameId}/rematch`, {});
      toast(t('app.game.rematch_sent'));
      router.replace({ name: 'lobby', groupId: dto.group.id });
    } catch {
      toast(t('app.common.error'));
    }
  };
  const analyse = (): void => {
    const url = dto.lichessUrl ?? dto.analysisUrl;
    if (url) tg.openLink(url);
  };
  const pgn = (): void => {
    const url = new URL(client.url(`/api/games/${gameId}/pgn`, { token: client.token ?? '' }), window.location.origin).toString();
    if (!tg.downloadFile(url, `${gameId}.pgn`)) tg.openLink(url);
  };

  const orientation = store.orientation.value;
  const top: Colour = orientation === 'white' ? 'black' : 'white';
  const offer = dto.drawOffer;
  const myColour = isPlayer ? (dto.viewerRole as Colour) : null;
  const canOffer = isPlayer && dto.status === 'active' && !offer;
  const offerFromOpponent = isPlayer && offer !== null && offer.by !== myColour;
  const claimable = isPlayer && dto.status === 'active' && (dto.claims.threefold || dto.claims.fiftyMove);
  const busy = moveState.kind !== 'idle';

  return (
    <div class="game">
      <PlayerBar dto={dto} colour={top} now={now} />
      <Board store={store} onMove={onDrop} onReady={(adapter) => (adapterRef.current = adapter)}>
        {promotion ? (
          <div class="promotion" style={promotionOverlayStyle(promotion.dest, orientation)} role="dialog" aria-label={t('app.game.promotion')}>
            {promotionPieces().map((piece) => (
              <button
                key={piece}
                data-promote={piece}
                class={`cg-wrap ${PIECE_CLASS[piece]} ${dto.viewerRole === 'black' ? 'black' : 'white'}`}
                onClick={() => promote(piece)}
              >
                {h('piece', { class: `${PIECE_CLASS[piece]} ${dto.viewerRole === 'black' ? 'black' : 'white'}` })}
              </button>
            ))}
            <button data-promote="cancel" onClick={() => promote(null)}>
              ✕
            </button>
          </div>
        ) : null}
      </Board>
      <PlayerBar dto={dto} colour={orientation} now={now} />
      <MoveList store={store} />
      {dto.status === 'finished' ? (
        <div class="replay-controls">
          <button class="btn secondary" data-action="prev" onClick={() => store.viewPly(store.position.value.ply - 1)}>
            ◀
          </button>
          <input
            type="range"
            min={0}
            max={dto.plyCount}
            value={store.position.value.ply}
            onInput={(event) => store.viewPly(Number(event.currentTarget.value))}
          />
          <button class="btn secondary" data-action="next" onClick={() => store.viewPly(store.position.value.ply + 1)}>
            ▶
          </button>
        </div>
      ) : null}
      {dto.status === 'finished' ? (
        <div class="banner result">
          <span class="grow">
            {dto.voided ? t('app.game.voided') : resultForViewer(dto)}
            {reasonForViewer(dto) ? ` · ${reasonForViewer(dto)}` : ''}
            {ratingChangeFor(dto) ? ` · ${ratingChangeFor(dto)}` : ''}
          </span>
        </div>
      ) : null}
      {offerFromOpponent && dto.status === 'active' ? (
        <div class="banner">
          <span class="grow">{t('app.game.draw_offer_from', { name: dto[offer!.by].name })}</span>
          <button class="btn" data-action="accept-draw" onClick={() => void action('draw/accept')}>
            {t('button.accept')}
          </button>
          <button class="btn secondary" data-action="decline-draw" onClick={() => void action('draw/decline')}>
            {t('button.decline')}
          </button>
        </div>
      ) : null}
      {isPlayer && offer && offer.by === myColour && dto.status === 'active' ? (
        <div class="banner">{t('app.game.draw_offered')}</div>
      ) : null}
      {inPageCancel && moveState.kind === 'pendingConfirm' ? (
        <div class="inline-main">
          <button class="btn secondary block" data-action="cancel-move" onClick={() => dispatch({ type: 'cancel' })}>
            {t('app.game.cancel')}
          </button>
        </div>
      ) : null}
      <div class="toolbar">
        <button class="btn secondary" data-action="share" onClick={() => void share()}>
          {t('app.game.share')}
        </button>
        {dto.status === 'active' && canOffer ? (
          <button class="btn secondary" data-action="offer-draw" disabled={busy} onClick={() => void action('draw/offer')}>
            {t('app.game.offer_draw')}
          </button>
        ) : null}
        {claimable ? (
          <button class="btn secondary" data-action="claim-draw" disabled={busy} onClick={() => void action('draw/claim')}>
            {t('app.game.claim_draw')}
          </button>
        ) : null}
        {isPlayer && dto.status === 'active' && dto.plyCount < 2 ? (
          <button class="btn danger" data-action="abort" disabled={busy} onClick={() => void abort()}>
            {t('app.game.abort')}
          </button>
        ) : null}
        {isPlayer && dto.status === 'active' ? (
          <button class="btn danger" data-action="resign" disabled={busy} onClick={() => void resign()}>
            {t('app.game.resign')}
          </button>
        ) : null}
        {!isPlayer ? (
          <button class="btn secondary" data-action="flip" onClick={() => store.flip()}>
            {t('app.game.flip')}
          </button>
        ) : null}
        {dto.status === 'finished' && isPlayer && !dto.voided ? (
          <button class="btn" data-action="rematch" onClick={() => void rematch()}>
            {t('app.game.rematch')}
          </button>
        ) : null}
        {dto.status === 'finished' && (dto.lichessUrl || dto.analysisUrl) ? (
          <button class="btn secondary" data-action="analyse" onClick={analyse}>
            {t('app.game.analyse')}
          </button>
        ) : null}
        {dto.status === 'finished' ? (
          <button class="btn secondary" data-action="pgn" onClick={pgn}>
            {t('app.game.pgn')}
          </button>
        ) : null}
        {dto.status === 'finished' && session.value?.launchedFrom?.kind === 'game' ? (
          <button class="btn secondary" data-action="done" onClick={() => tg.close()}>
            {t('app.game.done')}
          </button>
        ) : null}
      </div>
    </div>
  );
}
```

Replace `apps/miniapp/src/ui/screens/Game.tsx` with:

```tsx
import { GameDtoSchema } from '@group-chess/shared';
import { useApp } from '../context';
import { GameView } from '../game/GameView';
import { useResource } from '../hooks';
import { ErrorScreen, Loading } from './Status';

export function Game(props: { gameId: string }) {
  const { client, prefetched } = useApp();
  const initial = prefetched.game?.id === props.gameId ? prefetched.game : undefined;
  if (initial) delete prefetched.game;
  const load = () => client.get(`/api/games/${props.gameId}`, GameDtoSchema);
  const game = useResource(`game:${props.gameId}`, load, initial);
  if (game.error) return <ErrorScreen onRetry={() => void game.reload()} />;
  if (!game.data) return <Loading />;
  return <GameView initial={game.data} onReload={load} />;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run --project miniapp`
Expected: PASS — 75 tests (59 before, board 5, game 11).

- [ ] **Step 5: Build, run the whole suite and the static checks**

Run: `pnpm --filter @group-chess/miniapp build && pnpm test && pnpm typecheck && pnpm lint && pnpm format:check`
Expected: all exit 0; the build reports the JS asset under 120 KB gzipped.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(miniapp): add the board adapter and the game screen with live updates, replay and controls"
```

---

### Task 6: End-to-end harness and Playwright suite, bundle budget, CSP and the PGN token

**Files:**
- Create: `apps/server/test/e2e/harness.ts`, `apps/miniapp/playwright.config.ts`, `apps/miniapp/e2e/support.ts`, `apps/miniapp/e2e/move.spec.ts`, `apps/miniapp/e2e/spectator.spec.ts`, `apps/miniapp/e2e/promotion.spec.ts`, `apps/miniapp/e2e/replay.spec.ts`, `apps/miniapp/e2e/live.spec.ts`, `apps/miniapp/e2e/fallbacks.spec.ts`, `apps/miniapp/e2e/lobby.spec.ts`, `scripts/check-bundle-size.mjs`
- Modify: `apps/server/src/api/staticApp.ts` (CSP header on HTML), `apps/server/src/api/middleware.ts` (`?token=` also for `/pgn`), `apps/server/test/unit/staticApp.test.ts`, `apps/server/test/integration/api-games.test.ts`, `.gitignore` (Playwright output), `apps/server/vitest.config.ts` (exclude `test/e2e`)
- Test: the Playwright suite itself; two server tests for the modified behaviour.

**Interfaces:**
- Consumes: plan 03 `startServer`, `FakeTelegram`, fixtures, `signInitData`; Task 1 `installFakeWebApp`; the built Mini App.
- Produces: the harness (`E2E_APP_PORT` 4180, harness API on 4181: `GET /health`, `POST /reset`, `POST /seed`, `GET /games/:publicId`, `GET /telegram/calls`); e2e helpers `seed`, `openApp`, `boardBox`, `dragMove`, `tapMove`, `tgState`, `clickMain`, `clickSecondary`, `harnessGame`, `telegramCalls`; `scripts/check-bundle-size.mjs` (JS ≤ 120 KB gz, CSS ≤ 25 KB gz).

**Rulings recorded in this task:**
- The e2e backend is the real server on a fake Bot API, seeded through a harness endpoint that exists only in the test process. Cost if wrong: one extra process in the Playwright `webServer`.
- Playwright 1.63 drives this environment's pre-installed Chromium through `PLAYWRIGHT_CHROMIUM_PATH`; CI installs the matching browser instead. Cost if wrong: one environment variable.
- The PGN download takes `?token=` like the SSE route because `downloadFile` and `openLink` cannot send headers (spec §9 already accepts this for `/events`). Cost if wrong: a signed one-time download URL later.

- [ ] **Step 1: Server changes with their tests (RED then GREEN)**

Add to `apps/server/test/unit/staticApp.test.ts` inside `describe('staticAppRoutes')`:

```ts
  it('sets the content security policy on the app HTML only', async () => {
    const index = await app.request('/app/');
    expect(index.headers.get('content-security-policy')).toBe(
      "default-src 'self'; script-src 'self' https://telegram.org; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'",
    );
    const asset = await app.request('/app/assets/app-1a2b3c.js');
    expect(asset.headers.get('content-security-policy')).toBeNull();
  });
```

Add to `apps/server/test/integration/api-games.test.ts` inside `describe('games')` (the file already seeds a finished game in another test; this one builds its own):

```ts
  it('serves the PGN with a query token for downloads', async () => {
    const { group, alice, bob, tokens } = await world();
    const game = await insertGame(db, group.id, alice.id, bob.id, {
      status: 'finished',
      result: '1-0',
      endReason: 'resignation',
      finishedAt: new Date(),
    });
    const res = await api.request('GET', `/api/games/${game.publicId}/pgn?token=${tokens.carol}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('[Result "1-0"]');
    expect((await api.request('GET', `/api/games/${game.publicId}/pgn`)).status).toBe(401);
  });
```

Run: `pnpm vitest run --project server apps/server/test/unit/staticApp.test.ts apps/server/test/integration/api-games.test.ts`
Expected: FAIL — the two new tests.

In `apps/server/src/api/staticApp.ts` add after the `IMMUTABLE`/`SHORT` constants:

```ts
/** Spec §12: no third-party scripts, fonts or analytics; chessground needs inline styles. */
export const APP_CSP =
  "default-src 'self'; script-src 'self' https://telegram.org; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'";
```

and in the handler, replace `c.header('Cache-Control', cache);` with:

```ts
    c.header('Cache-Control', cache);
    if (type === TYPES['.html']) c.header('Content-Security-Policy', APP_CSP);
```

In `apps/server/src/api/middleware.ts` change the query-token line to:

```ts
    const tokenInQuery = /\/(events|pgn)$/.test(c.req.path);
    const queryToken = tokenInQuery ? (c.req.query('token') ?? null) : null;
```

In `apps/server/vitest.config.ts` add `exclude: ['test/e2e/**']` next to `include` (the harness is a script, not a test).

Run the two files again: PASS.

- [ ] **Step 2: The harness**

`apps/server/test/e2e/harness.ts`:

```ts
/**
 * The end-to-end backend: the real server on a fake Bot API, plus a small seeding API that exists
 * only in this process. Started by Playwright's `webServer` (apps/miniapp/playwright.config.ts).
 */
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { INITIAL_FEN } from '@group-chess/shared';
import { eq } from 'drizzle-orm';
import { games, users } from '../../src/db/schema';
import { runMigrations } from '../../src/db/migrate';
import { touchMember } from '../../src/domain/members';
import { startServer } from '../../src/main';
import { testConfig } from '../helpers/config';
import { openTestDb, truncateAll } from '../helpers/db';
import { FakeTelegram } from '../helpers/fakeTelegram';
import { insertGame, insertGroup, insertMove, insertUser } from '../helpers/fixtures';

const APP_PORT = Number(process.env.E2E_APP_PORT ?? 4180);
const HARNESS_PORT = Number(process.env.E2E_HARNESS_PORT ?? 4181);
const MINI_APP_DIR = fileURLToPath(new URL('../../../miniapp/dist/', import.meta.url));
const CHAT = -1001000000099;

const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
const AFTER_E4_E5 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2';
const FOOLS_MATE = [
  ['f2f3', 'f3', 'rnbqkbnr/pppppppp/8/8/8/5P2/PPPPP1PP/RNBQKBNR b KQkq - 0 1'],
  ['e7e5', 'e5', 'rnbqkbnr/pppp1ppp/8/4p3/8/5P2/PPPPP1PP/RNBQKBNR w KQkq e6 0 2'],
  ['g2g4', 'g4', 'rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq g3 0 2'],
  ['d8h4', 'Qh4#', 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3'],
] as const;
/** White pawn on e7, black king on d8: e7e8 promotes with check. */
const PROMOTION_FEN = '3k4/4P3/8/8/8/8/8/4K3 w - - 0 1';

type Scenario = 'none' | 'fresh' | 'opening' | 'promotion' | 'finished';
type SeedRequest = { scenario: Scenario; prefs?: Record<string, Record<string, unknown>> };

const TELEGRAM_USERS = {
  alice: { id: 11, first_name: 'Alice', username: 'alice' },
  bob: { id: 22, first_name: 'Bob', username: 'bob' },
  carol: { id: 33, first_name: 'Carol', username: 'carol' },
} as const;

async function main(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL must be set for the e2e harness');
  await runMigrations(url);
  const { db, close } = openTestDb();
  await truncateAll(db);
  const fake = await FakeTelegram.start();
  for (const user of Object.values(TELEGRAM_USERS)) fake.members.set(user.id, 'member');
  fake.admins = [TELEGRAM_USERS.alice.id];
  const server = await startServer(
    testConfig({
      TELEGRAM_API_ROOT: fake.url,
      PORT: APP_PORT,
      PUBLIC_URL: `http://127.0.0.1:${APP_PORT}`,
      MINI_APP_DIR,
      DATABASE_URL: url,
      LOG_LEVEL: 'warn',
    }),
  );

  const seed = async (request: SeedRequest) => {
    await truncateAll(db);
    fake.reset();
    for (const user of Object.values(TELEGRAM_USERS)) fake.members.set(user.id, 'member');
    fake.admins = [TELEGRAM_USERS.alice.id];
    const group = await insertGroup(db, { telegramChatId: CHAT, title: 'Chess Club', botStatus: 'administrator', botIsAdmin: true });
    const rows: Record<string, { id: number; telegram: (typeof TELEGRAM_USERS)[keyof typeof TELEGRAM_USERS] }> = {};
    for (const [name, telegram] of Object.entries(TELEGRAM_USERS)) {
      const row = await insertUser(db, { telegramUserId: telegram.id, firstName: telegram.first_name, username: telegram.username });
      const patch = request.prefs?.[name];
      if (patch) await db.update(users).set({ prefs: patch }).where(eq(users.id, row.id));
      await touchMember(db, group.id, row.id, { verified: true });
      rows[name] = { id: row.id, telegram };
    }
    const alice = rows.alice!.id;
    const bob = rows.bob!.id;
    let game: { id: number; publicId: string } | null = null;
    if (request.scenario === 'fresh') game = await insertGame(db, group.id, alice, bob, { fen: INITIAL_FEN });
    if (request.scenario === 'opening') {
      const row = await insertGame(db, group.id, alice, bob, { fen: AFTER_E4_E5, plyCount: 2 });
      await insertMove(db, row.id, 1, 'e2e4', 'e4', AFTER_E4);
      await insertMove(db, row.id, 2, 'e7e5', 'e5', AFTER_E4_E5);
      game = row;
    }
    if (request.scenario === 'promotion') game = await insertGame(db, group.id, alice, bob, { fen: PROMOTION_FEN, plyCount: 6 });
    if (request.scenario === 'finished') {
      const row = await insertGame(db, group.id, alice, bob, {
        fen: FOOLS_MATE[3][2],
        plyCount: 4,
        status: 'finished',
        result: '0-1',
        endReason: 'checkmate',
        finishedAt: new Date(),
      });
      for (const [index, [uci, san, fen]] of FOOLS_MATE.entries()) await insertMove(db, row.id, index + 1, uci, san, fen);
      game = row;
    }
    return {
      group: { id: group.id, publicId: group.publicId },
      users: rows,
      game: game ? { id: game.id, publicId: game.publicId } : null,
    };
  };

  const harness = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as SeedRequest) : null;
      const reply = (status: number, json: unknown) => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(json));
      };
      const path = req.url ?? '/';
      void (async () => {
        try {
          if (path === '/health') return reply(200, { ok: true });
          if (path === '/reset') {
            await truncateAll(db);
            fake.reset();
            return reply(200, { ok: true });
          }
          if (path === '/seed' && body) return reply(200, await seed(body));
          if (path === '/telegram/calls') return reply(200, fake.calls);
          const match = /^\/games\/([A-Za-z0-9]{10})$/.exec(path);
          if (match) {
            const [row] = await db.select().from(games).where(eq(games.publicId, match[1]!));
            return reply(row ? 200 : 404, row ? { status: row.status, fen: row.fen, plyCount: row.plyCount, result: row.result } : {});
          }
          reply(404, { error: 'unknown harness route' });
        } catch (error) {
          reply(500, { error: error instanceof Error ? error.message : String(error) });
        }
      })();
    });
  });
  await new Promise<void>((resolve) => harness.listen(HARNESS_PORT, '127.0.0.1', () => resolve()));
  console.log(`e2e harness: app http://127.0.0.1:${APP_PORT}/app/ harness http://127.0.0.1:${HARNESS_PORT}`);

  const shutdown = async (): Promise<void> => {
    await new Promise<void>((resolve) => harness.close(() => resolve()));
    await server.stop();
    await fake.stop();
    await close();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}

void main();
```

- [ ] **Step 3: Playwright configuration and helpers**

`apps/miniapp/playwright.config.ts`:

```ts
import { defineConfig, devices } from '@playwright/test';

const APP = 'http://127.0.0.1:4180';
const HARNESS = 'http://127.0.0.1:4181';

/** Spec §15: Chromium with touch emulation against the server plus the fake WebApp harness. */
export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: 'line',
  use: {
    baseURL: APP,
    ...devices['Pixel 7'],
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined },
  },
  webServer: {
    command: 'pnpm --filter @group-chess/server exec tsx test/e2e/harness.ts',
    url: `${HARNESS}/health`,
    timeout: 90_000,
    reuseExistingServer: !process.env.CI,
  },
});
```

`apps/miniapp/e2e/support.ts`:

```ts
import { expect, type Page } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { installFakeWebApp, type FakeWebAppOptions, type FakeWebAppRecord } from '../test/support/fakeWebApp';

export const BOT_TOKEN = '123456:TEST-TOKEN';
export const HARNESS = 'http://127.0.0.1:4181';

export type TelegramUser = { id: number; first_name: string; username: string };

/** Signs init data the way Telegram does: the same recipe as the server's test helper, kept local so this project stays self-contained. */
export function signInitData(
  botToken: string,
  fields: { user: TelegramUser; startParam?: string },
): string {
  const params = new URLSearchParams();
  params.set('user', JSON.stringify(fields.user));
  params.set('auth_date', String(Math.floor(Date.now() / 1000)));
  if (fields.startParam) params.set('start_param', fields.startParam);
  const dataCheckString = [...params.entries()]
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  params.set('hash', createHmac('sha256', secret).update(dataCheckString).digest('hex'));
  return params.toString();
}
export type Seed = {
  group: { id: number; publicId: string };
  users: Record<'alice' | 'bob' | 'carol', { id: number; telegram: TelegramUser }>;
  game: { id: number; publicId: string } | null;
};

export async function seed(
  scenario: 'none' | 'fresh' | 'opening' | 'promotion' | 'finished',
  prefs: Record<string, Record<string, unknown>> = {},
): Promise<Seed> {
  const response = await fetch(`${HARNESS}/seed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scenario, prefs }),
  });
  if (!response.ok) throw new Error(`seed failed: ${response.status}`);
  return (await response.json()) as Seed;
}

export async function harnessGame(publicId: string): Promise<{ status: string; fen: string; plyCount: number; result: string | null }> {
  return (await (await fetch(`${HARNESS}/games/${publicId}`)).json()) as never;
}

export async function telegramCalls(): Promise<{ method: string; body: Record<string, unknown> }[]> {
  return (await (await fetch(`${HARNESS}/telegram/calls`)).json()) as never;
}

/** Installs the fake WebApp with test-signed init data, stubs Telegram's script and opens the app. */
export async function openApp(
  page: Page,
  options: { user: TelegramUser; startParam?: string; version?: string },
): Promise<void> {
  await page.route('https://telegram.org/js/telegram-web-app.js', (route) =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }),
  );
  const initData = signInitData(BOT_TOKEN, { user: options.user, startParam: options.startParam });
  const fake: FakeWebAppOptions = {
    version: options.version ?? '8.0',
    initData,
    startParam: options.startParam,
    writeAccess: true,
  };
  await page.addInitScript(installFakeWebApp, fake);
  await page.goto('/app/');
}

export async function tgState(page: Page): Promise<Omit<FakeWebAppRecord, 'clickMain' | 'clickSecondary' | 'clickBack' | 'emit' | 'setStableHeight'>> {
  return page.evaluate(() => {
    const record = window.__tg!;
    return {
      calls: record.calls,
      mainButton: record.mainButton,
      secondaryButton: record.secondaryButton,
      backButton: record.backButton,
      haptics: record.haptics,
      links: record.links,
      downloads: record.downloads,
      closed: record.closed,
      closingConfirmation: record.closingConfirmation,
    };
  });
}

export const clickMain = (page: Page) => page.evaluate(() => window.__tg!.clickMain());
export const clickSecondary = (page: Page) => page.evaluate(() => window.__tg!.clickSecondary());

export async function boardBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const board = page.locator('cg-board');
  await expect(board).toBeVisible();
  const box = await board.boundingBox();
  if (!box) throw new Error('board has no box');
  return box;
}

export function squareCentre(
  box: { x: number; y: number; width: number; height: number },
  square: string,
  orientation: 'white' | 'black' = 'white',
): { x: number; y: number } {
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]);
  const column = orientation === 'white' ? file : 7 - file;
  const row = orientation === 'white' ? 8 - rank : rank - 1;
  const size = box.width / 8;
  return { x: box.x + column * size + size / 2, y: box.y + row * size + size / 2 };
}

export async function dragMove(page: Page, from: string, to: string, orientation: 'white' | 'black' = 'white'): Promise<void> {
  const box = await boardBox(page);
  const a = squareCentre(box, from, orientation);
  const b = squareCentre(box, to, orientation);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x + 6, a.y - 6);
  await page.mouse.move(b.x, b.y, { steps: 10 });
  await page.mouse.up();
}

export async function tapMove(page: Page, from: string, to: string, orientation: 'white' | 'black' = 'white'): Promise<void> {
  const box = await boardBox(page);
  const a = squareCentre(box, from, orientation);
  const b = squareCentre(box, to, orientation);
  await page.touchscreen.tap(a.x, a.y);
  await page.touchscreen.tap(b.x, b.y);
}
```

- [ ] **Step 4: The specs**

`apps/miniapp/e2e/move.spec.ts`:

```ts
import { expect, test } from '@playwright/test';
import { clickMain, clickSecondary, dragMove, harnessGame, openApp, seed, tapMove, tgState } from './support';

test('drags a move as White, the server records it and the app returns to the chat', async ({ page }) => {
  const world = await seed('fresh', { alice: { confirmMoves: false, closeAfterMove: true } });
  await openApp(page, { user: world.users.alice.telegram, startParam: `g_${world.game!.publicId}` });
  await expect(page.locator('.player-bar[data-colour="white"]')).toContainText('Alice');
  await dragMove(page, 'e2', 'e4');
  await expect.poll(async () => (await harnessGame(world.game!.publicId)).plyCount).toBe(1);
  expect((await harnessGame(world.game!.publicId)).fen).toContain('4P3');
  await expect(page.locator('.move-list [data-ply="1"]')).toHaveText('e4');
  const state = await tgState(page);
  expect(state.calls).toEqual(expect.arrayContaining(['ready', 'expand', 'disableVerticalSwipes']));
  expect(state.haptics).toContain('impact:light');
  await expect.poll(async () => (await tgState(page)).closed).toBe(true);
});

test('confirms or cancels a move', async ({ page }) => {
  const world = await seed('fresh', { alice: { confirmMoves: true, closeAfterMove: false } });
  await openApp(page, { user: world.users.alice.telegram, startParam: `g_${world.game!.publicId}` });
  await tapMove(page, 'e2', 'e4');
  await expect.poll(async () => (await tgState(page)).mainButton).toMatchObject({ text: 'Confirm', visible: true });
  expect((await tgState(page)).secondaryButton).toMatchObject({ text: 'Cancel', visible: true });
  expect((await tgState(page)).closingConfirmation).toBe(true);
  await clickSecondary(page);
  await expect(page.locator('square.last-move')).toHaveCount(0);
  expect((await harnessGame(world.game!.publicId)).plyCount).toBe(0);
  await expect.poll(async () => (await tgState(page)).mainButton.visible).toBe(false);
  await tapMove(page, 'e2', 'e4');
  // The hidden button keeps its old text, so wait for it to show again before confirming.
  await expect
    .poll(async () => (await tgState(page)).mainButton)
    .toMatchObject({ text: 'Confirm', visible: true });
  await clickMain(page);
  await expect.poll(async () => (await harnessGame(world.game!.publicId)).plyCount).toBe(1);
  await expect.poll(async () => (await tgState(page)).mainButton.visible).toBe(false);
  expect((await tgState(page)).closed).toBe(false);
});
```

`apps/miniapp/e2e/spectator.spec.ts`:

```ts
import { expect, test } from '@playwright/test';
import { dragMove, harnessGame, openApp, seed } from './support';

test('a spectator cannot lift a piece, and can flip the board', async ({ page }) => {
  const world = await seed('fresh');
  await openApp(page, { user: world.users.carol.telegram, startParam: `g_${world.game!.publicId}` });
  await expect(page.locator('.cg-wrap')).toBeVisible();
  await dragMove(page, 'e2', 'e4');
  await expect(page.locator('square.move-dest')).toHaveCount(0);
  await page.waitForTimeout(300);
  expect((await harnessGame(world.game!.publicId)).plyCount).toBe(0);
  await expect(page.locator('[data-action="resign"]')).toHaveCount(0);
  await page.locator('[data-action="flip"]').click();
  await expect(page.locator('.cg-wrap.orientation-black')).toBeVisible();
});

test('the player who is not to move cannot lift a piece either', async ({ page }) => {
  const world = await seed('fresh');
  await openApp(page, { user: world.users.bob.telegram, startParam: `g_${world.game!.publicId}` });
  await expect(page.locator('.cg-wrap.orientation-black')).toBeVisible();
  await dragMove(page, 'e7', 'e5', 'black');
  await expect(page.locator('square.move-dest')).toHaveCount(0);
  await page.waitForTimeout(300);
  expect((await harnessGame(world.game!.publicId)).plyCount).toBe(0);
  await expect(page.locator('.player-bar[data-colour="black"]')).toContainText('Bob');
});
```

`apps/miniapp/e2e/promotion.spec.ts`:

```ts
import { expect, test } from '@playwright/test';
import { harnessGame, openApp, seed, tapMove } from './support';

test('promotes through the chooser', async ({ page }) => {
  const world = await seed('promotion', { alice: { confirmMoves: false, closeAfterMove: false } });
  await openApp(page, { user: world.users.alice.telegram, startParam: `g_${world.game!.publicId}` });
  await tapMove(page, 'e7', 'e8');
  await expect(page.locator('.promotion')).toBeVisible();
  expect((await harnessGame(world.game!.publicId)).plyCount).toBe(6);
  await page.locator('[data-promote="q"]').click();
  await expect.poll(async () => (await harnessGame(world.game!.publicId)).plyCount).toBe(7);
  expect((await harnessGame(world.game!.publicId)).fen.split(' ')[0]).toBe('3kQ3/8/8/8/8/8/8/4K3');
});
```

`apps/miniapp/e2e/replay.spec.ts`:

```ts
import { expect, test } from '@playwright/test';
import { openApp, seed, tgState } from './support';

test('replays a finished game and reaches analysis and the PGN', async ({ page }) => {
  const world = await seed('finished');
  await openApp(page, { user: world.users.carol.telegram, startParam: `g_${world.game!.publicId}` });
  await expect(page.locator('.banner.result')).toContainText('Black won · Checkmate');
  await expect(page.locator('.move-list [data-ply]')).toHaveCount(4);
  await page.locator('[data-ply="2"]').click();
  await expect(page.locator('[data-action="latest"]')).toBeVisible();
  await expect(page.locator('square.last-move')).toHaveCount(2);
  await page.locator('[data-action="next"]').click();
  await expect(page.locator('[data-ply="3"]')).toHaveAttribute('aria-current', 'true');
  await page.locator('[data-action="latest"]').click();
  await expect(page.locator('[data-action="latest"]')).toHaveCount(0);
  await page.locator('[data-action="analyse"]').click();
  expect((await tgState(page)).links[0]).toContain('lichess.org/analysis/pgn/');
  await page.locator('[data-action="pgn"]').click();
  expect((await tgState(page)).downloads[0]?.file_name).toBe(`${world.game!.publicId}.pgn`);
});
```

`apps/miniapp/e2e/live.spec.ts`:

```ts
import { expect, test } from '@playwright/test';
import { dragMove, openApp, seed } from './support';

test('the opponent sees a move without refreshing', async ({ browser }) => {
  const world = await seed('fresh', { alice: { confirmMoves: false, closeAfterMove: false } });
  const bobContext = await browser.newContext();
  const bob = await bobContext.newPage();
  await openApp(bob, { user: world.users.bob.telegram, startParam: `g_${world.game!.publicId}` });
  await expect(bob.locator('.cg-wrap')).toBeVisible();
  const aliceContext = await browser.newContext();
  const alice = await aliceContext.newPage();
  await openApp(alice, { user: world.users.alice.telegram, startParam: `g_${world.game!.publicId}` });
  await dragMove(alice, 'e2', 'e4');
  await expect(bob.locator('.move-list [data-ply="1"]')).toHaveText('e4', { timeout: 10_000 });
  await expect(bob.locator('.player-bar[data-colour="black"] .clock')).toHaveClass(/active/);
  await aliceContext.close();
  await bobContext.close();
});

test('shows the latest position after the connection drops and comes back', async ({ browser }) => {
  const world = await seed('fresh', { alice: { confirmMoves: false, closeAfterMove: false } });
  const bobContext = await browser.newContext();
  const bob = await bobContext.newPage();
  await openApp(bob, { user: world.users.bob.telegram, startParam: `g_${world.game!.publicId}` });
  await expect(bob.locator('.cg-wrap')).toBeVisible();
  await bobContext.setOffline(true);
  const aliceContext = await browser.newContext();
  const alice = await aliceContext.newPage();
  await openApp(alice, { user: world.users.alice.telegram, startParam: `g_${world.game!.publicId}` });
  await dragMove(alice, 'e2', 'e4');
  await expect(alice.locator('.move-list [data-ply="1"]')).toHaveText('e4');
  await bob.waitForTimeout(1_000);
  await expect(bob.locator('.move-list [data-ply="1"]')).toHaveCount(0);
  await bobContext.setOffline(false);
  await expect(bob.locator('.move-list [data-ply="1"]')).toHaveText('e4', { timeout: 10_000 });
  await aliceContext.close();
  await bobContext.close();
});
```

`apps/miniapp/e2e/fallbacks.spec.ts`:

```ts
import { expect, test } from '@playwright/test';
import { harnessGame, openApp, seed, tapMove, tgState } from './support';

test('a 6.0 client gets in-page cancel, no haptics and no swipe lock', async ({ page }) => {
  const world = await seed('fresh', { alice: { confirmMoves: true, closeAfterMove: false } });
  await openApp(page, { user: world.users.alice.telegram, startParam: `g_${world.game!.publicId}`, version: '6.0' });
  await tapMove(page, 'e2', 'e4');
  await expect(page.locator('[data-action="cancel-move"]')).toBeVisible();
  const state = await tgState(page);
  expect(state.calls).not.toContain('disableVerticalSwipes');
  expect(state.calls).not.toContain('requestWriteAccess');
  expect(state.haptics).toEqual([]);
  expect(state.secondaryButton).toBeNull();
  await page.locator('[data-action="cancel-move"]').click();
  await expect(page.locator('[data-action="cancel-move"]')).toHaveCount(0);
  expect((await harnessGame(world.game!.publicId)).plyCount).toBe(0);
});

test('a 7.0 client opens the PGN as a link instead of a download', async ({ page }) => {
  const world = await seed('finished');
  await openApp(page, { user: world.users.carol.telegram, startParam: `g_${world.game!.publicId}`, version: '7.0' });
  await page.locator('[data-action="pgn"]').click();
  const state = await tgState(page);
  expect(state.downloads).toEqual([]);
  expect(state.links[0]).toContain(`/api/games/${world.game!.publicId}/pgn?token=`);
});
```

`apps/miniapp/e2e/lobby.spec.ts`:

```ts
import { expect, test } from '@playwright/test';
import { clickMain, openApp, seed, telegramCalls } from './support';

test('a challenge made in the app is posted to the group and accepted from the lobby', async ({ browser }) => {
  const world = await seed('none');
  const aliceContext = await browser.newContext();
  const alice = await aliceContext.newPage();
  await openApp(alice, { user: world.users.alice.telegram, startParam: `l_${world.group.publicId}` });
  await expect(alice.locator('.title')).toHaveText('Chess Club');
  await expect(alice.locator('[data-action="group-settings"]')).toBeVisible();
  await alice.locator('[data-action="new-game"]').click();
  await alice.locator('[data-opponent]').filter({ hasText: 'Bob' }).click();
  await alice.locator('[data-time="28800"]').click();
  await clickMain(alice);
  await expect(alice.locator('.toast')).toHaveText('Challenge posted to the group');
  await expect(alice.locator('[data-cancel]')).toBeVisible();
  await expect
    .poll(async () => (await telegramCalls()).filter((call) => call.method === 'sendMessage').length, { timeout: 10_000 })
    .toBeGreaterThan(0);
  const card = (await telegramCalls()).find((call) => call.method === 'sendMessage');
  expect(String(card?.body.text)).toContain('Alice challenges');

  const bobContext = await browser.newContext();
  const bob = await bobContext.newPage();
  await openApp(bob, { user: world.users.bob.telegram, startParam: `l_${world.group.publicId}` });
  await expect(bob.locator('[data-accept]')).toBeVisible();
  await bob.locator('[data-accept]').click();
  await expect(bob.locator('.cg-wrap')).toBeVisible();
  await expect(bob.locator('.player-bar[data-colour="white"], .player-bar[data-colour="black"]').first()).toContainText(/Alice|Bob/);
  await aliceContext.close();
  await bobContext.close();
});

test('the groups screen lists the user’s groups from a profile launch', async ({ page }) => {
  const world = await seed('fresh');
  await openApp(page, { user: world.users.alice.telegram });
  await expect(page.locator('[data-group]')).toHaveText(/Chess Club/);
  await page.locator('[data-group]').click();
  await expect(page.locator('[data-game]')).toHaveCount(1);
});
```

- [ ] **Step 5: The bundle budget script and ignores**

`scripts/check-bundle-size.mjs`:

```js
#!/usr/bin/env node
// Spec §6.5: initial JavaScript ≤ 120 KB gzipped, CSS ≤ 25 KB gzipped, measured on the built app.
import { readdir, readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUDGET = { js: 120 * 1024, css: 25 * 1024 };
const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../apps/miniapp/dist/assets');

const totals = { js: 0, css: 0 };
for (const name of await readdir(dist)) {
  const kind = name.endsWith('.js') ? 'js' : name.endsWith('.css') ? 'css' : null;
  if (!kind) continue;
  const size = gzipSync(await readFile(join(dist, name))).length;
  totals[kind] += size;
  console.log(`${name}: ${(size / 1024).toFixed(1)} KB gzipped`);
}
let failed = false;
for (const kind of ['js', 'css']) {
  const ok = totals[kind] <= BUDGET[kind];
  console.log(`${kind}: ${(totals[kind] / 1024).toFixed(1)} KB of ${BUDGET[kind] / 1024} KB ${ok ? 'OK' : 'OVER BUDGET'}`);
  if (!ok) failed = true;
}
process.exit(failed ? 1 : 0);
```

Append to `.gitignore`:

```
apps/miniapp/dist/
apps/miniapp/test-results/
apps/miniapp/playwright-report/
```

- [ ] **Step 6: Build, check the budget and run the end-to-end suite**

Run:

```bash
pnpm --filter @group-chess/miniapp build && node scripts/check-bundle-size.mjs
source /tmp/claude-0/-home-user-telegram-chess-bot/0426af27-ecf2-5b92-adfd-ab634e05f802/scratchpad/testdb.env
PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium pnpm --filter @group-chess/miniapp exec playwright test
```

Expected: the budget script prints both totals under budget and exits 0; Playwright reports 12 passed.

- [ ] **Step 7: Run the whole suite and the static checks**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm format:check`
Expected: all exit 0.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(miniapp): add the end-to-end harness and Playwright suite, the bundle budget check, CSP and the PGN token"
```

---

## Self-review

**Spec coverage (plan 04 scope).** §6.1 launch sequence → Task 4 `boot` (ready, expand, theme, swipes, one launch, write access after render, BackButton binding, close from a game link, 401 relaunch, "Reopen from Telegram"). §6.2 every route → Task 4 screens and Task 5 game/replay. §6.3 board adapter, who may drag, the move state machine, earlier positions, haptics → Tasks 3 and 5. §6.4 live updates, refresh on resume, local clocks, banners from diffs → Tasks 2, 3, 5. §6.5 budgets → Task 6 script. §6.6 fallbacks → Task 1 wrapper, Task 5 in-page cancel and PGN link, Task 6 e2e. §6.7 theme and board sizing → Task 1 theme and stylesheet. §12 CSP, tokens in memory, no third-party scripts → Tasks 1, 2, 6. §14 client telemetry → Tasks 2 (`sse_failed`), 5 (`move_retry`). §15 e2e list (drag, tap-tap, promotion, confirm/cancel, spectator, earlier position and return, replay slider, live update between two contexts, version fallbacks, bundle budget) → Task 6; Lighthouse against staging belongs to plan 05. PRD §7.4 board UI (last move, check, coordinates, move list, clocks, names and ratings, draw and resign controls, orientation, flip for spectators, after-move close) → Task 5. PRD §7.8–§7.12 lobby tabs, replay, ratings on the end screen, Lichess link, settings and admin, delete my data → Tasks 4 and 5.

**Placeholder scan.** Every file is given in full; the only "replace" steps name the placeholder they replace (`main.tsx` in Task 4, `screens/Game.tsx` in Task 5). No step says "similar to" or "add handling".

**Type consistency across tasks.** `Tg` (Task 1) is what `Router` (Task 4), `boot` and `GameView` (Task 5) call, with the same method names (`setMainButton`, `setSecondaryButton`, `closingConfirmation`, `downloadFile` returning booleans). `ApiClient.url(path, query)` (Task 2) builds the SSE and PGN URLs (Task 5). `GameStore` fields (`position`, `orientation`, `sideToMove`, `canMove`, `dests`, `isLatest`) drive `Board` through signal effects. `BoardAdapter` is implemented by chessground in `adapter.ts` and by `stubAdapter` in tests with the same six methods. `reduceMove` effects are exactly the five the screen runs. `installFakeWebApp` is imported by unit tests and serialised into the page by Playwright, so it stays free of outer references. The harness uses plan 03's `startServer`, `testConfig`, `FakeTelegram` and fixtures unchanged; `signInitData` is the same signer the server tests use.

**Review Focus mapping.** 1 → Task 2 "refreshes the state and reopens the stream when the page becomes visible or online again" and Task 6 e2e "shows the latest position after the connection drops and comes back"; 2 → Task 3 "lets only the player to move move, and only at the latest position" and Task 6 e2e "a spectator cannot lift a piece"; 3 → Task 3 "returns to idle and restores the position on a stale rejection", "keeps the client move id and backs off across network retries" and Task 5 "snaps back silently…", "retries with the same client move id…"; 4 → Task 6 e2e "confirms or cancels a move" and Task 5 "asks for confirmation…"; 5 → Task 6 `check-bundle-size.mjs`.

**Known limits carried forward.** Board theme and piece set choices (P1) are stored but not offered. Search and filter of finished games (P1) is absent. The Lighthouse run and the CI wiring of the e2e job are plan 05. Chessground's `blockTouchScroll` plus Telegram's `disableVerticalSwipes` are the drag protections; the device matrix of spec §15 remains a manual alpha-exit step.

## Post-review fixes

The fresh-context review of `a71f474..a36052a` (ledger: `.superpowers/sdd/2026-09-20-group-chess-04-miniapp/final-review.md`) returned "With fixes". One fix pass, tests first:

- **Live e2e made deterministic.** `setOffline(true)` leaves an already-open SSE response alive, so "Bob has not seen the move" was true only when Chromium happened to drop the stream. The harness now exposes `POST /connections/close` (`RunningServer.closeConnections()` → `server.closeAllConnections()`), the spec drops Bob's socket server-side while offline, waits for the `sse_streams` gauge to read 0, and after going online asserts both the refresh `GET /api/games/:id` and the reopened stream. Six repeats green.
- **Check haptic.** `applyState` calls `notificationOccurred('warning')` when an applied move leaves the side to move in check (spec §6.3), whichever side gave it. Test: `game.test.tsx` "buzzes a warning …".
- **A move awaiting Confirm survives snapshots.** `GameStore.apply` no longer reassigns the signal for an equal snapshot (the resume refresh), and `Board` takes `frozen` — while a move is pending, position pushes are held back; if the game moves on (ply or status changes) the screen cancels the pending move, since the server would reject its `expectedPly`. Test: `game.test.tsx` "keeps a move awaiting confirmation …".
- **`launch_failed`.** `/api/telemetry` requires a session (spec §9), so a client whose first launch failed has nothing to report with. The API-side half is counted by the server instead: an unhandled error on `POST /api/launch` increments `miniapp_load_errors_total` (`api-launch-errors.test.ts`). Telegram-script failures remain invisible; plan 05's operations doc says so.
- **Minors.** `dispatch` runs the latest effect runner through a ref; `useMainButton` binds once per text/enabled/progress and calls the latest handler through a ref (`hooks.test.tsx`); the write-access decline path is tested; `move.spec` asserts `square.move-dest` is non-empty for a player so the spectator negatives mean something; the lobby route's unused `tab` is gone; `Lobby.more()` reports a failed page; promotion buttons carry `aria-label`s (`app.game.piece.*`); the block confirmation comes from `app.gsettings.block_confirm`; dead catalog keys removed.

Deferred with rulings in the ledger: the SSE URL pinning the token at mount (both TTLs are 24 h), a ping watchdog (not required by §6.4), the bundle script wiring (plan 05 Task 1), `reuseExistingServer` locally.
