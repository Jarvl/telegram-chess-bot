# Mini App navigation: a tab bar, a games home, and a one-tap exit

Status: accepted, 2026-09-22. Supersedes §6.1 step 5 and parts of §6.2 of the
[technical design](./2026-09-20-group-chess-technical-design.md).

## The problem

The Mini App has no lateral navigation. Every screen is reached by pushing onto a single
route stack, and a deep launch (`g_`, `l_`, `s_`) seeds a stack of exactly one screen. Two
consequences:

- **You cannot get anywhere.** Opening a game from a group card lands you on that game with
  nothing above it. To reach another game you close the app, return to the chat, find the
  other card and tap it again — which leaves a second Mini App instance stacked in
  Telegram's header. The user Settings screen is reachable only from the Groups screen,
  which a deep launch never shows.
- **The obvious fix makes it worse.** PR #12 seeded the implied stack instead
  (`g_<gameId>` → Groups, Lobby, Game). Back then walked up, but exiting cost three taps
  where it had cost one, and `disableVerticalSwipes()` (spec §6.1 step 2) removes the
  swipe-down escape hatch. It was reverted in #13: *"navigation on mobile is weird. takes
  multiple taps to exit."*

Depth and exit are in tension because the same control serves both. The fix is to stop
using BackButton for lateral movement.

## How Mini Apps conventionally solve this

The pattern across production Mini Apps (Wallet, TON Space, Notcoin, Blum, Hamster Kombat,
the trading bots) is consistent:

1. A **persistent in-app bottom tab bar** carries the root sections.
2. **Tab switches are lateral** — they change which stack is showing, never deepen one.
3. **Telegram's BackButton means depth only.** It is absent at a tab root, which leaves the
   client's own close affordance as the unambiguous way out.
4. **Deep links land on the detail screen itself**, not on a synthesised stack. The tab bar
   is the escape hatch.

Applied here this gives exit back its single tap *and* makes "another game" two taps.

## The design

### Tabs

Three, each owning its own route stack:

| Tab | Root screen | Holds |
|---|---|---|
| **Games** | `games` — your active games across every group, your move first | `game` |
| **Groups** | `groups` — your groups | `lobby`, `newGame`, `game`, `player`, `groupSettings` |
| **Settings** | `settings` — user preferences | — |

Games is home. A correspondence chess app's home is the set of boards waiting on you, not a
directory of clubs; this is what Lichess and Chess.com open to, and it is what makes
game-to-game a two-tap move (tab, then row). The Settings screen stops being a push off
Groups, which is what made it unreachable from a deep launch.

Tapping a **different** tab resumes that tab's stack where it was left. Tapping the
**active** tab returns it to its root — this is how a deep-launched game gets home.

### Where a launch lands

`routeFor` is replaced by `landingFor`, which names a tab and a single screen. The stack is
one deep in every case, so BackButton never becomes the way home:

| Launch | Tab | Stack |
|---|---|---|
| no start param (`home`) | games | `[games]` |
| `g_<gameId>` | games | `[game]` |
| `l_<groupId>` | groups | `[lobby]` |
| `s_<groupId>` | groups | `[groupSettings]` |
| locked group | groups | `[locked]` |

### BackButton

```
visible = stack.length > 1 || launchedFromADeepLink
onClick = pop one level, or close the app when already at the root
```

This restores the pre-#12 behaviour for `g_` and extends it to `l_` and `s_`, which
previously showed no BackButton at all. A profile launch has no start param, so its root
shows no BackButton and Telegram's close is the only exit — as before.

The one path that genuinely means close (**Done** on a finished game) still calls
`tg.close()` directly, gated on `session.launchedFrom`, and never went through the router.

### Tab bar visibility

The bar renders on every screen except `loading`, `error`, `reopen` and `locked` — the four
that exist before or instead of a session, where no tab means anything.

It shows on the Game screen, except while a move waits for Confirm move. Then Telegram's
MainButton and SecondaryButton carry Confirm move and Cancel below the WebView, and the tab bar
hides so that Telegram's bar takes about the space it frees and the board keeps its size (see
[move confirmations](./2026-09-24-move-confirmations-design.md)). The board is
`min(100vw, stable-height − 200px)` (styles.css); the bar adds itself to that subtraction,
so it costs board area only on screens tall enough that height, not width, was the binding
constraint.

## Server changes

### `GET /api/me/games`

```ts
MeGamesDto = { items: (GameSummary & { group: GroupRef })[] }
```

Active games in every group where the viewer is a known member and the bot is still
present, ordered your-move first, then most recently moved — the same ordering rule as a
group lobby's Active tab (PRD §8.2), applied across groups. Membership and bot-presence
filtering reuse `meGroups`'s conditions.

### Launch route `home` replaces `groups`

`POST /api/launch` with no start param now returns `{ kind: 'home', games }` instead of
`{ kind: 'groups', groups }`, so the first screen paints from the launch response and §6.5's
budget of one request before first paint is preserved. The Groups tab fetches
`GET /api/me/groups` when first selected, which is a lateral move, not first paint.

## The "your move" badge

The Games tab carries the number of active games waiting on the viewer, across every group, and
no badge at all at zero. The count has to outlive the Games screen — it is most useful while the
viewer is deep inside one game — so it is a module signal (`state/yourMove.ts`), fed by three
sources in order of authority:

1. **The launch response** (`yourMove`) seeds it, so a `g_<gameId>` deep link shows the real total
   rather than just the game it opened. A home launch derives the figure from the games it already
   carries; every other launch pays for one count query.
2. **A fetched games list** recounts it from scratch, healing any drift.
3. **A game changing hands** adjusts it by one. Every state change on the game screen — SSE, the
   move response, draw and resign actions — funnels through `applyState`, which holds both the old
   and the new snapshot, so the delta is exact and cannot double-count.

Drift is possible and self-correcting: accepting a challenge creates a game the badge does not
learn about until the next list load. The count never goes below zero.

## Deliberately not in this change

- **Per-tab scroll restoration.** Stacks are restored; scroll offset is not.
- **A game-to-game switcher sheet inside the Game screen.** The tab bar already makes it two
  taps; a sheet would make it one, at the cost of another surface.
