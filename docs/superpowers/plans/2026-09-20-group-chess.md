# Group Chess Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Group Chess alpha (every P0 item in PRD §7) as designed in the technical design document: a TypeScript monorepo with a shared rules, rating and protocol package, one Node server process (bot, API, jobs, clock roles) on PostgreSQL 16, and a Preact Mini App with a chessground board.

**Architecture:** One pnpm workspace with `packages/shared` (chess.js arbiter, Glicko-2, PGN, zod protocol, i18n catalog), `apps/server` (grammY bot, Hono API with SSE, Drizzle on PostgreSQL, table-backed jobs outbox and clock scanners, in-process bus) and `apps/miniapp` (Preact + Vite, chessground behind an adapter). Dependencies point one way: `bot` and `api` call `domain`; `domain` calls `db`, `telegram`, `images`, `lichess` and `bus`. Every Telegram and Lichess side effect is a job; every time-based transition is a scanner over rows compared with database `now()`.

**Tech Stack:** Node 22 LTS, pnpm workspaces, TypeScript strict, vitest, Playwright, ESLint, Prettier; chess.js 1.4, zod 4; grammY 1.46 with `@grammyjs/transformer-throttler`, Hono 4 with `@hono/node-server` and `@hono/zod-validator`, Drizzle ORM with drizzle-kit on the `postgres` driver, pino, `@resvg/resvg-js`; Preact 10, Vite 8, chessground 9.

**Spec:** [docs/superpowers/specs/2026-09-20-group-chess-technical-design.md](../specs/2026-09-20-group-chess-technical-design.md) (Draft v0.2), which implements [docs/PRD.md](../../PRD.md) (Draft v0.2).

## How this plan is organised

The spec covers several subsystems, each of which produces working, testable software on its own, so (per the writing-plans scope check) it is split into one plan per subsystem. Execute them in this order; each plan's header repeats the Global Constraints that bind it and names the interfaces it consumes from the plans before it.

| # | Plan | Delivers | Tested by |
|---|---|---|---|
| 1 | [2026-09-20-group-chess-01-foundation.md](2026-09-20-group-chess-01-foundation.md) | Workspace, toolchain, CI skeleton, `packages/shared`: public ids, link payload codecs, error codes, DTO and request schemas, arbiter, PGN and Lichess links, clock math, Glicko-2, rating replay, i18n catalog | vitest unit tests |
| 2 | 2026-09-20-group-chess-02-server-core.md | `apps/server` skeleton: config, logging, Drizzle schema and migrations, public id generator, domain transactions (challenges, games, ratings, void rebuild), jobs outbox worker, clock scanners, local bus | vitest unit and integration tests on a real PostgreSQL |
| 3 | 2026-09-20-group-chess-03-server-telegram-api.md | Telegram outbound client and pacing, card renderer, grammY handlers and webhook, membership ladder, Hono API (launch auth, lobby, games, SSE, sharing, prefs, admin, delete-my-data), Lichess import, board images, DMs, metrics and health, static Mini App serving | vitest integration tests against a fake Bot API server |
| 4 | 2026-09-20-group-chess-04-miniapp.md | `apps/miniapp`: Telegram wrapper, API and SSE client, board adapter, move state machine, routes (groups, lobby, new game, game, replay, players, settings, group settings), theme, haptics, version fallbacks | vitest unit tests and Playwright end-to-end tests with a fake `window.Telegram.WebApp` |
| 5 | 2026-09-20-group-chess-05-delivery.md | Dockerfile, CI end-to-end and bundle-size jobs, release workflow, README, BotFather and deployment checklist | CI runs |

Plans 2 to 5 are written after the plan before them has been executed, so that they name the interfaces that actually exist.

## Global Constraints

Copied from the spec; every task in every sub-plan implicitly includes these.

- TypeScript end to end, `strict` on; Node 22 LTS pinned by `.nvmrc`; pnpm workspaces; ESLint and Prettier; vitest for unit and integration tests; Playwright for end-to-end tests (spec D1, §16).
- Rules engine: chess.js 1.4 on both client and server, with an in-house arbiter for fivefold repetition, the 75-move rule and claim logic; chess.js `isGameOver()` and `isDraw()` are never called (spec D6, §7.2).
- Public ids for games, groups and challenges: 10-character base62 strings matching `^[A-Za-z0-9]{10}$`, never the database primary key or a Telegram chat id (spec §5.3, §12).
- Start payload matches `^[A-Za-z0-9_-]{1,512}$` and takes the forms `g_<gameId>`, `l_<groupId>`, `s_<groupId>`; callback data (≤ 64 bytes) takes the forms `ch/acc/<challengeId>`, `ch/dec/<challengeId>`, `gm/rem/<gameId>` (spec §5.3).
- UCI moves match `^[a-h][1-8][a-h][1-8][qrbn]?$`; promotion is mandatory in the move input (five characters) (spec §7.2, §12).
- API error body is `{ "error": { "code", "message" } }` with codes `unauthorized`, `forbidden`, `not_found`, `stale_state`, `not_your_turn`, `illegal_move`, `expired`, `limit_exceeded`, `rate_limited`, `validation` (spec §9).
- Time per move `T` is one of 3600, 28800, 86400, 259200, 604800 seconds or null; after a move `deadline_at = now() + T` for the opponent and `reminder_at = deadline_at − 0.1·T` only when `T ≥ 28800` and the opponent has `dm_allowed` (spec §7.3).
- Arbiter outcome order: checkmate, stalemate, insufficient material, fivefold repetition (count of the new position's key across the initial position and every `fenAfter` ≥ 5), 75-move rule (halfmove clock ≥ 150); otherwise continue with claims `{ threefold: repetitions ≥ 3, fiftyMove: halfmove ≥ 100 }`. Position key = first four FEN fields as chess.js emits them (spec §7.2).
- Glicko-2 per group: start 1500, deviation 350, volatility 0.06, τ = 0.5, ε = 0.000001, deviation floor 45 and ceiling 350, scale 173.7178, provisional while deviation > 110; each rated result is its own period; inactivity `φ² ← min(φ² + d·σ², (350 / 173.7178)²)`; test vector 1500 / 200 / 0.06 against 1400 (30) win, 1550 (100) loss, 1700 (300) loss → 1464.06 / 151.52 / 0.05999 (spec §7.5).
- PGN headers: `Event "Group Chess"`, `Site` (group title), `Date` (game start, UTC), `White`, `Black`, `Result`, `WhiteElo`/`BlackElo` (rated games only), `TimeControl "-"`, `TimePerMove` in seconds, `Termination` from `end_reason`; fallback analysis link `https://lichess.org/analysis/pgn/<SAN moves joined by "_", URL-encoded>` (spec §7.6).
- Copy is short and chess-literate: SAN, `1-0`, `½-½`; emoji only as button icons; strings externalised with English at launch (PRD §8.4, spec §13).
- Licence allow-list: MIT, BSD, Apache-2.0, MPL-2.0, Unlicense, GPL-3.0-or-later (spec §12).
- Limits: 3 pending challenges per user per group; 5 active games per user per group (admin-configurable 1–20); 2 concurrent games per pair; challenge lifetime 24 h; 1 position share per user per minute; `/chess` and `/settings` once per group per minute; 120 API requests per user per minute; 4 open SSE streams per user; 1 draw offer per player per own move (spec §7.8).
- Message text from Telegram is never logged or stored; logs carry numeric ids and public ids only (spec §5.2, §12).

## Review Focus

Each sub-plan carries its own Review Focus list with the tests that pin the items to tasks. Across the whole product, the five conditions most likely to bite a person that no single sub-plan owns:

1. A move that arrives after the deadline must lose (or abort) inside the move transaction, never be accepted because the scanner had not run yet (plan 2).
2. Two people tapping Accept on the same open challenge within the same second must yield exactly one game and one private "Someone accepted first" toast (plan 3).
3. A Telegram 429 on a card edit must delay the edit, never drop it or duplicate it (plan 3).
4. A phone that backgrounds the Mini App for minutes must show the latest position on resume without a manual refresh (plan 4).
5. A deleted user must disappear from leaderboards and pickers while their opponents' histories stay intact (plan 3).
