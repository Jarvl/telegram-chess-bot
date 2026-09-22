# Group Chess — Engine Opponent Design

| | |
|---|---|
| **Scope** | An always-available Stockfish opponent that any user can challenge inside a group |
| **Status** | Draft v0.1, for review |
| **Date** | 2026-09-21 |
| **Method** | superpowers `brainstorming` skill, architectural path |
| **Amends** | [docs/PRD.md](../../PRD.md) §3 — reverses the "engine opponents" non-goal (§3 below) |
| **Next step** | After review, an implementation plan under `docs/superpowers/plans/` (superpowers `writing-plans`) |

---

## 0. How to read this document

Every decision in §1 was taken by the project owner during the brainstorm, not inferred. Where a
decision carries a cost, the cost is recorded next to it rather than argued away. **Read §1 and §3
first**: §3 reverses a documented product decision, and everything else follows from §1.

Naming convention, because "bot" is already taken: the Telegram bot is **the bot**; this feature is
**the engine** in code, configuration, metrics and this document, and **the bot** in user-facing
copy. The database column is `engine_elo`, not `bot_level`.

Conventions: "must" is a requirement, "should" is a strong default. A fact that could not be
verified from the build sandbox is marked *verify at implementation* and collected in §13.

## 1. Decisions taken by the owner

| # | Question | Decision | Cost of this choice |
|---|---|---|---|
| E1 | What is the engine opponent for? | Always-available practice: a standing feature so a player always has a game, with real playing strength and selectable levels | Reverses a PRD non-goal (§3). Permanent product surface, not a test fixture |
| E2 | Where can a user play it? | Inside a group, like any other player. Engine games belong to that group | None. Reuses the existing group-scoped pipeline with no schema change to `games` beyond §5. Playing without a group remains impossible |
| E3 | Do engine games affect ratings? | Never. Excluded from Glicko-2, from the leaderboard, and from W/D/L | None. Protects the integrity of human ratings. Practice does not "count" |
| E4 | Which engine, and where does it run? | Native Stockfish binary in the image, driven over UCI | Chosen over WASM. Adds a pinned per-architecture binary, a licence-gate blind spot and a local install requirement for developers. All three are answered in §12 |
| E5 | How is strength selected? | Numeric levels, 1400–2800 in steps of 200, stored as the number itself | `UCI_Elo` floors at ~1320, so **there is no beginner level**: the weakest bot plays like a solid club player and a true beginner will lose every game. Accepted knowingly (§7) |
| E6 | Should weak levels use blunder injection? | No. Stockfish's own strength limiting only, kept simple | This is what forecloses levels below 1400. Reversible later: §7 records what adding it would take |
| E7 | What happens when the engine returns an illegal move? | Play a random legal move and continue the game. Do not abort. This is error recovery, not E6 blunder injection: it fires only on a defect, never as a strength mechanism | A silent failure mode: a bug in our UCI parsing would quietly become random moves. Mitigated by mandatory logging and a zero-tolerance alert (§9, §10) |

## 2. Scope

**In scope.** A user picks the bot and a level in the Mini App and gets a game immediately. The
engine answers each of the user's moves. The game is unrated, invisible to the group chat, visible
in the app, and never forfeits on the engine's side.

**Out of scope.** Playing the engine outside a group. Rated engine games. Engine evaluation, hints
or analysis anywhere in the app, at any time — PRD §7.8 still holds, and this feature must not
become a back door to it. Strength calibration: the level numbers are configuration, not
measurements (§7). Levels below 1400 (E6). Any change to how human games work.

## 3. PRD amendment

[docs/PRD.md](../../PRD.md) §3 currently reads, under "Non-goals and decisions already made":

> - Engine opponents, puzzles, vote chess, tournaments, seasons, variants, achievements.

and PRD §3 goal 5 reads "Standard chess, real opponents, no takebacks."

The implementation must amend both:

- Remove "Engine opponents" from that non-goal line, leaving the rest of the list intact.
- Add a functional-requirements subsection for the engine opponent, priority P1, stating that engine
  games are unrated, group-scoped, and post nothing to the group chat.
- Reword goal 5 so "real opponents" no longer excludes the engine, while keeping the point it was
  making: standard chess, permanent moves.
- Record in PRD §3 that the reversal was deliberate and dated, so it does not read as creep.

The non-goals that remain must stay explicitly listed, in particular no in-app analysis. Adding an
engine to the server makes that line easier to violate, so it becomes more important, not less.

## 4. Approaches considered

### 4.1 Engine and runtime (decision E4)

**A — WASM Stockfish in a worker thread.** The `stockfish` npm package (GPL-3.0, already admitted by
the licence allow-list) driven over UCI. No Dockerfile change, no per-architecture binary, identical
in development, CI and production, and server-side only so the Mini App bundle budget is untouched.
Slower than native by a factor that per-move clocks of hours or days cannot notice.

**B — Native Stockfish binary in the image (chosen).** Strongest and fastest, and standard operational
practice. Costs a pinned per-architecture binary, a dependency `scripts/check-licences.mjs` cannot
see, and a local install for every developer and for CI, or `pnpm dev` diverges from production.
§12 answers each.

**C — Pure-JS minimax on chess.js.** No new dependency and fully deterministic tests, but a realistic
ceiling near 1200–1500 with no credible ladder above it, and engine tuning becomes part of this
project. Rejected: fails E1's requirement of real playing strength.

### 4.2 Reaching weak levels (decisions E5, E6)

`UCI_LimitStrength` with `UCI_Elo` covers roughly 1320–3190 (*verify at implementation*). Below that
floor, Stockfish offers only `Skill Level`, whose weakest setting still plays far above a beginner.
Genuinely weak play therefore requires blunder injection — replacing the engine's move with a random
legal move at some probability — which E6 declines. The consequence is E5's: the ladder starts at
1400.

Reversing E6 later means adding a probability per level below 1400 and selecting from `legalDests`,
which `@group-chess/shared` already exports. The mapping from blunder rate to Elo would be invented,
not measured, and §7's honesty requirement would apply to it.

## 5. Data model

One nullable column and one row. No new tables.

- `games.engine_elo integer null`. Non-null marks an engine game and records the level played. Storing
  the number rather than an enum makes the database self-describing, feeds the PGN name directly, and
  lets levels be added or removed with no migration.
- `challenges` is untouched: engine games never create a challenge (§6.1).
- One `users` row for the engine, with `telegram_user_id = null`. This shape is already supported
  throughout: delete-my-data produces it (`domain/account.ts`), the DM handler skips such users
  (`jobs/handlers/telegram.ts`), cards render them as plain text with no mention entity
  (`telegram/cards.ts`), and `membership.verify` — which returns false for a null id — is only ever
  called on the authenticated caller, never on an opponent. The engine therefore triggers no Telegram
  API call.
- The engine row gets a `group_members` row per group where it is used, so existing queries treat it
  as present without special cases.

Display name: `Stockfish`, with the level where a level is meaningful (`Stockfish (1600)` in PGN
headers). Naming it is also the honest thing to do for a GPL-3.0 dependency.

## 6. Architecture

### 6.1 Creating a game

Engine games skip the challenge entirely: there is nothing to accept, nothing to expire, and no card
to edit. A new endpoint `POST /api/groups/:groupId/engine-games` takes a level, a colour choice and a
time-per-move, and creates the game in one transaction with the same shape as `acceptChallenge` minus
the challenge row. It must force `rated = false` server-side rather than trusting the client (E3),
and must reject a level outside the table in §7. When the engine moves first it
must also apply §9's deadline rule at creation, leaving `deadline_at` and `reminder_at` null.

Limits: the caller's own `maxActiveGamesPerUser` still applies, and the existing
`MAX_GAMES_PER_PAIR = 2` already caps a user at two concurrent engine games, which is the desired
behaviour. Only the engine's own active-game count is exempt, since it plays everyone at once.

### 6.2 The engine seam

A new `apps/server/src/engine/` module. The engine sits behind an interface:

```
Engine = {
  bestMove(fen: string, elo: number, deadlineMs: number): Promise<{ uci: string } | { none: true }>
  probe(): Promise<{ available: boolean; version?: string }>
}
```

Two implementations: `uciEngine`, which spawns the real binary, and `fakeEngine` for tests.
Everything above the seam — jobs, domain, API — depends only on the interface. This is what keeps the
test suite free of the binary (§11) and is the single most important structural decision here.

**One process per move, not a long-lived engine.** UCI is a stateful single-session protocol, so a
persistent process needs a mutex, `ucinewgame` discipline between games, crash-restart handling, and
can bleed state between games. Spawning per move costs tens of milliseconds, which is free at these
time controls, and removes that entire class of bug. The adapter owns a hard wall-clock cap and a
`SIGKILL` fallback, so a hung engine can never hold a job open.

### 6.3 Where it runs

A new `engine_move` job kind, handled only in the `jobs` role. Engine CPU therefore never lands in
the `api` process, which is the one holding SSE streams and the most sensitive to a blocked event
loop. This falls out of the existing role split at no cost.

The job worker leases a batch and runs jobs in order (`jobs/worker.ts`), so engine spawns are already
serialised and a burst of engine games cannot fork hundreds of processes. No semaphore is needed. The
accepted trade-off: a slow engine move delays jobs queued behind it, which is why move time must stay
in the low hundreds of milliseconds and is capped by configuration.

### 6.4 Triggering a move

`playMove` gains one hook: after a committed human move, if `game.engineElo !== null`, enqueue
`engine_move` with `dedupKey: engine:g:<publicId>:ply:<n>`. The ply in the key makes it idempotent by
construction — a retry, a double trigger or two workers cannot produce two engine moves for one
position, and `playMove`'s existing `expectedPly` guard is the second line of defence. The same
enqueue happens at creation when the engine has white.

The handler resolves the level from the game row, calls `bestMove`, and plays the result through the
ordinary `playMove` path as the engine user. It passes the game's current `plyCount` as
`expectedPly` and a `clientMoveId` derived deterministically from the game and ply, so a retry that
races a committed move is absorbed by the existing idempotency check rather than duplicating it. It does not write moves directly: the arbiter, the
clock, the event bus and the game-end logic must all run exactly as they do for a human.

### 6.5 Configuration

| Variable | Required | Meaning |
|---|---|---|
| `ENGINE_ENABLED` | no | Default true. False hides the bot and stops new engine games |
| `ENGINE_PATH` | no | Default `stockfish`. Path to the UCI binary |
| `ENGINE_MOVETIME_MS` | no | Per-move search budget in milliseconds, default 200. Caps §6.3 coupling |

## 7. The difficulty ladder

Eight levels: **1400, 1600, 1800, 2000, 2200, 2400, 2600, 2800**. Each sets
`UCI_LimitStrength = true` and `UCI_Elo = <level>`, plus `ENGINE_MOVETIME_MS`. Nothing else varies.

Two honesty requirements, both binding:

1. These numbers are Stockfish's own `UCI_Elo` scale, which is calibrated against engines rather than
   humans. They are therefore **approximate**, and no part of this project measures them. User-facing
   copy must present the control as approximate strength, not as a measured rating. Because engine
   games are unrated (E3), nothing in the product can ever check them.
2. No level may be described in copy or documentation as equivalent to a human rating on the group's
   own leaderboard. The leaderboard measures play against humans; these numbers do not enter it.

**Opening variety is not addressed.** Fixed options plus a fixed position make Stockfish largely
deterministic, so a given level will tend to repeat openings. `MultiPV 3` with a random pick over the
engine's first few moves was considered and cut to keep this simple (E6's spirit). The cost is
repetitive openings at the higher levels; the fix is contained and can be added later.

## 8. Product surface

| Area | Requirement |
|---|---|
| Opponent picker | The bot is a distinct field in the picker DTO, not a `PlayerRef`, so it can never be mistaken for a human. Rendered as a pinned row plus a level list, following the existing time-per-move list pattern in `ui/screens/NewGame.tsx` |
| Rated switch | Forced off and disabled whenever the bot is selected, with copy explaining that engine games are unrated |
| Group chat | **No cards at all**, not even a result card. PRD §3 goal 4 is a quiet group chat and the group has no stake in a member playing a machine. The game remains in app history and spectatable by link, so "spectating by default" survives without spending group attention |
| Leaderboard and stats | Unrated already excludes engine games from Glicko-2. Additionally they are excluded from W/D/L, and the engine user never appears in the Players tab |
| Draw offers | The bot declines every draw offer. Predictable, and keeps evaluation out of the draw path — which §2 requires anyway |
| Resign and abort | Unchanged. The human can resign or abort under the existing rules |
| Clocks | The human keeps a normal per-move deadline and can still forfeit. The engine never can — see §9 |
| Rematch | Creates a new engine game at the same level directly, not a challenge. Because engine games post no card (above), the affordance exists only on the game-end screen in the app; the card `rematch` callback is never reachable for them |
| Lichess import | **Skipped for engine games.** The quota is 100 imports per hour shared across the deployment, and unlimited engine games would drain it for games with no human opponent. The analysis-board fallback link and the PGN download both still work and need no quota, so the game-end screen keeps working |
| Turn DMs | Unchanged. The engine answers within seconds, which makes the existing DM useful rather than noisy |

## 9. Error handling and failure modes

**The engine must never lose on time.** `playMove` sets `deadline_at` and `reminder_at` to **null
when the next side to move is the engine**, in the same place it already recomputes them.
`forfeitOverdueGames` only considers games with a non-null `deadline_at` and re-checks it inside the
transaction (`clock/scanners.ts`), so the engine becomes unforfeitable by construction and the
scanner needs no change — no parsing side-to-move out of a FEN in SQL. The human's own deadline is
unaffected.

| Failure | Behaviour |
|---|---|
| Engine hangs | Hard wall-clock cap in the adapter, then `SIGKILL`. Job returns `retry_attempt` with backoff |
| Engine crashes or emits unparseable output | Same retry path, logged with the output tail and the FEN |
| `bestmove (none)` | The position is terminal: our state and the engine disagree, or the game ended between enqueue and run. Re-check game status; if it is over, the job completes successfully. Not an error |
| Engine returns an illegal move | **Play a random legal move from `legalDests` and continue the game** (E7). Must log at error level with the FEN and the raw `bestmove`, and increment `engine_illegal_moves_total`. If there are no legal moves, fall through to the `(none)` row instead |
| Retries exhausted (sustained outage) | Abort the game via the existing `abortGame` path with a clear reason and notify the player. Not a loss for either side: the failure is ours, and the game was unrated |
| Binary missing or broken at boot | The `jobs` role probes once, logs at error level and sets `engine_available` to 0. It **must not** kill the process |
| Duplicate or retried trigger | Already prevented by the ply-scoped `dedupKey` and `playMove`'s `expectedPly` guard |

**Why a missing binary must not fail fast.** A bad package upgrade must not take down human
correspondence games, which are the product. The process starts, human play is untouched, and the
engine degrades. The accepted cost: because `api` serves the picker and `jobs` owns the engine, during
an outage the picker keeps offering a bot that cannot move, and those games queue and then abort.
Closing that window needs shared state — a heartbeat row written by `jobs` and read by `api` — and is
deliberately deferred; `ENGINE_ENABLED` plus the metric and its alert is enough.

**Why E7 needs the alert.** Stockfish does not emit illegal moves, so an illegal `bestmove` almost
certainly means a bug in our UCI parsing — a mishandled promotion suffix, or a `ponder` token read as
the move. Recovering silently would turn such a bug into permanently random moves in one specific
situation, undetectable from the outside. The alert on `engine_illegal_moves_total` must therefore
fire on **any** occurrence, not on a rate threshold.

## 10. Observability

Added to the existing `/metrics`: `engine_moves_total`, `engine_move_failures_total`,
`engine_illegal_moves_total`, `engine_move_duration_seconds`, `engine_available`.

Alerts documented in [docs/operations.md](../../operations.md): any increment of
`engine_illegal_moves_total`; `engine_available` at 0 while `ENGINE_ENABLED` is true; a sustained
`engine_move_failures_total` rate.

## 11. Testing strategy

**Rule: assert liveness and legality, never choice.** Nothing in this project tests Stockfish. No
test asserts a specific engine move, an evaluation, a mate score, or that a level plays at its
labelled strength. Level configuration is verified by asserting the UCI options **we send**, which is
our contract, against the fake's recorded commands.

**No CI runner installs Stockfish.** The whole suite — the existing tests plus everything below — runs
against `fakeEngine`, which can be told to return a scripted move, an illegal move, unparseable
output, `(none)`, to hang, or to crash. Every row of §9 is therefore an ordinary test.

**Unit, the UCI adapter**, against recorded transcript strings with no process spawned: handshake,
`bestmove e2e4`, a promotion `bestmove e7e8q`, `bestmove (none)`, a reply carrying a `ponder` token,
and garbage. This is deliberately the layer that catches the parsing bugs E7's fallback would
otherwise hide, which is why it is mandatory rather than nice to have.

**Integration**, on real PostgreSQL with the fake engine and the fake Bot API:

- Creating an engine game writes no challenge row, enqueues no card job, forces `rated` false and
  stores `engine_elo`; an out-of-table level is rejected
- The engine drawing white gets a move job at creation
- Human moves, engine answers; `deadline_at` is null on the engine's turn and set on the human's
- **The engine is never forfeited**: past deadline, run the forfeit scanner, game still active
- An illegal engine move results in a legal move played, the game still active, and
  `engine_illegal_moves_total` incremented
- `bestmove (none)` on a finished game completes the job and writes no move
- Exhausted retries abort the game and notify the player
- No rating rows are written, the engine is absent from the leaderboard, and engine games are out of
  W/D/L
- No Telegram API call is made for the engine user, and no Lichess import job is enqueued when an
  engine game ends
- Two triggers for one ply produce exactly one move
- The UCI options sent for each level match §7

**Mini App unit:** the level list renders; the rated switch is forced off and disabled with the bot
selected.

**End-to-end:** one engine game seeded in the existing harness and played through, on the fake engine.

**The real binary** appears in exactly two non-test places: the Dockerfile build assertion (§12) and
the existing image smoke job in `.github/workflows/e2e.yml`, extended to probe that
`engine_available` is 1.

## 12. Packaging, development and licensing

Answering the three costs of E4.

**Image.** `apt-get install -y --no-install-recommends stockfish` in the runtime stage, with the
version pinned and recorded. The build must then assert that the binary completes the `uci` handshake
**and** returns a legal move for one fixed FEN through our own adapter, legality judged by the
project's arbiter. A broken, netless or missing binary then fails the image build rather than
production. Debian's package is reported to embed the NNUE network (*verify at implementation*); if it
does not, the net must be installed and its path configured, and the build assertion is what will
catch it.

**Developers and CI.** `ENGINE_ENABLED=false` is the documented path for a machine without the
binary: the bot does not appear and nothing else changes. No CI runner installs Stockfish (§11).
[docs/running.md](../../running.md) gains a short section saying the bot needs Stockfish locally and
that the flag turns it off.

**Licensing.** `scripts/check-licences.mjs` reads npm metadata only, so Stockfish is invisible to it
and the gate will keep passing while the image gains a GPL-3.0 dependency. This is compatible with
the repository's GPL-3.0-or-later, but it must be recorded rather than implicit: a documented
non-npm dependency entry naming Stockfish, its version and its licence, and the licence text carried
in the image. The licence script should also state in its output that it covers npm dependencies
only, so the gap is not mistaken for coverage.

## 13. To verify at implementation

- The exact `UCI_Elo` range of the packaged Stockfish, and that 1400 is inside it (§7). If the floor
  is above 1400 the ladder's first rung moves up
- The Debian package version available in `node:22-bookworm-slim`, and whether the NNUE network is
  embedded (§12)
- That `UCI_LimitStrength` and `UCI_Elo` are honoured by the packaged build rather than ignored
- Whether the packaged binary is available for every architecture the image is built for

## 14. Known consequences, stated plainly

- **No beginner level.** The weakest bot plays around 1400. A beginner will lose every game (E5, E6)
- **Level numbers are unverified.** They are Stockfish's engine-calibrated scale, not measurements of
  play against humans, and nothing in the product can check them (§7)
- **Openings will repeat** at the higher levels (§7)
- **An illegal move recovers silently**, and only the log and the alert reveal it (E7, §9)
- **During an engine outage the picker still offers the bot**, and those games queue and then abort
  (§9)
- **Engine games get no permanent Lichess URL** (§8)
