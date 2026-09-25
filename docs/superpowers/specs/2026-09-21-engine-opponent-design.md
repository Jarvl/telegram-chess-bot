# Group Chess — Engine Opponent Design

| | |
|---|---|
| **Scope** | An always-available Stockfish opponent that any user can challenge inside a group |
| **Status** | Draft v0.3, for review |
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
copy. The database column is `engine_level`, not `bot_level`.

Revisions: v0.2 replaces the numeric strength ladder with four named levels (E5), which also removes
the ladder's dependency on the unverified `UCI_Elo` floor. v0.3 adds E8 and §4.3, on why the engine is
not its own deployable.

Conventions: "must" is a requirement, "should" is a strong default. A fact that could not be
verified from the build sandbox was marked *verify at implementation*; §13 now records what each
one turned out to be.

## 1. Decisions taken by the owner

| # | Question | Decision | Cost of this choice |
|---|---|---|---|
| E1 | What is the engine opponent for? | Always-available practice: a standing feature so a player always has a game, with real playing strength and selectable levels | Reverses a PRD non-goal (§3). Permanent product surface, not a test fixture |
| E2 | Where can a user play it? | Inside a group, like any other player. Engine games belong to that group | None. Reuses the existing group-scoped pipeline with no schema change to `games` beyond §5. Playing without a group remains impossible |
| E3 | Do engine games affect ratings? | Never. Excluded from Glicko-2, from the leaderboard, and from W/D/L | None. Protects the integrity of human ratings. Practice does not "count" |
| E4 | Which engine, and where does it run? | Native Stockfish binary in the image, driven over UCI | Chosen over WASM. Adds a pinned per-architecture binary, a licence-gate blind spot and a local install requirement for developers. All three are answered in §12 |
| E5 | How is strength selected? | Four named levels — Beginner, Casual, Club, Strong — with no rating numbers shown | Chosen over a numeric ladder. Names make no measurement claim the project cannot back, and because the lower rungs use `Skill Level` the ladder no longer depends on the unverified `UCI_Elo` floor. The cost: a player cannot tell how strong a level is except by playing it (§7) |
| E6 | Should weak levels use blunder injection? | No. Stockfish's own options only, kept simple | `Skill Level` is native, so the Beginner rung does not need it. What it forecloses is anything weaker than `Skill Level 0`, which is still not a true beginner opponent (§7, §14). Reversible later: §4.2 records what adding it would take |
| E7 | What happens when the engine returns an illegal move? | Play a random legal move and continue the game. Do not abort. This is error recovery, not E6 blunder injection: it fires only on a defect, never as a strength mechanism | A silent failure mode: a bug in our UCI parsing would quietly become random moves. Mitigated by mandatory logging and a zero-tolerance alert (§9, §10) |
| E8 | Should Stockfish be its own deployable? | No. It stays in-process behind §6.2's interface. If engine CPU ever needs isolating, run a second app of the same image with `ROLES=jobs` | Avoids a second deployable, an HTTP contract and a shared secret, and costs nothing while idle. Reversible in one file. The `ROLES=jobs` escape hatch is not free, though: it needs the `PgNotifyBus` upgrade first, or engine moves never reach the `api` container's SSE streams (§4.3) |

## 2. Scope

**In scope.** A user picks the bot and a level in the Mini App and gets a game immediately. The
engine answers each of the user's moves. The game is unrated, invisible to the group chat, visible
in the app, and never forfeits on the engine's side.

**One deliberate exception to "invisible to the group chat": Share position.** §8's rule is about
what the *system* posts on its own — cards, results, reminders — because the group has no stake in a
member playing a machine and PRD §3 goal 4 is a quiet chat. A share is not that: it is one tap by
the player, and PRD goal 4 already carves out "positions people choose to share". So
`send_share_photo` treats an engine game like any other, and nothing else about the game reaches the
chat.

**Out of scope.** Playing the engine outside a group. Rated engine games. Engine evaluation, hints
or analysis anywhere in the app, at any time — PRD §7.8 still holds, and this feature must not
become a back door to it. Strength calibration: the levels are configuration, not measurements (§7).
Anything weaker than Stockfish's own weakest setting (E6). Any change to how human games work.

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

Stockfish offers two native ways to play below full strength, and the ladder uses both.
`UCI_LimitStrength` with `UCI_Elo` covers 1350–2850 on the packaged build (§13; this paragraph first
guessed 1320–3190, which was wrong at both ends and cost the ladder nothing) and is
calibrated against engines. Below that floor there is `Skill Level`, 0–20, which degrades play by
making the engine choose worse moves rather than merely think less.

**A numeric ladder was considered first and rejected.** Labelling rungs 1400, 1600 and so on puts a
measurement in the UI that this project never takes, and because engine games are unrated (E3)
nothing in the product can ever check it. It also made the ladder's first rung depend on the exact
`UCI_Elo` floor, an unverified fact (§13): if the packaged build floors above 1400, a numeric ladder
loses a rung. Named levels have neither problem.

**Blunder injection is not needed and not used.** Because `Skill Level` is a native option, the
Beginner rung needs no move replacement, so E6 costs the ladder nothing at the bottom. What E6
forecloses is only play weaker than `Skill Level 0` — which is still not a beginner-strength
opponent (§14). Reversing it later means adding a probability per level and selecting from
`legalDests`, which `@group-chess/shared` already exports; the mapping from blunder rate to strength
would be invented rather than measured, and §7's honesty requirement would apply to it.

### 4.3 The engine as a separate deployable (decision E8)

**Considered:** a second Dokploy application wrapping Stockfish behind an HTTP endpoint (`fen` plus
level in, `uci` out), with the server calling it instead of spawning a process.

**Rejected, because it adds parts rather than removing them:** a second Dockerfile and deployable, an
HTTP contract, a shared secret so the endpoint is not open to anyone, inter-app network
configuration, a second health check and deploy pipeline, version skew between the two, and a new
failure mode — service unreachable — layered on §9's. Stockfish must still be installed into *some*
image, so §12's apt line relocates rather than simplifies. Behind §6.2's interface, `spawn()` is less
code than an authenticated HTTP client, and a separate service means a container running around the
clock for a workload that costs nothing while nobody is playing.

**What it would genuinely buy:** a smaller main image, independently scalable engine capacity, and the
option of a pre-built Stockfish image instead of an apt line. None of those pays for itself at this
project's scale.

**If engine CPU must be isolated from the web-facing process, the existing role split gets most of
the way — but not for free, and v0.3 of this section was wrong to imply otherwise.**
[docs/operations.md](../../operations.md) records that roles can be split across containers and that
the job worker is safe to run in several instances (`SELECT … FOR UPDATE SKIP LOCKED`). A second
Dokploy app running the same image with `ROLES=jobs` does isolate engine load from `api`. Three
constraints apply, and the second is the one this feature creates:

1. The union of `ROLES` across the apps must still cover all four, or a role silently stops — drop
   `clock` and nothing ever forfeits.
2. **`Bus` is `LocalBus`, in-process** (`apps/server/src/bus/bus.ts`). An engine move committed in
   the `jobs` container publishes only there, so no SSE stream held by the `api` container hears it:
   open boards stop live-updating and only catch up when a client refetches. The trap pre-dates the
   engine — a `clock` split forfeits the same way — but the engine makes it the common case, because
   *every* bot move arrives via a job. **A role split therefore needs the `PgNotifyBus` upgrade named
   above first**; until then, run all four roles in one container.
3. `engine_available` is set only under `has('jobs')` (`main.ts`), so an api-only container reports
   `0` for ever — which is exactly the condition operations.md tells an operator to alert on. Scope
   that alert to the container that owns the `jobs` role.

[docs/deploy-dokploy.md](../../deploy-dokploy.md)'s "keep the replica count at 1" is about the
in-process event bus and rate limiter in `api`, and points at the same missing piece.

**Cost to reverse: low.** §6.2's interface means `uciEngine` becomes `httpEngine` in one file, and
nothing above the seam changes.

## 5. Data model

One nullable column and one row. No new tables.

- `games.engine_level text null`, one of `beginner`, `casual`, `club`, `strong`. Non-null marks an
  engine game and records the level played. A text enum matches the existing convention for `status`,
  `result` and `end_reason`, keeps the database self-describing, and feeds the PGN name directly.
- `challenges` is untouched: engine games never create a challenge (§6.1).
- One `users` row for the engine, with `telegram_user_id = null`. This shape is already supported
  throughout: delete-my-data produces it (`domain/account.ts`), the DM handler skips such users
  (`jobs/handlers/telegram.ts`), cards render them as plain text with no mention entity
  (`telegram/cards.ts`), and `membership.verify` — which returns false for a null id — is only ever
  called on the authenticated caller, never on an opponent. The engine therefore triggers no Telegram
  API call.
- The engine row gets a `group_members` row per group where it is used, so existing queries treat it
  as present without special cases.

Display name: `Stockfish`, with the level appended where it is meaningful (`Stockfish (Club)` in PGN
headers). Naming it is also the honest thing to do for a GPL-3.0 dependency.

## 6. Architecture

### 6.1 Creating a game

Engine games skip the challenge entirely: there is nothing to accept, nothing to expire, and no card
to edit. A new endpoint `POST /api/groups/:groupId/engine-games` takes a level and a colour choice —
and deliberately **not** a time-per-move — and creates the game in one transaction with the same shape
as `acceptChallenge` minus the challenge row. It must force `rated = false` server-side rather than trusting the client (E3),
and must reject a level outside the table in §7. When the engine moves first, creation must also
apply §9's deadline rule, leaving `deadline_at` and `reminder_at` null.

Limits: none. Being blocked in the group is the only thing that stops a bot game starting. The two
caps this section originally leaned on — the group's `maxActiveGamesPerUser` and a two-game-per-pair
constant — were removed from the whole project on 2026-09-22, for a reason this feature exposed: a bot
game has no clock, so nothing ever ends an abandoned one, and a cap plus an immortal game is a
permanent lockout. Two forgotten bot games would have blocked a third for good and, because the
group-wide cap counted them, human challenges along with it. A player decides how many games they can
keep up with.

### 6.2 The engine seam

A new `apps/server/src/engine/` module. The engine sits behind an interface:

```
Engine = {
  bestMove(fen: string, level: Level, deadlineMs: number): Promise<{ uci: string } | { none: true }>
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

`playMove` gains one hook: after a committed human move, if `game.engineLevel !== null`, enqueue
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

Four levels, stored as `games.engine_level`. Each is a fixed set of UCI options; the move time is
the same for all four, and nothing else varies between them.

| Level | Mechanism |
|---|---|
| `beginner` | `Skill Level` at the bottom of its range |
| `casual` | A low `Skill Level` |
| `club` | `UCI_LimitStrength = true` with a mid `UCI_Elo` |
| `strong` | `UCI_LimitStrength = true` with a high `UCI_Elo` |

The two `Skill Level` values and the two `UCI_Elo` values are pinned in the implementation and are
**chosen, not measured**: no part of this project plays calibration matches.

**Move time does not vary by level.** Every level searches for `ENGINE_MOVETIME_MS` (default 200),
one deployment-wide setting, because §6.3 couples move time to the shared job worker: a per-level
budget would let one level delay every other job behind it, and at correspondence time controls the
difference would be invisible to the player anyway. Strength comes from the options in the table,
which is the whole of what a level is.

Three requirements, all binding:

1. **No rating numbers in user-facing copy.** Not on the level control, not on the game card, not in
   the game-end screen. A number would be a measurement claim, and because engine games are unrated
   (E3) nothing in the product could ever check it. The internal `UCI_Elo` values stay internal.
2. **No level may be presented as equivalent to a rating on the group's leaderboard.** The
   leaderboard measures play against humans and engine games never enter it (§8).
3. **`beginner` is a relative name, not a claim.** It is the weakest setting Stockfish offers
   natively, which is still well above a genuine beginner (§14). Copy must not promise otherwise —
   "the easiest level" is honest, "suitable for beginners" is not.

**Opening variety is not addressed.** Fixed options plus a fixed position make Stockfish largely
deterministic, so a given level will tend to repeat openings. `MultiPV 3` with a random pick over the
engine's first few moves was considered and cut to keep this simple. The cost is
repetitive openings at the higher levels; the fix is contained and can be added later.

## 8. Product surface

| Area | Requirement |
|---|---|
| Opponent picker | The bot is a distinct field in the picker DTO, not a `PlayerRef`, so it can never be mistaken for a human. Rendered as a pinned row plus a level list, following the existing time-per-move list pattern in `ui/screens/NewGame.tsx` |
| Rated switch | Forced off and disabled whenever the bot is selected, with copy explaining that engine games are unrated |
| Group chat | **No cards at all**, not even a result card. PRD §3 goal 4 is a quiet group chat and the group has no stake in a member playing a machine. The game remains in app history and spectatable by link, so "spectating by default" survives without spending group attention. The single exception is **Share position**, which the player chooses to tap and which PRD goal 4 already allows (§2) |
| Leaderboard and stats | Unrated already excludes engine games from Glicko-2. Additionally they are excluded from W/D/L, and the engine user never appears in the Players tab |
| Draw offers | There are none: the server refuses a draw offer in a bot game (`engine_game`) and the app dims Draw. Predictable, and keeps evaluation out of the draw path — which §2 requires anyway |
| Resign and abort | Unchanged. The human can resign or abort under the existing rules |
| Clocks | **A bot game has no clock at all.** `time_per_move` is null, so neither side ever carries a deadline and neither can be forfeited. The bot answers immediately, so a per-move clock measures nothing about it, and the only thing it could do is lose a casual game to inattention. The time control is therefore not offered in the picker once the bot is selected, and not accepted by the endpoint |
| Rematch | Creates a new engine game at the same level directly, not a challenge. Because engine games post no card (above), the affordance exists only on the game-end screen in the app; the card `rematch` callback is never reachable for them |
| Lichess import | **Skipped for engine games.** The quota is 100 imports per hour shared across the deployment, and unlimited engine games would drain it for games with no human opponent. The analysis-board fallback link and the PGN download both still work and need no quota, so the game-end screen keeps working |
| Move notifications | **None.** A bot game sends the human no turn DM and no reminder DM. The bot replies in seconds, so a "your turn" ping arrives for a move the player is already looking at, and a game they are playing alone does not need chasing. The game-end DM is kept: it reports a result, not a move, and without it a player who closed the app would never learn their game finished. With no clock in a bot game (see below) there is nothing a reminder could have warned about anyway |

## 9. Error handling and failure modes

**Neither side can lose on time, because a bot game has no clock.** `time_per_move` is null (§8), so
`deadlineExpression` and `reminderExpression` both return null for it through the ordinary code path,
and `forfeitOverdueGames` only considers games with a non-null `deadline_at` (`clock/scanners.ts`).
The scanner needs no change — no parsing side-to-move out of a FEN in SQL — and neither does
`playMove`, which asks nothing about the engine when it computes the clock columns.

An earlier revision reached the same guarantee differently, by nulling the clock columns whenever the
engine was the next mover. That guard was removed once bot games lost their time control: it was
redundant against a null clock, and two dead engine conditionals in the project's most critical
transaction cost more in reading than they bought. The consequence to know: the property now rests on
`time_per_move` being null, so **restoring a clock to bot games would also restore both the engine's
exposure to the forfeit scanner and the human's reminder DMs.** Anything reversing §8's no-clock rule
has to re-derive both.

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
  stores `engine_level`; an out-of-table level is rejected
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
production. Debian's package embeds the NNUE network — confirmed, §13 — so no net file has to be
installed or configured; the build assertion is what would have caught it had that gone the other
way. The binary lands in `/usr/games`, which is not on the default PATH in `node:22-bookworm-slim`,
so the runtime stage adds it.

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

## 13. Verified at implementation

All four questions were answered on 2026-09-22 by installing `stockfish=15.1-4` in
`node:22-bookworm-slim` and reading one UCI session's own output. Nothing here is asserted by a test:
it is Stockfish's behaviour, not this project's (§11).

- **The `UCI_Elo` range is 1350–2850** (`option name UCI_Elo type spin default 1350 min 1350 max
  2850`), not the 1320–3190 §4.2 assumed. The `club` (1600) and `strong` (2400) values both sit
  inside it, so nothing moves; a numeric ladder starting at 1400 would have been squeezed, which is
  exactly the risk named levels were chosen to avoid (E5)
- **`Skill Level`, `UCI_LimitStrength` and `UCI_Elo` are all honoured**, not silently ignored: the
  build declares `Skill Level type spin default 20 min 0 max 20` and `UCI_LimitStrength type check
  default false` alongside `UCI_Elo`, and a deliberately bogus fourth option sent in the same session
  came back as `No such option: Not_A_Real_Option` — which is what proves the session would have said
  so for a real one. `uciEngine` now watches for that line and logs a warning naming the option, so a
  future Stockfish that renames one degrades loudly instead of quietly making two levels play alike
- **The package is `15.1-4` (`id name Stockfish 15.1`) and the NNUE network is embedded**: `EvalFile`
  defaults to `nn-ad9b42354671.nnue` and the session logs `NNUE evaluation using
  nn-ad9b42354671.nnue enabled`, so no network file has to be installed or configured (§12)
- **Both architectures are covered**: `stockfish=15.1-4` installs and answers with a legal move on
  `linux/arm64` natively, and on `linux/amd64` under emulation — a native amd64 build has not been
  observed, though the image build gate would catch a failure

## 14. Known consequences, stated plainly

- **`beginner` is not beginner-strength.** It is the weakest setting Stockfish offers natively, which
  still plays well above a new player. A genuine beginner will lose every game on the easiest level
  (E5, E6). Reaching true beginner strength needs blunder injection (§4.2)
- **A player cannot tell how strong a level is without playing it**, since no numbers are shown (E5).
  This is the deliberate trade for not making a measurement claim the project cannot back
- **The level values are chosen, not measured.** No calibration matches are run, so the four rungs are
  ordered but not spaced by any known amount (§7)
- **Openings will repeat** at the higher levels (§7)
- **An illegal move recovers silently**, and only the log and the alert reveal it (E7, §9)
- **During an engine outage the picker still offers the bot**, and those games queue and then abort
  (§9)
- **Engine games get no permanent Lichess URL** (§8)
