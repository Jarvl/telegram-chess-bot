# Group Chess

A Telegram bot and Mini App for playing correspondence chess inside group chats. People challenge each other with `/play` or from the app, play on a real board inside Telegram (drag and drop or tap-tap), and the group sees only cards, results and shared positions. Rules and clocks are enforced on the server; every finished game gets a Lichess analysis link.

- Product requirements: [docs/PRD.md](docs/PRD.md)
- Technical design: [docs/superpowers/specs/2026-09-20-group-chess-technical-design.md](docs/superpowers/specs/2026-09-20-group-chess-technical-design.md)
- Implementation plans: [docs/superpowers/plans/2026-09-20-group-chess.md](docs/superpowers/plans/2026-09-20-group-chess.md)
- Setting it up in Telegram to try it: [docs/running.md](docs/running.md)
- Self-hosting it on Dokploy: [docs/deploy-dokploy.md](docs/deploy-dokploy.md)
- Deploying and running it: [docs/operations.md](docs/operations.md)
- How it is tested, and what is left before alpha: [docs/testing.md](docs/testing.md)

## Layout

| Path              | What it is                                                                                                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared` | Rules (chess.js + arbiter), Glicko-2, PGN, the zod protocol, the English message catalog                                                                                |
| `apps/server`     | One Node process with four roles (`api`, `bot`, `jobs`, `clock`): grammY bot, Hono API with SSE, Drizzle on PostgreSQL 18, a table-backed job outbox and clock scanners |
| `apps/miniapp`    | The Preact + chessground Mini App, built with Vite and served by the server under `/app/`                                                                               |
| `scripts`         | Local PostgreSQL, piece vendoring, bundle-budget, licence and engine-liveness gates                                                                                     |

## Requirements

- Node 22 (`.nvmrc`), pnpm 10 (`corepack enable`)
- PostgreSQL 18 for integration and end-to-end tests (`scripts/local-postgres.sh start` runs one on port 54329 when `initdb` is available, or use Docker: `docker compose up db`)
- A Telegram bot token from BotFather for a real deployment

## Quick start

```bash
pnpm install
cp .env.example .env            # fill in BOT_TOKEN, BOT_USERNAME, MINI_APP_SHORT_NAME, PUBLIC_URL, secrets
scripts/local-postgres.sh start  # creates group_chess and group_chess_test on :54329 and prints both URLs
export DATABASE_URL=postgres://postgres@127.0.0.1:54329/group_chess
# or: docker compose up -d db  →  DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/group_chess
pnpm dev:server                  # migrations run at boot; the bot long-polls when TELEGRAM_POLLING=true
pnpm dev:app                     # Vite on :5173, proxying /api to :3000
```

Telegram must load the Mini App over public HTTPS: point BotFather's app URL at a tunnel (for example cloudflared) that forwards to the Vite dev server or to the server with `MINI_APP_DIR=apps/miniapp/dist` after `pnpm build`.

## Checks

```bash
pnpm lint && pnpm format:check && pnpm typecheck
export TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54329/group_chess_test
pnpm test                        # unit + integration (PostgreSQL); without TEST_DATABASE_URL only unit tests run
pnpm build && pnpm check:budget  # Mini App bundle inside the §6.5 budget
pnpm check:licences              # every dependency inside the licence allow-list
pnpm e2e                         # builds the app and runs Playwright against the real server + a fake Bot API
```

The end-to-end suite needs Chromium: `pnpm --filter @group-chess/miniapp exec playwright install chromium`, or point `PLAYWRIGHT_CHROMIUM_PATH` at an existing binary.

## Configuration

Everything is an environment variable, validated at boot (`apps/server/src/config.ts`).

| Variable              | Required | Meaning                                                                                                  |
| --------------------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `BOT_TOKEN`           | yes      | From BotFather                                                                                           |
| `BOT_USERNAME`        | yes      | Without `@`; used in direct links                                                                        |
| `MINI_APP_SHORT_NAME` | yes      | The `/newapp` short name; links are `https://t.me/<BOT_USERNAME>/<MINI_APP_SHORT_NAME>?startapp=…`       |
| `PUBLIC_URL`          | yes      | HTTPS origin of this server; the webhook is `<PUBLIC_URL>/telegram/webhook`, the app `<PUBLIC_URL>/app/` |
| `WEBHOOK_SECRET`      | yes      | ≥ 16 characters; sent by Telegram as `X-Telegram-Bot-Api-Secret-Token`                                   |
| `DATABASE_URL`        | yes      | PostgreSQL 18                                                                                            |
| `SESSION_SECRET`      | yes      | ≥ 32 characters; signs the Mini App session tokens (rotating it logs everyone out)                       |
| `LICHESS_TOKEN`       | no       | Raises the import quota from 100 to 200 per hour                                                         |
| `ROLES`               | no       | `api,bot,jobs,clock` (default all)                                                                       |
| `LOG_LEVEL`           | no       | `info`                                                                                                   |
| `PORT`                | no       | `3000`                                                                                                   |
| `TELEGRAM_POLLING`    | no       | `true` for long polling in development (no public URL needed for the bot)                                |
| `TELEGRAM_API_ROOT`   | no       | A local Bot API server or a test fake                                                                    |
| `LICHESS_API_URL`     | no       | `https://lichess.org`                                                                                    |
| `MINI_APP_DIR`        | no       | Directory of the built Mini App to serve under `/app/` (the Docker image presets it)                     |
| `ENGINE_ENABLED`      | no       | `true`; the bot opponent. `false` lets a machine without Stockfish boot with nothing else changed        |
| `ENGINE_PATH`         | no       | `stockfish`, resolved on `PATH`; or a path to the binary                                                 |
| `ENGINE_MOVETIME_MS`  | no       | `200`; the bot opponent's per-move thinking budget                                                       |

## Deployment in one paragraph

Build the image (`docker build -t group-chess .` or take `ghcr.io/<owner>/<repo>:<version>` from a release), run it with the variables above and a PostgreSQL 18 database, put an HTTPS reverse proxy in front that does not buffer `/api/games/*/events`, register the Mini App in BotFather with `<PUBLIC_URL>/app/`, and open the bot. Migrations, the webhook and the command menu are set up by the server at boot. The full checklist, the metrics and the alerts are in [docs/operations.md](docs/operations.md).

## Licence

GPL-3.0-or-later (see `LICENSE`): the board is [chessground](https://github.com/lichess-org/chessground). The chess piece glyphs are the cburnett set by Colin M.L. Burnett, CC BY-SA 3.0 (`apps/server/src/images/ATTRIBUTION.md`). Every dependency is checked against the allow-list in `scripts/check-licences.mjs`.
